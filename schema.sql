-- 達爾文豪宅計劃：D1 資料表（在 D1 的 Console 貼上執行一次）
CREATE TABLE IF NOT EXISTS kv (
  k       TEXT PRIMARY KEY,
  v       TEXT NOT NULL,
  updated INTEGER NOT NULL
);
