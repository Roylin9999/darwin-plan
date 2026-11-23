/* 達爾文豪宅計劃 — Cloudflare Pages Functions
 * 路由：
 *   GET  /api/ping           是否有後端
 *   GET  /api/state          讀取紀錄（需通關碼）
 *   PUT  /api/state          儲存紀錄（需通關碼）
 *   POST /api/ai             達爾文 AI 回應，轉呼叫 MiniMax（需通關碼）
 *   POST /api/line/test      立刻推一則提醒到 LINE（需通關碼）
 *   POST /api/line/webhook   LINE 官方帳號的 Webhook
 *   GET  /api/cron?key=...   定時提醒，由 cron-worker 每 30 分鐘呼叫
 *
 * 需要的綁定與密鑰（Pages → 設定）：
 *   DB                        D1 資料庫綁定
 *   ACCESS_CODE               通關碼（自己訂）
 *   CRON_KEY                  cron-worker 呼叫用的鑰匙（自己訂）
 *   LINE_CHANNEL_SECRET       LINE Messaging API 的 Channel secret
 *   LINE_CHANNEL_ACCESS_TOKEN LINE Messaging API 的 Channel access token
 *   MINIMAX_API_KEY           MiniMax 金鑰
 *   MINIMAX_BASE_URL          選填，預設 https://api.minimax.cn/v1
 *   MINIMAX_MODEL             選填，預設 MiniMax-M3
 *   SITE_URL                  選填，日誌網址，會附在提醒訊息最後
 */

const PERSONA = '你是達爾文，一隻棕白虎斑貓，是使用者最愛的貓。用繁體中文、溫暖俏皮的口吻，先具體稱讚使用者剛完成的事，再給一個今天就能做的小建議。兩到三句話，不說教，不用條列。';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/* ---------- D1 ---------- */
async function kvGet(env, k) {
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return row ? row.v : null;
}
async function kvSet(env, k, v) {
  await env.DB.prepare('INSERT INTO kv (k, v, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated')
    .bind(k, v, Date.now()).run();
}
async function loadState(env) {
  const raw = await kvGet(env, 'state');
  return raw ? JSON.parse(raw) : null;          // { data, updated }
}

/* ---------- 時間（台北） ---------- */
const pad = n => String(n).padStart(2, '0');
function taipeiNow() {
  const t = new Date(Date.now() + 8 * 3600e3);
  return {
    key: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    slot: `${pad(t.getUTCHours())}:${t.getUTCMinutes() < 30 ? '00' : '30'}`,
    weekday: t.getUTCDay(),                      // 0 = 週日
  };
}
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const md = k => `${+k.slice(5, 7)}/${+k.slice(8, 10)}`;

/* ---------- 提醒訊息 ---------- */
function buildMessage(S, kind, env) {
  const now = taipeiNow(), meta = S.meta || {}, name = meta.name || '';
  const weeks = meta.weeks || [], w = weeks.find(x => now.key >= x.s && now.key <= x.e);
  const tasks = (S.days && S.days[now.key] && S.days[now.key].tasks) || [];
  const done = tasks.filter(t => t.d), left = tasks.filter(t => !t.d);
  const dayNo = meta.start ? dayDiff(meta.start, now.key) + 1 : null;
  const daysLeft = meta.deadline ? Math.max(0, dayDiff(now.key, meta.deadline)) : null;
  const tail = (daysLeft !== null ? `\n距離 ${md(meta.deadline)} 還有 ${daysLeft} 天` : '') + (env.SITE_URL ? `\n\n打開日誌 ${env.SITE_URL}` : '');
  const list = a => a.map(t => '・' + t.t).join('\n');

  if (kind === 'am') {
    const head = `🐾 達爾文早安！\n${name}，今天是計劃第 ${dayNo} 天` + (w ? `（第 ${w.n} 週・${w.phase}）` : '');
    const body = tasks.length ? `今天要做的事：\n${list(left.length ? left : tasks)}` : '今天還沒寫任務，打開日誌填一件最小的事吧。';
    return `${head}\n\n${body}\n${w ? `\n本週里程碑：${w.target}` : ''}${tail}`;
  }
  if (kind === 'pm') {
    if (!tasks.length) return `🐾 達爾文晚安\n今天還沒有紀錄，睡前寫下一件明天要做的事就好。${tail}`;
    if (!left.length) return `🐾 達爾文晚安\n今天 ${tasks.length} 件事全部完成！${name}太棒了，記得回日誌打卡分享。${tail}`;
    return `🐾 達爾文晚安\n今天完成 ${done.length} / ${tasks.length}，還有：\n${list(left)}\n\n做完記得回日誌蓋貓掌。${tail}`;
  }
  if (kind === 'week' && w) {
    let all = 0, ok = 0;
    for (const k of Object.keys(S.days || {})) if (k >= w.s && k <= w.e) { const t = S.days[k].tasks || []; all += t.length; ok += t.filter(x => x.d).length; }
    const flags = (S.weeks && S.weeks[w.n]) || [], actsLeft = (w.acts || []).filter((_, i) => !flags[i]);
    const next = weeks.find(x => x.n === w.n + 1);
    return `🐾 第 ${w.n} 週回顧\n每日任務完成 ${ok} / ${all}\n` +
      (actsLeft.length ? `本週重點還沒勾的：\n${actsLeft.map(a => '・' + a).join('\n')}` : '本週重點全部完成！') +
      (next ? `\n\n下週（${next.phase}）里程碑：${next.target}` : '') + tail;
  }
  return '';
}

