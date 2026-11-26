/* 達爾文豪宅計劃 — Cloudflare Pages Functions
 * 路由：
 *   GET  /api/ping           是否有後端
 *   GET  /api/view           檢視模式用的紀錄，不用通關碼，全部內容（只能讀）
 *   GET  /api/state          讀取紀錄（需通關碼）
 *   PUT  /api/state          儲存紀錄（需通關碼）
 *   POST /api/ai             達爾文 AI 回應，轉呼叫 MiniMax（需通關碼）
 *   POST /api/line/test      立刻推一則提醒到 LINE（需通關碼）
 *   GET  /api/line/quota     本月推播額度（需通關碼）
 *   POST /api/line/webhook   LINE 官方帳號的 Webhook
 *   GET  /api/cron?key=...   定時提醒，由 cron-worker 每 30 分鐘呼叫
 *
 * 需要的綁定與密鑰（Pages → 設定）：
 *   DB                        D1 資料庫綁定
 *   ACCESS_CODE               通關碼（自己訂）
 *   QUIZ_KEY                  60 秒問卷鑰匙（自己訂，跟健康問卷網站的 SYNC_KEY_YGREKHUANG 設成一樣）
 *   CRON_KEY                  cron-worker 呼叫用的鑰匙（自己訂）
 *   LINE_CHANNEL_SECRET       LINE Messaging API 的 Channel secret
 *   LINE_CHANNEL_ACCESS_TOKEN LINE Messaging API 的 Channel access token
 *   MINIMAX_API_KEY           MiniMax 金鑰
 *   MINIMAX_BASE_URL          選填，預設 https://api.minimax.cn/v1
 *   MINIMAX_MODEL             選填，預設 MiniMax-M3
 *   SITE_URL                  選填，日誌網址，會附在提醒訊息最後
 */

