# 台股 AI 技術分析網頁

純前端台股分析工具。GitHub Actions 會定時產生熱門 40 檔清單與日線 JSON，前端使用下拉選單挑選單一標的後，用 TensorFlow.js 與技術指標產生分析結果、PNG 圖表與 Markdown 報告。

## 功能

- 熱門清單：上市 ETF 成交金額前 20、上市個股成交金額前 20。
- 前端只讀 `data/universe.json` 與使用者選到的 `data/stocks/{代號}.json`。
- 支援亮色、暗色與跟隨系統設定。
- 可下載分析報告與 PNG 圖表。

## 資料更新

GitHub Actions 設定必須放在 `.github/workflows/update-stock-data.yml`，`.github` 不能改名。

盤中排程約每 30 分鐘更新一次，收盤後再更新一次。Actions 產生的是靜態 JSON，不是秒級即時串流。

## 效能

40 檔資料不會讓手機或電腦明顯變慢，因為頁面不會一次載入 40 檔完整歷史資料；只會先載入很小的清單檔，選定標的後才載入該標的一份 JSON。

## 風險聲明

分析結果只供研究參考，不是保證獲利建議，也不是個人化投資建議。資料來源若變更格式或限制存取，GitHub Actions 更新可能失敗。
