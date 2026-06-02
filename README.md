# 台股 AI 技術分析網頁

這是一個可部署到 GitHub Pages 的純前端工具。使用者在網頁輸入台灣股票代號後，瀏覽器會即時抓取近一年價格資料，使用 TensorFlow.js 訓練簡化模型，產生技術分析、AI 上漲機率、PNG 圖表與 Markdown 報告。

## 功能

- 支援台股代號，例如 `0050`、`2330`、`2454`。
- 使用 TensorFlow.js 在瀏覽器內訓練模型，不把查詢紀錄存到雲端。
- 分析 MA20、MA60、MA120、RSI14、MACD、布林通道、波動率、支撐壓力、近一年百分位。
- 產生 PNG 圖表。
- 產生 Markdown 報告，檔名含日期時間，使用者可自行下載保存。

## 部署到 GitHub Pages

1. 將 `tw-stock-ai-web` 資料夾內容推到 GitHub repository。
2. 到 GitHub repository 的 Settings。
3. 開啟 Pages。
4. Source 選擇部署分支，例如 `main`。
5. 根目錄若就是此專案，選 `/root`；若放在子資料夾，可改用 GitHub Actions 或調整 repository 結構。

## 限制

- GitHub Pages 是靜態網站，不能保證第三方行情 API 永遠允許跨網域讀取。
- 此工具不儲存使用者查詢資料。
- 分析結果只供研究參考，不是保證獲利建議，也不是個人化投資建議。