/* ---------- LINE ---------- */
async function lineCall(env, path, body) {
  const r = await fetch('https://api.line.me/v2/bot/message/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LINE ${path} ${r.status}: ${await r.text()}`);
}
const linePush = (env, to, texts) => lineCall(env, 'push', { to, messages: texts.filter(Boolean).slice(0, 5).map(text => ({ type: 'text', text })) });
const lineReply = (env, replyToken, text) => lineCall(env, 'reply', { replyToken, messages: [{ type: 'text', text }] });

async function verifyLine(env, raw, signature) {
  if (!env.LINE_CHANNEL_SECRET || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  let bin = ''; for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin) === signature;
}

async function lineWebhook(request, env) {
  const raw = await request.text();
  if (!(await verifyLine(env, raw, request.headers.get('x-line-signature')))) return json({ error: 'signature' }, 401);
  const events = (JSON.parse(raw).events) || [];
  for (const ev of events) {
    if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !ev.source || !ev.source.userId) continue;
    const text = ev.message.text.trim(), uid = ev.source.userId, bound = await kvGet(env, 'line_user');
    try {
      if (text.startsWith('綁定')) {
        if (env.ACCESS_CODE && text.replace('綁定', '').trim() === env.ACCESS_CODE) {
          await kvSet(env, 'line_user', uid);
          await lineReply(env, ev.replyToken, '🐾 綁定成功！之後我會在這裡提醒你每天的任務。\n輸入「今天」可以隨時看今天要做的事。');
        } else await lineReply(env, ev.replyToken, '通關碼不對喔。請輸入：綁定 加上你的通關碼。');
        continue;
      }
      if (uid !== bound) { await lineReply(env, ev.replyToken, '請先輸入：綁定 加上你的通關碼，我才知道你是誰。'); continue; }
      const st = await loadState(env), S = st && st.data;
      if (!S) { await lineReply(env, ev.replyToken, '還沒有紀錄，先打開日誌看看吧。' + (env.SITE_URL ? '\n' + env.SITE_URL : '')); continue; }
      if (/^(今天|任務|進度)/.test(text)) { await lineReply(env, ev.replyToken, buildMessage(S, 'am', env)); continue; }
      if (/^(本週|這週|回顧)/.test(text)) { await lineReply(env, ev.replyToken, buildMessage(S, 'week', env) || '這週沒有計劃內容。'); continue; }
      let reply = '';
      if (env.MINIMAX_API_KEY) {
        try { reply = await minimax(env, PERSONA, `使用者在 LINE 說：「${text}」\n今天的任務狀況：\n${buildMessage(S, 'pm', env)}`); } catch (e) { reply = ''; }
      }
      await lineReply(env, ev.replyToken, reply || '🐾 我在！輸入「今天」看今天的任務，輸入「本週」看這週回顧。');
    } catch (e) { console.log('line event error', e.message); }
  }
  return json({ ok: true });
}

