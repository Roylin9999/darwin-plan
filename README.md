# 達爾文豪宅計劃 — 部署說明

架構：一個 Cloudflare Worker（網頁＋API＋定時提醒）＋ D1（紀錄）。
全部都可以在 Cloudflare 後台用滑鼠完成，不需要終端機。

```
public/                    網頁本體（index.html 和 img/）
src/worker.js              Worker 進入點
functions/api/[[path]].js  後端：同步、LINE Webhook、提醒、AI 中繼
wrangler.jsonc             Worker 設定（D1 繫結、每 30 分鐘的定時）
schema.sql                 D1 資料表
```

## 一、把整個資料夾放上 GitHub

建一個 repo（例如 `darwin-plan`），把這個資料夾的內容全部上傳。

## 二、建立 D1 資料庫

1. Cloudflare 後台 → 儲存和資料庫 → D1 → 建立資料庫，名稱 `darwin-db`。
2. 進入資料庫 → Console，執行：
   `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER NOT NULL);`
3. 複製這個資料庫的 ID，貼進 `wrangler.jsonc` 的 `database_id`。

## 三、建立 Worker 專案

1. Workers 和 Pages → 建立 → 連接 GitHub，選這個 repo。
2. 建置命令留空，部署命令維持 `npx wrangler deploy`，按 Deploy。

## 四、設定密鑰

進專案 → 設定 → 變數和密鑰，**類型都選「密鑰（Secret）」**
（選純文字的話，下次部署會被清掉）：

| 名稱 | 內容 |
|---|---|
| `ACCESS_CODE` | 通關碼，自己訂，告訴夥伴 |
| `LINE_CHANNEL_SECRET` | LINE Developers → Basic settings → Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers → Messaging API → Channel access token |
| `MINIMAX_API_KEY` | MiniMax 金鑰 |
| `MINIMAX_BASE_URL` | 選填。預設 `https://api.minimax.cn/v1`；連不上時改 `https://api.minimaxi.com/v1` |
| `MINIMAX_MODEL` | 選填。預設 `MiniMax-M3` |
| `SITE_URL` | 選填。你的網址，會附在提醒訊息最後 |

D1 繫結和定時提醒已經寫在 `wrangler.jsonc`，不用另外設定。

## 五、把 LINE 官方帳號接過來

1. LINE Developers → 你的 channel → Messaging API：
   - Webhook URL 填 `https://你的網址/api/line/webhook`，按 Verify。
   - 打開 Use webhook。
2. LINE Official Account Manager → 設定 → 回應設定：Webhook 開啟，自動回應訊息關閉。
3. 夥伴在官方帳號輸入：`綁定 通關碼`（例如 `綁定 meow123`），看到「綁定成功」就完成。

Webhook URL 換成新的網址後，舊的連結就自動失效，不需要另外刪除。

## 六、確認

- 打開網頁，輸入通關碼 → 頁尾顯示「紀錄已同步到雲端」。
- 提醒分頁按「傳一則測試訊息到 LINE」→ LINE 收到今天的任務。
- 在 LINE 輸入「今天」看今日任務、「本週」看週回顧；其他文字會由達爾文（MiniMax）回覆。

## 之後要改內容

計劃內容都在 `public/index.html` 最上方的 `CONFIG`：
週目標 `actions`、每日任務 `daily`、里程碑 `weekTarget`、Level Up 金額 `levelUp`、名單選項 `people`、打卡圖樣式 `share`。
改完推上 GitHub，Cloudflare 會自動重新部署。

## 注意

- 提醒時間是台北時間，只能設在整點或半點（每 30 分鐘檢查一次）。
- 目前設計是一位夥伴一個網站：一份紀錄、一個綁定的 LINE 使用者。
- 通關碼不要放進網址或公開的地方。
