// 達爾文豪宅計劃 — Worker 進入點（網頁、API、定時提醒都在這一個 Worker）
// /api/* 交給後端程式，其餘網址回傳 public/ 裡的網頁檔案。
import { onRequest, runCron } from '../functions/api/[[path]].js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return onRequest({ request, env, params: { path: url.pathname.slice(5).split('/').filter(Boolean) }, waitUntil: p => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },
  // 每 30 分鐘檢查一次要不要發 LINE 提醒（時間設定在 wrangler.jsonc 的 crons）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env).then(r => console.log(JSON.stringify(r))));
  },
};