/* ---------- MiniMax（OpenAI 相容的 chat/completions） ---------- */
async function minimax(env, system, user) {
  const base = (env.MINIMAX_BASE_URL || 'https://api.minimax.cn/v1').replace(/\/+$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.MINIMAX_API_KEY },
    body: JSON.stringify({
      model: env.MINIMAX_MODEL || 'MiniMax-M3',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 1000,
    }),
  });
  if (!r.ok) throw new Error(`MiniMax ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const EVENT_LABEL = { taskDone: '剛完成一件任務', taskAdd: '剛新增一件任務', bv: '剛登記今天新增的 BV', advice: '想要今天的建議', person: '剛在名單新增或更新一位聯絡人' };
async function aiReply(request, env) {
  if (!env.MINIMAX_API_KEY) return json({ reply: null });
  const b = await request.json();
  const user = `情境：${EVENT_LABEL[b.event] || b.event}\n細節：${JSON.stringify(b.detail || {})}\n目前進度：${JSON.stringify(b.state || {})}`;
  try { return json({ reply: await minimax(env, b.persona || PERSONA, user) }); }
  catch (e) { return json({ reply: null, error: e.message }); }
}

/* ---------- 定時提醒 ---------- */
async function runCron(env) {
  const st = await loadState(env), S = st && st.data, to = await kvGet(env, 'line_user'), now = taipeiNow();
  if (!S || !to) return { sent: 0, reason: !S ? 'no state' : 'no line user' };
  const L = S.line || {};
  if (!L.on) return { sent: 0, reason: 'off' };
  const kind = now.slot === L.am ? 'am' : now.slot === L.pm ? 'pm' : null;
  if (!kind) return { sent: 0, reason: 'not time', slot: now.slot };
  const mark = `sent:${now.key}:${kind}`;
  if (await kvGet(env, mark)) return { sent: 0, reason: 'already sent' };
  const texts = [buildMessage(S, kind, env)];
  if (kind === 'pm' && now.weekday === 0 && L.wk) texts.push(buildMessage(S, 'week', env));
  await linePush(env, to, texts);
  await kvSet(env, mark, '1');
  await env.DB.prepare("DELETE FROM kv WHERE k LIKE 'sent:%' AND updated < ?").bind(Date.now() - 3 * 864e5).run();
  return { sent: texts.filter(Boolean).length, kind };
}

/* ---------- 路由 ---------- */
export async function onRequest({ request, env, params }) {
  const path = [].concat(params.path || []).join('/'), method = request.method;
  try {
    if (path === 'ping') return json({ ok: true });
    if (path === 'line/webhook' && method === 'POST') return lineWebhook(request, env);
    if (path === 'cron') {
      const k = new URL(request.url).searchParams.get('key');
      if (!env.CRON_KEY || k !== env.CRON_KEY) return json({ error: 'key' }, 401);
      return json(await runCron(env));
    }
    if (!env.ACCESS_CODE || request.headers.get('x-code') !== env.ACCESS_CODE) return json({ error: 'code' }, 401);

    if (path === 'state' && method === 'GET') return json((await loadState(env)) || { data: null, updated: 0 });
    if (path === 'state' && method === 'PUT') {
      const raw = await request.text();
      if (raw.length > 900000) return json({ error: 'too large' }, 413);
      const b = JSON.parse(raw);
      if (!b || typeof b.data !== 'object') return json({ error: 'bad body' }, 400);
      await kvSet(env, 'state', JSON.stringify({ data: b.data, updated: +b.updated || Date.now() }));
      return json({ ok: true });
    }
    if (path === 'ai' && method === 'POST') return aiReply(request, env);
    if (path === 'line/test' && method === 'POST') {
      const st = await loadState(env), to = await kvGet(env, 'line_user');
      if (!to) return json({ ok: false, error: '還沒綁定 LINE：請在官方帳號輸入「綁定 通關碼」。' });
      if (!st || !st.data) return json({ ok: false, error: '雲端還沒有紀錄，先在日誌勾一件事再試。' });
      await linePush(env, to, [buildMessage(st.data, 'am', env)]);
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}
