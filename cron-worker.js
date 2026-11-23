// 達爾文豪宅計劃 — 定時提醒用的小 Worker
// 在 Cloudflare 後台「建立 Worker」後，把這整份貼進編輯器並部署。
//
// 設定 → 變數與密鑰：
//   SITE_URL   你的 Pages 網址，例如 https://darwin-plan.pages.dev（結尾不要加斜線）
//   CRON_KEY   和 Pages 專案裡的 CRON_KEY 一樣
//
// 設定 → 觸發條件 → Cron 觸發程序，新增：  */30 * * * *   （每 30 分鐘一次）
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      fetch(`${env.SITE_URL}/api/cron?key=${encodeURIComponent(env.CRON_KEY)}`)
        .then(r => r.text()).then(t => console.log(t))
    );
  },
  async fetch() { return new Response('ok'); },
};
