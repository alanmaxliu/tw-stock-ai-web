# 台股即時技術分析網頁

純前端台股分析工具。GitHub Actions 會定時產生熱門 40 檔清單與日線 JSON；使用者也可以直接輸入任意台股代號。若設定 Cloudflare Worker，前端會優先套用 Worker 回傳的最新報價，再依均線、RSI、MACD、波動率與價格位置產生分析結果、PNG 圖表與 Markdown 報告。

## 功能

- 熱門清單：上市 ETF 成交金額前 20、上市個股成交金額前 20。
- 前端會先讀 `data/universe.json` 作為熱門提示。
- 可輸入任意台股代號；非熱門 40 檔會走 Worker、Yahoo 或 TWSE 備援資料。
- 畫面主題跟隨系統設定。
- 可下載分析報告與 PNG 圖表。

## Cloudflare Worker 即時報價

GitHub Pages 是靜態網站，前端直接抓 TWSE MIS 會受瀏覽器 CORS 限制。若要讓使用者輸入任意股票代號後取得較新的盤中或最後報價，建議部署 `worker/stock-worker.js` 到 Cloudflare Workers。

設定步驟：

1. 註冊或登入 Cloudflare。
2. 安裝 Node.js。
3. 在本機執行 `npm create cloudflare@latest` 或安裝 Wrangler。
4. 進入 `worker` 資料夾。
5. 將 `wrangler.toml.example` 複製成 `wrangler.toml`。
6. 執行 `npx wrangler login`。
7. 執行 `npx wrangler deploy`。
8. 複製部署後的 `https://你的名稱.你的帳號.workers.dev`。
9. 回到 `app.js`，把 `workerApiBase` 從空字串改成 Worker URL。

範例：

```js
const workerApiBase = "https://tw-stock-quote-api.your-account.workers.dev";
```

Worker 不需要 GitHub Token，也不需要把私密金鑰放進前端。

## 資料更新

GitHub Actions 設定必須放在 `.github/workflows/update-stock-data.yml`，`.github` 不能改名。

GitHub Actions 低頻保留為備援資料與熱門提示來源，設定為台灣時間週一到週五 09:07、12:37、14:07 各更新一次。即時單股查詢主要由 Cloudflare Worker 處理；Actions 產生的是靜態 JSON，不是秒級即時串流。

## 效能

40 檔資料不會讓手機或電腦明顯變慢，因為頁面不會一次載入 40 檔完整歷史資料；只會先載入很小的清單檔，選定標的後才載入該標的一份 JSON。Worker 查詢只抓單一股票報價，適合使用者臨時查詢。

## 風險聲明

分析結果只供研究參考，不是保證獲利建議，也不是個人化投資建議。本工具不做上漲機率、模型預測或保證獲利判斷。資料來源若變更格式或限制存取，GitHub Actions 更新可能失敗。