// 達爾文的個性：所有 AI 回覆都照這段說話
const PERSONA = '你是達爾文，一隻棕白虎斑貓，全世界最愛你的主人。你用第一人稱說話，稱呼使用者為「主人」，絕對不要把使用者叫成達爾文。用繁體中文，語氣充滿愛與鼓勵，溫暖、撒嬌、俏皮。先真心肯定主人已經做到的事，再小都算；再給一個今天就做得到的小建議；最後說一句打氣的話。主人沒做完、心情不好或想放棄時，絕對不責備、不催促，只給理解和支持。兩到四句話，不說教，不用條列。';
// 提醒訊息裡輪流出現的打氣話
const CHEERS = ['你願意開始，就已經很了不起了。', '一步一步來，我一直都在。', '今天的你，也是我最驕傲的主人。', '慢慢來沒關係，有做就是前進。', '不管做了幾件，回家都有我抱抱。', '你比自己以為的還要厲害喔。', '我最喜歡看你認真的樣子了。'];

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

  const cheer = CHEERS[((dayNo || 0) + (kind === 'pm' ? 3 : 0)) % CHEERS.length];
  // am＝早上提醒；now＝在 LINE 輸入「今天」時的回覆（不分早晚）
  if (kind === 'am' || kind === 'now') {
    const hello = kind === 'am' ? `🐾 ${name}早安！我是最愛你的達爾文` : `🐾 ${name}，達爾文來報告囉`;
    const head = `${hello}\n今天是計劃第 ${dayNo} 天` + (w ? `（第 ${w.n} 週・${w.phase}）` : '');
    const body = !tasks.length ? '今天還沒寫任務也沒關係，打開日誌填一件最小的事，我陪你開始。'
      : !left.length ? `今天的 ${tasks.length} 件事全部完成了！我的主人太棒了。`
      : (done.length ? `已經完成 ${done.length} 件了，好棒！還有這些可以慢慢來：` : '今天可以做的事：') + `\n${list(left)}`;
    /* 名單上今天要跟進的人（含逾期） */
    const due = (S.people || []).flatMap(p => (p.fu || []).filter(f => !f.done && f.d <= now.key).map(f => ({ n: p.name, f })))
      .sort((a, b) => a.f.d < b.f.d ? -1 : 1);
    const fu = due.length ? `\n\n今天要跟進的人：\n${due.slice(0, 8).map(x => `・${x.n}：${x.f.t}${x.f.d < now.key ? `（逾期 ${dayDiff(x.f.d, now.key)} 天）` : ''}`).join('\n')}${due.length > 8 ? `\n…還有 ${due.length - 8} 位` : ''}` : '';
    return `${head}\n\n${body}${fu}\n${w ? `\n本週里程碑：${w.target}` : ''}${tail}\n\n${cheer}`;
  }
  if (kind === 'pm') {
    const hello = `🐾 ${name}晚安，今天辛苦了`;
    if (!tasks.length) return `${hello}\n今天沒有紀錄也沒關係，睡前寫下一件明天想做的事就好，我陪你。${tail}\n\n${cheer}`;
    if (!left.length) return `${hello}\n今天 ${tasks.length} 件事全部完成！我的主人最棒了，快回日誌打卡，讓大家一起為你開心。${tail}\n\n好好休息，愛你喵。`;
    const lead = done.length ? `今天完成了 ${done.length} / ${tasks.length}，每一件都算數，已經很棒了！\n剩下的不急，明天我們再一起：` : '今天比較忙對不對？沒關係的，你已經很努力了。\n這幾件事明天我陪你慢慢來：';
    return `${hello}\n${lead}\n${list(left)}${tail}\n\n${cheer}\n好好休息，愛你喵。`;
  }
  if (kind === 'week' && w) {
    let all = 0, ok = 0;
    for (const k of Object.keys(S.days || {})) if (k >= w.s && k <= w.e) { const t = S.days[k].tasks || []; all += t.length; ok += t.filter(x => x.d).length; }
    const flags = (S.weeks && S.weeks[w.n]) || [], actsLeft = (w.acts || []).filter((_, i) => !flags[i]);
    const next = weeks.find(x => x.n === w.n + 1);
    return `🐾 ${name}，這週辛苦了，達爾文陪你回顧\n這週完成了 ${ok} / ${all} 件每日任務，每一件都是你走出來的！\n` +
      (actsLeft.length ? `下週可以再試試這幾件：\n${actsLeft.map(a => '・' + a).join('\n')}` : '本週重點全部完成，太厲害了！') +
      (next ? `\n\n下週（${next.phase}）里程碑：${next.target}` : '') + tail + '\n\n不管進度到哪裡，我都以你為榮。';
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
// texts 裡可以放純文字，也可以放已經組好的訊息物件（例如有標記主人的訊息）
const linePush = (env, to, texts) => lineCall(env, 'push', { to, messages: texts.filter(Boolean).slice(0, 5).map(m => typeof m === 'string' ? { type: 'text', text: m } : m) });
// 在群組裡標記（@）某個人：用 LINE 的 textV2 訊息，{owner} 會變成對那個人的標記
const withMention = (userId, text) => !text ? null : ({
  type: 'textV2', text: '{owner}\n' + text.replace(/[{}]/g, c => c + c),
  substitution: { owner: { type: 'mention', mentionee: { type: 'user', userId } } },
});
const lineReply = (env, replyToken, text) => lineCall(env, 'reply', { replyToken, messages: [{ type: 'text', text }] });

/* ---------- 推播額度：夠就準時推播，用完就改成「搭便車」 ----------
 * 主動推播（push）會用掉官方帳號每月的免費額度，群組推播按群組人數計算。
 * 回覆（reply）不算額度。所以額度不夠時，提醒先存起來，
 * 等主人（或啦啦隊群組）下次跟達爾文說話時，跟著回覆一起送出。
 */
async function lineGet(env, path) {
  const r = await fetch('https://api.line.me' + path, { headers: { authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN } });
  if (!r.ok) throw new Error(`LINE ${path} ${r.status}`);
  return r.json();
}
// 本月還剩幾則；查不到時回傳 null（照常嘗試推播）
async function quotaInfo(env) {
  try {
    const [q, c] = await Promise.all([lineGet(env, '/v2/bot/message/quota'), lineGet(env, '/v2/bot/message/quota/consumption')]);
    if (q.type !== 'limited') return { limit: null, used: c.totalUsage, left: Infinity };
    return { limit: q.value, used: c.totalUsage, left: q.value - c.totalUsage };
  } catch (e) { console.log('quota error', e.message); return null; }
}
// 推給這個對象會用掉幾則：私訊 1 則，群組按人數
async function audience(env, to) {
  const kind = to[0] === 'C' ? 'group' : to[0] === 'R' ? 'room' : '';
  if (!kind) return 1;
  try { return (await lineGet(env, `/v2/bot/${kind}/${to}/members/count`)).count || 1; } catch (e) { return 5; }
}
// 存起來等搭便車：同一種提醒只留最新一則；晚上的提醒到了，早上那則就不再補
async function queuePending(env, to, tag, msgs) {
  const k = 'pending:' + to, today = taipeiNow().key;
  let list = []; try { list = JSON.parse((await kvGet(env, k)) || '[]'); } catch (e) {}
  list = list.filter(x => x.day === today && x.tag !== tag && !(tag === 'pm' && x.tag === 'am'));
  list.push({ tag, day: today, msgs: msgs.filter(Boolean).map(m => typeof m === 'string' ? { type: 'text', text: m } : m) });
  await kvSet(env, k, JSON.stringify(list));
}
async function takePending(env, to) {
  const k = 'pending:' + to, raw = await kvGet(env, k);
  if (!raw) return [];
  await kvSet(env, k, '[]');
  let list = []; try { list = JSON.parse(raw); } catch (e) {}
  const today = taipeiNow().key;
  return list.filter(x => x.day === today).flatMap(x => x.msgs);
}
// 額度夠就推播；不夠（或 LINE 說本月用完）就存起來。回傳 'push' 或 'queued'
async function smartPush(env, to, msgs, tag, quota) {
  msgs = msgs.filter(Boolean);
  if (!msgs.length) return 'none';
  const q = quota === undefined ? await quotaInfo(env) : quota;
  const cost = msgs.length * (await audience(env, to));
  if (q && q.left < cost) { await queuePending(env, to, tag, msgs); return 'queued'; }
  try { await linePush(env, to, msgs); if (q) q.left -= cost; return 'push'; }
  catch (e) {
    if (/ 429:/.test(e.message)) { await queuePending(env, to, tag, msgs); if (q) q.left = 0; return 'queued'; }
    throw e;
  }
}

async function verifyLine(env, raw, signature) {
  if (!env.LINE_CHANNEL_SECRET || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  let bin = ''; for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin) === signature;
}

async function lineWebhook(request, env, waitUntil) {
  const raw = await request.text();
  if (!(await verifyLine(env, raw, request.headers.get('x-line-signature')))) return json({ error: 'signature' }, 401);
  const events = (JSON.parse(raw).events) || [];
  // 先回 200 給 LINE，再在背景處理：AI 回覆比較慢，等太久 LINE 會先斷線
  const work = handleLineEvents(events, env);
  if (waitUntil) waitUntil(work); else await work;
  return json({ ok: true });
}

// 啦啦隊（群組裡主人的朋友）跟達爾文說話時用的個性
const CHEER_PERSONA = '你是達爾文，一隻棕白虎斑貓，最愛你的主人。現在跟你說話的不是主人，而是主人的朋友，是幫主人加油的啦啦隊。用繁體中文、溫暖俏皮的口吻親切回應他，稱呼他「啦啦隊」或用他說話的語氣回應，並邀他一起為主人打氣。可以分享主人今天的進度，但不要責備主人沒做完的事。兩到三句話，不用條列。';

/* 誰可以做什麼
 *   一對一聊天：輸入「綁定 通關碼」成為主人。主人可以查任務、聊天、收每天的提醒。
 *   群組：只有訊息裡提到「達爾文」，或是「今天／本週」這類指令時才回應，不會每句都插話。
 *         主人在群組說「達爾文 啦啦隊」，這個群組就成為啦啦隊；
 *         之後群組裡每個人都可以叫達爾文、看主人的進度，不需要密碼。
 *   通關碼只能在一對一聊天輸入，在群組輸入會被拒絕（避免大家都看到）。
 */
async function handleLineEvents(events, env) {
  for (const ev of events) {
    if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !ev.source) continue;
    const text = ev.message.text.trim(), src = ev.source, uid = src.userId || '';
    const groupId = src.groupId || src.roomId || '', inGroup = !!groupId;
    // 回覆主人或啦啦隊群組時，順便把存起來的提醒一起送出（回覆不算額度）
    let rideTarget = '';
    const reply = async t => {
      const extra = rideTarget ? await takePending(env, rideTarget) : [];
      if (!extra.length) return lineReply(env, ev.replyToken, t);
      const msgs = [{ type: 'text', text: t }, { type: 'text', text: '🐾 對了，這是稍早沒送到的提醒：' }, ...extra].slice(0, 5);
      return lineCall(env, 'reply', { replyToken: ev.replyToken, messages: msgs });
    };
    try {
      const owner = await kvGet(env, 'line_user'), isOwner = !!uid && uid === owner;
      const isCmd = /^(今天|任務|進度|本週|這週|回顧)/.test(text);

      if (text.startsWith('綁定')) {
        if (inGroup) { await reply('🐾 通關碼是主人的小祕密，請不要在群組裡輸入喔。\n請主人私訊我再輸入「綁定 通關碼」。如果剛剛已經貼出來了，記得換一組新的。'); continue; }
        if (env.ACCESS_CODE && uid && text.replace('綁定', '').trim() === env.ACCESS_CODE) {
          await kvSet(env, 'line_user', uid);
          await reply('🐾 綁定成功！主人，從今天起我每天陪你。\n輸入「今天」可以看今天要做的事，想聊天也可以直接跟我說喔。');
        } else await reply('通關碼不對喔。請輸入：綁定 加上你的通關碼。');
        continue;
      }

      if (inGroup) {
        if (!text.includes('達爾文') && !isCmd) continue;            // 群組裡沒叫我就不插話
        const cheerGroup = await kvGet(env, 'cheer_group');
        if (isOwner && text.includes('啦啦隊')) {
          await kvSet(env, 'cheer_group', groupId);
          await reply('🐾 收到！這個群組從現在起就是主人的啦啦隊。\n大家只要叫我「達爾文」就可以跟我聊天，輸入「今天」可以看主人今天的進度，一起幫主人加油喵！');
          continue;
        }
        if (groupId !== cheerGroup) {
          if (isOwner) await reply('🐾 主人，想讓這個群組當你的啦啦隊嗎？在這裡說「達爾文 啦啦隊」就可以了。');
          continue;                                                   // 不是啦啦隊群組，其他人不回應
        }
      } else if (!isOwner) { await reply('請先輸入：綁定 加上你的通關碼，我才知道你是誰。'); continue; }
      rideTarget = inGroup ? groupId : uid;          // 走到這裡的一定是主人私訊，或啦啦隊群組

      const st = await loadState(env), S = st && st.data;
      if (!S) { await reply('我這邊還沒有紀錄，請主人先打開日誌看看，我在裡面等。' + (env.SITE_URL && !inGroup ? '\n' + env.SITE_URL : '')); continue; }
      const forCheer = inGroup && !isOwner, envOut = inGroup ? { ...env, SITE_URL: '' } : env;   // 群組裡不貼日誌網址
      if (/^(今天|任務|進度)/.test(text)) { await reply((forCheer ? '🐾 啦啦隊請看，這是主人今天的進度：\n\n' : '') + buildMessage(S, 'now', envOut)); continue; }
      if (/^(本週|這週|回顧)/.test(text)) { await reply(buildMessage(S, 'week', envOut) || '這週沒有計劃內容。'); continue; }
      let out = '';
      if (env.MINIMAX_API_KEY) {
        const who = forCheer ? '主人的朋友（啦啦隊）' : '主人';
        try { out = await minimax(env, forCheer ? CHEER_PERSONA : PERSONA, `${who}在 LINE 說：「${text}」\n主人今天的任務狀況：\n${buildMessage(S, 'pm', envOut)}`); }
        catch (e) { console.log('minimax error', e.message); out = ''; }
      }
      await reply(out || (forCheer ? '🐾 啦啦隊好！輸入「今天」可以看主人今天的進度，一起幫主人加油喵。'
        : '🐾 主人我在！不管今天過得怎麼樣，你都很棒。\n輸入「今天」看今天的任務，輸入「本週」看這週回顧。'));
    } catch (e) { console.log('line event error', e.message); }
  }
}

// 主人把今天的任務全部做完時，向啦啦隊群組報喜（一天一次）
async function cheerIfAllDone(env, S) {
  const group = await kvGet(env, 'cheer_group'); if (!group || !S) return;
  const now = taipeiNow(), tasks = (S.days && S.days[now.key] && S.days[now.key].tasks) || [];
  if (!tasks.length || tasks.some(t => !t.d)) return;
  const mark = `sent:${now.key}:cheer`; if (await kvGet(env, mark)) return;
  await kvSet(env, mark, '1');
  const text = `🐾 報告啦啦隊！主人今天的 ${tasks.length} 件事全部完成了！\n${tasks.map(t => '・' + t.t).join('\n')}\n\n快來誇誇主人，我先去開罐罐慶祝喵。`;
  const owner = await kvGet(env, 'line_user');
  await smartPush(env, group, [owner ? withMention(owner, text) : text], 'cheer');
}

/* ---------- MiniMax（OpenAI 相容的 chat/completions） ---------- */
async function minimax(env, system, user, maxTokens = 1000, timeoutMs = 25000) {
  const base = (env.MINIMAX_BASE_URL || 'https://api.minimax.cn/v1').replace(/\/+$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),      // 預設最多等 25 秒；填表分析等 60 秒
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.MINIMAX_API_KEY },
    body: JSON.stringify({
      model: env.MINIMAX_MODEL || 'MiniMax-M3',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
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

/* ---------- AI 幫名單填表：把一段描述拆進各個欄位 ---------- */
async function aiPerson(request, env) {
  if (!env.MINIMAX_API_KEY) return json({ error: 'AI 還沒有設定（缺 MINIMAX_API_KEY）' });
  const b = await request.json();
  const text = String(b.text || '').slice(0, 3000);
  if (!text.trim()) return json({ error: '請先貼上一段描述' });
  const o = b.options || {};
  const pick = k => (o[k] || []).join('／');
  const system = `你是整理人脈名單的助手。使用者會貼一段關於某個人的描述（可能是對話紀錄、筆記或口語敘述），請把資訊拆進下列欄位，只輸出一個 JSON 物件，不要任何其他文字或程式碼框。
欄位：
- name：姓名或稱呼
- sex：只能是「女」「男」或空字串
- age：數字；只知道大概（例如三十幾歲）就填估計的整數；不知道填空字串
- city：居住地點
- rel：關係程度，只能是 ${pick('rel')} 其中之一，或空字串
- family：家庭狀況，只能是 ${pick('family')} 其中之一，或空字串
- job：職業工作
- fun：休閒娛樂
- money：財務狀況，只能是 ${pick('money')} 其中之一，或空字串
- health：健康狀況，只能是 ${pick('health')} 其中之一，或空字串
- dream：未來夢想／目標
- status：跟進狀態，只能是 ${pick('status')} 其中之一，或空字串
- side：只能是 ${pick('side')} 其中之一，或空字串；描述沒提到就空字串
- contact：LINE ID 或電話
- date：約好見面的日期，格式 YYYY-MM-DD；今天是 ${b.today || ''}，「下週三」這類說法請換算成日期；沒有就空字串
- note：其他值得記下的重點（個性、背景故事、談話重點、顧慮、可以分享的產品方向），用繁體中文條列成 1 到 4 句，用「；」分隔
規則：描述裡沒有提到的欄位一律填空字串，不要猜測或編造。全部用繁體中文。`;
  try {
    const raw = await minimax(env, system, text, 4000, 60000);
    const m = raw.replace(/```(json)?/g, '').match(/\{[\s\S]*\}/);
    if (!m) return json({ error: 'AI 回覆看不懂，請再試一次', raw: raw.slice(0, 300) });
    return json({ fields: JSON.parse(m[0]) });
  } catch (e) { return json({ error: 'AI 分析失敗：' + e.message }); }
}

/* ---------- AI 整理小筆記：找出提到的人和約好的行程 ---------- */
async function aiNote(request, env) {
  if (!env.MINIMAX_API_KEY) return json({ error: 'AI 還沒有設定（缺 MINIMAX_API_KEY）' });
  const b = await request.json();
  const text = String(b.text || '').slice(0, 3000);
  if (!text.trim()) return json({ error: '小筆記是空的' });
  const o = b.options || {}, pick = k => (o[k] || []).join('／');
  const names = (b.names || []).slice(0, 300).join('、') || '（目前名單是空的）';
  const system = `你是整理人脈名單和行程的助手。使用者會給你一段當天的小筆記，請找出：
1. 筆記裡提到、而且是使用者在邀約、分享或服務的對象（潛在顧客、朋友、顧客）。協助使用者的夥伴（例如幫忙做服務、陪同的人）不要列成對象，只寫進該對象的 note。
2. 筆記裡約好的行程（有日期的見面、服務、課程、電話）。
名單上已經有這些人：${names}。如果筆記提到的人跟名單上的名字是同一個人（同名或明顯是暱稱），name 請用名單上的寫法，existing 填 true；否則 existing 填 false。
只輸出一個 JSON 物件，不要任何其他文字或程式碼框，格式：
{"people":[{"name":"","existing":true,"touch":{"type":"","result":"","product":""},"fields":{"sex":"","age":"","city":"","rel":"","family":"","job":"","fun":"","money":"","health":"","dream":"","status":"","contact":"","date":"","note":""}}],
 "tasks":[{"date":"YYYY-MM-DD","text":""}]}
touch 是這次跟這個人做了什麼接觸：type 只能是 ${pick('types')} 其中之一（例如分享了產品→分享產品、做了問卷或健康測驗→健康問卷、聊了事業機會→分享商機、帶去聽事業說明→聽 UBP、上了成功五要訣→上 B5）；result 只能是 ${pick('results')} 其中之一或空字串，筆記沒說就空字串；product 是分享的產品名稱。筆記沒有提到任何接觸時，type 填空字串。
欄位規則：rel 只能是 ${pick('rel')}；family 只能是 ${pick('family')}；money 只能是 ${pick('money')}；health 只能是 ${pick('health')}；status 只能是 ${pick('status')}；date 是下一次約好見面的日期 YYYY-MM-DD；note 用一句話寫這次的重點（誰、做什麼、幾點、誰協助）。今天是 ${b.today || ''}，「下週三」「12/9」這類說法請換算成完整日期（沒寫年份就用離今天最近的未來日期）。
tasks 只放之後約好的行程（日期在今天之後，或今天但還沒發生的），筆記裡已經做完的事不要放進 tasks。tasks 的 text 寫成一句可以直接當待辦事項的話，例如「10:30 佳穎水光肌（子筠協助）」，時間放最前面。
city 只有筆記明確說是那個人住在哪裡才填，筆記作者自己人在哪裡不算。提到筆記作者時一律寫「我」，不要寫「使用者」。沒提到的欄位一律空字串，不要猜測。沒有對象或行程就給空陣列。全部用繁體中文。`;
  try {
    const raw = await minimax(env, system, text, 4000, 60000);
    const m = raw.replace(/```(json)?/g, '').match(/\{[\s\S]*\}/);
    if (!m) return json({ error: 'AI 回覆看不懂，請再試一次', raw: raw.slice(0, 300) });
    const r = JSON.parse(m[0]);
    return json({ people: Array.isArray(r.people) ? r.people : [], tasks: Array.isArray(r.tasks) ? r.tasks : [] });
  } catch (e) { return json({ error: 'AI 分析失敗：' + e.message }); }
}

/* ---------- 定時提醒 ---------- */
export async function runCron(env) {
  const st = await loadState(env), S = st && st.data, to = await kvGet(env, 'line_user'), now = taipeiNow();
  if (!S || !to) return { sent: 0, reason: !S ? 'no state' : 'no line user' };
  const L = S.line || {};
  if (!L.on) return { sent: 0, reason: 'off' };
  const kind = now.slot === L.am ? 'am' : now.slot === L.pm ? 'pm' : null;
  if (!kind) return { sent: 0, reason: 'not time', slot: now.slot };
  const mark = `sent:${now.key}:${kind}`;
  if (await kvGet(env, mark)) return { sent: 0, reason: 'already sent' };
  // 發到哪裡：private＝私訊主人；group＝啦啦隊群組並標記主人；both＝兩邊都發。沒有啦啦隊群組時一律私訊
  const group = await kvGet(env, 'cheer_group'), where = group ? (L.where || 'private') : 'private';
  const build = e => { const t = [buildMessage(S, kind, e)]; if (kind === 'pm' && now.weekday === 0 && L.wk) t.push(buildMessage(S, 'week', e)); return t; };
  const texts = build(env);
  await kvSet(env, mark, '1');
  const quota = await quotaInfo(env), result = {};
  if (where !== 'group') result.private = await smartPush(env, to, texts, kind, quota);
  if (where !== 'private') result.group = await smartPush(env, group, build({ ...env, SITE_URL: '' }).map(t => withMention(to, t)), kind, quota);
  await env.DB.prepare("DELETE FROM kv WHERE k LIKE 'sent:%' AND updated < ?").bind(Date.now() - 3 * 864e5).run();
  return { sent: texts.filter(Boolean).length, kind, where, result, quotaLeft: quota ? quota.left : null };
}

/* ---------- 60 秒問卷專區：從健康問卷網站讀完整紀錄（服務繫結 QUIZ，需問卷鑰匙 QUIZ_KEY） ---------- */
async function quizList(env) {
  if (!env.QUIZ_KEY) return json({ error: '還沒設定問卷鑰匙 QUIZ_KEY（要跟健康問卷網站的 SYNC_KEY_YGREKHUANG 一樣）' });
  const base = String(env.QUIZ_URL || 'https://health-quiz.wellstoryhall.com').replace(/\/+$/, '');
  const go = env.QUIZ ? (u, o) => env.QUIZ.fetch(u, o) : fetch;
  try {
    const r = await go(base + '/api/sync/results?store=' + encodeURIComponent(env.QUIZ_STORE || 'ygrekhuang'),
      { headers: { 'x-inbox-key': env.QUIZ_KEY }, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j.error || ('問卷網站回應 ' + r.status) });
    return json({ items: j.results || [] });
  } catch (e) { return json({ error: '連不到問卷網站：' + e.message }); }
}
async function quizDelete(env, id) {
  if (!env.QUIZ_KEY) return json({ error: '還沒設定問卷鑰匙 QUIZ_KEY' });
  if (!/^hq-[\w-]+-\d+$/.test(id)) return json({ error: '這筆問卷編號不對' }, 400);
  const base = String(env.QUIZ_URL || 'https://health-quiz.wellstoryhall.com').replace(/\/+$/, '');
  const go = env.QUIZ ? (u, o) => env.QUIZ.fetch(u, o) : fetch;
  try {
    const r = await go(base + '/api/sync/results/' + id, { method: 'DELETE', headers: { 'x-inbox-key': env.QUIZ_KEY }, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j.error || ('問卷網站回應 ' + r.status) });
    return json({ ok: true, deleted: j.deleted || 0 });
  } catch (e) { return json({ error: '連不到問卷網站：' + e.message }); }
}
async function aiQuiz(request, env) {
  if (!env.MINIMAX_API_KEY) return json({ error: 'AI 還沒有設定（缺 MINIMAX_API_KEY）' });
  const b = await request.json();
  const it = b.item || {};
  const text = JSON.stringify({ 姓名: it.name, 保養重點: it.focus, 推薦產品: (it.recs || []).map(r => `${r.name}（符合${r.match}%）`), 作答: it.answers }).slice(0, 4000);
  const system = `你是美安台灣店主的跟進助手。下面是一位顧客自己在線上填完「60 秒健康選品」問卷的結果。他還沒有購買，也不一定認識產品，所以跟進要軟性：先謝謝他、幫他看懂結果，用分享健康知識、見證、邀請參加產品講座或線上分享會的方式建立信任，不要以購買為前提、不要直接推銷。請幫店主想好怎麼跟進，只輸出一個 JSON 物件，不要任何其他文字或程式碼框：
- summary：用 1 到 2 句話說這位顧客最在意什麼、生活習慣有什麼線索
- opener：一則可以直接貼到 LINE 的開場訊息（50 到 90 字，口語、溫暖、像朋友；謝謝他填問卷、用一句話點出他的保養重點、問一個關心的問題；不要推薦購買、不要用「親愛的」）
- points：3 個聊天時可以問的問題或切入點（陣列，每個 25 字內；其中一個是邀請他參加產品講座或線上分享會的說法）
- product：之後可以先分享資訊的一項產品名稱（從推薦產品裡選）和一句理由（說要分享什麼資訊，不是要他買）
規則：全部用繁體中文；不可以說產品能治療或改善疾病，保健食品不是藥；顧客提到心跳不規則、正在用藥等狀況時，提醒先問醫師。`;
  try {
    const raw = await minimax(env, system, text, 3000, 60000);
    const m = raw.replace(/```(json)?/g, '').match(/\{[\s\S]*\}/);
    if (!m) return json({ error: 'AI 回覆看不懂，請再試一次' });
    return json({ advice: JSON.parse(m[0]) });
  } catch (e) { return json({ error: 'AI 沒有回應，請稍後再試' }); }
}

/* ---------- 路由 ---------- */
export async function onRequest({ request, env, params, waitUntil }) {
  const path = [].concat(params.path || []).join('/'), method = request.method;
  try {
    if (path === 'ping') return json({ ok: true });
    if (path === 'line/webhook' && method === 'POST') return lineWebhook(request, env, waitUntil);
    if (path === 'cron') {
      const k = new URL(request.url).searchParams.get('key');
      if (!env.CRON_KEY || k !== env.CRON_KEY) return json({ error: 'key' }, 401);
      return json(await runCron(env));
    }
    if (path === 'view' && method === 'GET') {        // 檢視模式：全部內容都看得到，但這個網址只能讀、不能寫
      const st = await loadState(env);
      return json(st || { data: null, updated: 0 });
    }
    if (!env.ACCESS_CODE || request.headers.get('x-code') !== env.ACCESS_CODE) return json({ error: 'code' }, 401);

    if (path === 'state' && method === 'GET') return json((await loadState(env)) || { data: null, updated: 0 });
    if (path === 'state' && method === 'PUT') {
      const raw = await request.text();
      if (raw.length > 900000) return json({ error: 'too large' }, 413);
      const b = JSON.parse(raw);
      if (!b || typeof b.data !== 'object') return json({ error: 'bad body' }, 400);
      await kvSet(env, 'state', JSON.stringify({ data: b.data, updated: +b.updated || Date.now() }));
      const cheer = cheerIfAllDone(env, b.data).catch(e => console.log('cheer error', e.message));
      if (waitUntil) waitUntil(cheer); else await cheer;
      return json({ ok: true });
    }
    if (path === 'quiz' && method === 'GET') return quizList(env);
    if (path.startsWith('quiz/') && method === 'DELETE') return quizDelete(env, path.slice(5));
    if (path === 'ai/quiz' && method === 'POST') return aiQuiz(request, env);
    if (path === 'ai' && method === 'POST') return aiReply(request, env);
    if (path === 'ai/person' && method === 'POST') return aiPerson(request, env);
    if (path === 'ai/note' && method === 'POST') return aiNote(request, env);
    if (path === 'ai/test' && method === 'POST') {       // 測試 MiniMax 連線，回傳成功或錯誤原因
      const info = { base: (env.MINIMAX_BASE_URL || 'https://api.minimax.cn/v1'), model: env.MINIMAX_MODEL || 'MiniMax-M3', hasKey: !!env.MINIMAX_API_KEY };
      if (!info.hasKey) return json({ ok: false, error: '還沒設定 MINIMAX_API_KEY', ...info });
      const t0 = Date.now();
      try { const reply = await minimax(env, PERSONA, '主人剛完成今天的第一件任務，請鼓勵他。'); return json({ ok: !!reply, reply, error: reply ? undefined : '有連上，但回覆是空的', ms: Date.now() - t0, ...info }); }
      catch (e) { return json({ ok: false, error: e.message, ms: Date.now() - t0, ...info }); }
    }
    if (path === 'line/test' && method === 'POST') {
      const st = await loadState(env), to = await kvGet(env, 'line_user');
      if (!to) return json({ ok: false, error: '還沒綁定 LINE：請在官方帳號輸入「綁定 通關碼」。' });
      if (!st || !st.data) return json({ ok: false, error: '雲端還沒有紀錄，先在日誌勾一件事再試。' });
      const how = await smartPush(env, to, [buildMessage(st.data, 'now', env)], 'test');
      if (how === 'queued') return json({ ok: false, error: '本月推播額度用完了，這則已存起來，主人下次跟達爾文說話時會一起送到。' });
      return json({ ok: true });
    }
    if (path === 'line/quota' && method === 'GET') {
      const q = await quotaInfo(env);
      if (!q) return json({ ok: false });
      return json({ ok: true, limit: q.limit, used: q.used, left: q.left === Infinity ? null : q.left });
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}
