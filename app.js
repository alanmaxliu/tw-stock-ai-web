const $ = (selector) => document.querySelector(selector);

const state = {
  lastReport: "",
  lastSymbol: "",
  lastTimestamp: "",
};

const form = $("#analysis-form");
const symbolInput = $("#symbol-input");
const statusBox = $("#status-box");
const analyzeButton = $("#analyze-button");
const canvas = $("#price-chart");
const ctx = canvas.getContext("2d");
const downloadReportButton = $("#download-report");
const downloadChartButton = $("#download-chart");
const quickSymbolSelect = $("#quick-symbol-select");

const universeUrl = "./data/universe.json";
const workerApiBase = "https://tw-stock-quote-api.alanmaxliu-stock.workers.dev";

function normalizeSymbol(rawSymbol) {
  const value = rawSymbol.trim().toUpperCase();
  if (/^\d+$/.test(value)) return `${value}.TW`;
  return value;
}

function plainTaiwanCode(rawSymbol) {
  const value = rawSymbol.trim().toUpperCase().replace(/\.TW$/, "");
  return /^\d+$/.test(value) ? value : "";
}

function setStatus(message) {
  statusBox.textContent = message;
}

function symbolLabel(item) {
  const category = item.category === "ETF" ? "ETF" : "個股";
  const latest = Number.isFinite(Number(item.latestClose)) ? `｜${formatNumber(Number(item.latestClose))}` : "";
  return `${category} #${item.rank}｜${item.symbol} ${item.name}${latest}`;
}

function resetQuickSelect() {
  quickSymbolSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "選擇後會帶入左側輸入框";
  quickSymbolSelect.appendChild(placeholder);
}

async function loadUniverse() {
  analyzeButton.disabled = true;
  try {
    const response = await fetch(`${universeUrl}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];
    if (symbols.length === 0) throw new Error("熱門清單是空的。");
    resetQuickSelect();
    for (const item of symbols) {
      const quickOption = document.createElement("option");
      quickOption.value = item.symbol;
      quickOption.textContent = symbolLabel(item);
      quickSymbolSelect.appendChild(quickOption);
    }
    analyzeButton.disabled = false;
    setStatus(`已載入 ${symbols.length} 檔熱門提示。可直接輸入任意台股代號，或用下拉選單快速帶入。更新時間：${payload.generatedAt || "--"}`);
  } catch (error) {
    resetQuickSelect();
    analyzeButton.disabled = false;
    setStatus(`Status: WARN\nRoot Cause: 無法載入熱門提示 data/universe.json：${error.message}\nSuggested Fix: 仍可手動輸入股票代號；若要恢復熱門提示，確認 GitHub Actions 已成功產生 data/universe.json。`);
  }
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(digits);
}

function formatTaiwanDate(date) {
  return date.toLocaleDateString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatTaiwanDateTime(date) {
  return date.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function publicPriceType(rawType = "") {
  if (rawType.includes("成交")) return "盤中成交價";
  if (rawType.includes("買賣") || rawType.includes("買一") || rawType.includes("賣一")) return "盤中參考價";
  if (rawType.includes("昨收") || rawType.includes("收盤")) return "收盤價";
  return "最新參考價";
}

function scoreNote(score) {
  if (score >= 72) return "條件偏佳，可分批觀察。";
  if (score >= 58) return "中性偏多，等待較好價格。";
  if (score >= 42) return "中性區間，不適合追價。";
  return "風險偏高，先等待。";
}

function publicSourceLabel(source = "") {
  if (source.includes("TWSE")) return "交易所公開資料";
  if (source.includes("Yahoo") || source.includes("Worker") || source.includes("GitHub")) return "公開行情資料";
  return source || "公開行情資料";
}

function publicFetchError(message = "") {
  return message
    .replaceAll("Cloudflare Worker", "即時行情")
    .replaceAll("Worker", "即時行情")
    .replaceAll("GitHub 靜態資料", "預存資料")
    .replaceAll("GitHub Actions static JSON", "預存資料")
    .replaceAll("Yahoo Finance", "公開備援資料")
    .replaceAll("TWSE 月資料 API", "交易所公開資料");
}

function yahooChartUrl(symbol) {
  const params = new URLSearchParams({
    range: "1y",
    interval: "1d",
    includePrePost: "false",
    events: "history",
  });
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`;
}

function twseMonthUrl(code, date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${year}${month}01&stockNo=${code}`;
}

function workerQuoteUrl(code) {
  if (!workerApiBase) return "";
  const base = workerApiBase.replace(/\/$/, "");
  return `${base}?symbol=${encodeURIComponent(code)}`;
}

function timeoutSignal(milliseconds) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), milliseconds);
  return controller.signal;
}

function staticDataUrl(code) {
  return `./data/stocks/${encodeURIComponent(code)}.json`;
}

function parseTwseNumber(value) {
  if (typeof value !== "string") return Number.NaN;
  return Number(value.replaceAll(",", "").replaceAll("--", "").trim());
}

function parseTwseDate(value) {
  const parts = value.split("/").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return new Date(parts[0] + 1911, parts[1] - 1, parts[2]);
}

function parseWorkerDate(dateValue, timeValue) {
  if (/^\d{8}$/.test(dateValue || "")) {
    const year = Number(dateValue.slice(0, 4));
    const month = Number(dateValue.slice(4, 6));
    const day = Number(dateValue.slice(6, 8));
    const time = /^\d{2}:\d{2}:\d{2}$/.test(timeValue || "") ? timeValue : "00:00:00";
    return new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${time}+08:00`);
  }
  return new Date();
}

function clearResults() {
  $("#signal-label").textContent = "尚未分析";
  $("#probability-label").textContent = "--";
  $("#score-label").textContent = "--";
  $("#price-label").textContent = "--";
  $("#source-label").textContent = "--";
  $("#score-note").textContent = "尚未分析";
  $("#price-note").textContent = "尚未分析";
  $("#source-note").textContent = "--";
  $("#analysis-text").textContent = "尚未產生分析。";
  $("#action-text").textContent = "請先執行分析。";
  state.lastReport = "";
  state.lastTimestamp = "";
  downloadReportButton.disabled = true;
  downloadChartButton.disabled = true;
  drawPlaceholderChart();
}

async function fetchWorkerQuote(code) {
  const url = workerQuoteUrl(code);
  if (!url) throw new Error("尚未設定 Cloudflare Worker URL。");
  const response = await fetch(url, { cache: "no-store", signal: timeoutSignal(6000) });
  if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.status !== "OK" || !payload.quote) {
    throw new Error(payload.error || "Worker 未回傳可用報價。");
  }
  const quote = payload.quote;
  const price = Number(quote.price);
  if (!Number.isFinite(price)) throw new Error("Worker 報價格式不完整。");
  return {
    date: parseWorkerDate(quote.date, quote.time),
    open: Number.isFinite(Number(quote.open)) ? Number(quote.open) : price,
    high: Number.isFinite(Number(quote.high)) ? Number(quote.high) : price,
    low: Number.isFinite(Number(quote.low)) ? Number(quote.low) : price,
    close: price,
    volume: Number.isFinite(Number(quote.volume)) ? Number(quote.volume) : 0,
    name: quote.name || "",
    priceType: quote.priceType || "最新參考價",
    fetchedAt: quote.fetchedAt || "",
  };
}

async function fetchWorkerBars(code) {
  const url = workerQuoteUrl(code);
  if (!url) throw new Error("尚未設定 Cloudflare Worker URL。");
  const response = await fetch(url, { cache: "no-store", signal: timeoutSignal(9000) });
  if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.status !== "OK" || !Array.isArray(payload.bars)) {
    throw new Error(payload.error || "Worker 未回傳可用歷史資料。");
  }
  const bars = payload.bars.map((bar) => ({
    date: new Date(`${bar.date}T00:00:00+08:00`),
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: Number(bar.volume) || 0,
  })).filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
  if (bars.length < 60) throw new Error(`Worker 歷史資料不足，目前只有 ${bars.length} 筆。`);
  const quote = payload.quote || {};
  const quoteTime = quote.date ? parseWorkerDate(quote.date, quote.time) : bars.at(-1).date;
  const priceLabel = publicPriceType(quote.priceType || "");
  return {
    bars,
    source: payload.source || "Cloudflare Worker",
    sourceLabel: "公開行情資料",
    dataStatus: `最新價格：${priceLabel}，時間：${formatTaiwanDateTime(quoteTime)}。`,
    priceNote: `${priceLabel}，${formatTaiwanDateTime(quoteTime)}`,
    stockName: quote.name || "",
  };
}

async function fetchYahooBars(symbol) {
  const response = await fetch(yahooChartUrl(symbol), { cache: "no-store", signal: timeoutSignal(9000) });
  if (!response.ok) throw new Error(`資料來源回應失敗：HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error("查無行情資料。");
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const close = quote.close?.[index];
    const open = quote.open?.[index];
    const high = quote.high?.[index];
    const low = quote.low?.[index];
    const volume = quote.volume?.[index];
    if (![open, high, low, close].every(Number.isFinite)) continue;
    bars.push({
      date: new Date(timestamps[index] * 1000),
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }
  if (bars.length < 150) throw new Error(`資料筆數不足，目前只有 ${bars.length} 筆。`);
  return {
    bars,
    source: "Yahoo Finance",
    sourceLabel: "公開行情資料",
    dataStatus: `最新資料日：${formatTaiwanDate(bars.at(-1).date)}。`,
    priceNote: `收盤價，${formatTaiwanDate(bars.at(-1).date)}`,
  };
}

async function mergeWorkerQuote(result, code) {
  if (!code || !workerApiBase) return result;
  try {
    const quote = await fetchWorkerQuote(code);
    const bars = [...result.bars];
    const latest = bars.at(-1);
    const quoteDay = quote.date.toISOString().slice(0, 10);
    const latestDay = latest.date.toISOString().slice(0, 10);
    if (quoteDay === latestDay) {
      bars[bars.length - 1] = { ...latest, ...quote };
    } else if (quote.date > latest.date) {
      bars.push(quote);
    }
    const priceLabel = publicPriceType(quote.priceType);
    return {
      bars: bars.slice(-260),
      source: `${result.source} + Cloudflare Worker 即時報價`,
      sourceLabel: "公開行情資料",
      dataStatus: `最新價格：${priceLabel}，時間：${formatTaiwanDateTime(quote.date)}。`,
      priceNote: `${priceLabel}，${formatTaiwanDateTime(quote.date)}`,
    };
  } catch (error) {
    return {
      ...result,
      dataStatus: result.dataStatus || "已讀取歷史資料。",
    };
  }
}

async function fetchStaticBars(code) {
  if (!code) throw new Error("靜態資料只支援台股數字代號。");
  const response = await fetch(`${staticDataUrl(code)}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`靜態資料不存在：HTTP ${response.status}`);
  const payload = await response.json();
  const bars = (payload.bars || []).map((bar) => ({
    date: new Date(`${bar.date}T00:00:00+08:00`),
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: Number(bar.volume) || 0,
  })).filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
  if (bars.length < 150) throw new Error(`靜態資料筆數不足，目前只有 ${bars.length} 筆。`);
  const latestDay = bars.at(-1).date.toLocaleDateString("zh-TW");
  const generatedAt = payload.generatedAt || "";
  const source = payload.source || "GitHub Actions static JSON";
  const dataStatus = generatedAt
    ? `最新資料日：${latestDay}。`
    : `最新資料日：${latestDay}。`;
  return { bars, source, sourceLabel: "預存行情資料", generatedAt, dataStatus, priceNote: `收盤價，${latestDay}` };
}

function recentMonthStarts(count) {
  const output = [];
  const current = new Date();
  current.setDate(1);
  for (let index = 0; index < count; index += 1) {
    output.push(new Date(current.getFullYear(), current.getMonth() - index, 1));
  }
  return output;
}

async function fetchTwseBars(code) {
  if (!code) throw new Error("TWSE 備援資料源只支援台股數字代號。");
  const requests = recentMonthStarts(14).map(async (date) => {
    const response = await fetch(twseMonthUrl(code, date), { cache: "no-store", signal: timeoutSignal(9000) });
    if (!response.ok) throw new Error(`TWSE HTTP ${response.status}`);
    return response.json();
  });
  const payloads = await Promise.all(requests);
  const bars = [];
  for (const payload of payloads) {
    if (!Array.isArray(payload.data)) continue;
    for (const row of payload.data) {
      const date = parseTwseDate(row[0]);
      const open = parseTwseNumber(row[3]);
      const high = parseTwseNumber(row[4]);
      const low = parseTwseNumber(row[5]);
      const close = parseTwseNumber(row[6]);
      const volume = parseTwseNumber(row[1]);
      if (!date || ![open, high, low, close].every(Number.isFinite)) continue;
      bars.push({ date, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
    }
  }
  const unique = new Map();
  for (const bar of bars) unique.set(bar.date.toISOString().slice(0, 10), bar);
  const sorted = Array.from(unique.values()).sort((a, b) => a.date - b.date);
  if (sorted.length < 150) throw new Error(`TWSE 資料筆數不足，目前只有 ${sorted.length} 筆。`);
  return {
    bars: sorted.slice(-260),
    source: "TWSE 月資料 API",
    sourceLabel: "交易所公開資料",
    dataStatus: `最新資料日：${formatTaiwanDate(sorted.at(-1).date)}。`,
    priceNote: `收盤價，${formatTaiwanDate(sorted.at(-1).date)}`,
  };
}

async function fetchBars(symbol, rawSymbol) {
  const errors = [];
  const code = plainTaiwanCode(rawSymbol);
  try {
    return await fetchWorkerBars(code);
  } catch (error) {
    errors.push(`即時行情：${publicFetchError(error.message)}`);
  }
  try {
    return await mergeWorkerQuote(await fetchStaticBars(code), code);
  } catch (error) {
    errors.push(`預存資料：${publicFetchError(error.message)}`);
  }
  try {
    return await mergeWorkerQuote(await fetchYahooBars(symbol), code);
  } catch (error) {
    errors.push(`公開備援資料：${publicFetchError(error.message)}`);
  }
  try {
    return await mergeWorkerQuote(await fetchTwseBars(code), code);
  } catch (error) {
    errors.push(`交易所公開資料：${publicFetchError(error.message)}`);
  }
  throw new Error(errors.join("\n"));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdev(values) {
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function sma(values, window) {
  return mean(values.slice(-window));
}

function smaSeries(values, window) {
  return values.map((_, index) => {
    if (index + 1 < window) return null;
    return mean(values.slice(index + 1 - window, index + 1));
  });
}

function emaSeries(values, window) {
  const multiplier = 2 / (window + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index] * multiplier + output[index - 1] * (1 - multiplier));
  }
  return output;
}

function rsi(values, window = 14) {
  const recent = values.slice(-(window + 1));
  let gains = 0;
  let losses = 0;
  for (let index = 1; index < recent.length; index += 1) {
    const change = recent[index] - recent[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  const averageGain = gains / window;
  const averageLoss = losses / window;
  if (averageLoss === 0) return 100;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

function macd(values) {
  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);
  const line = ema12.map((value, index) => value - ema26[index]);
  const signal = emaSeries(line, 9);
  const current = line.at(-1);
  const currentSignal = signal.at(-1);
  return { macd: current, signal: currentSignal, hist: current - currentSignal };
}

function bollinger(values, window = 20) {
  const recent = values.slice(-window);
  const mid = mean(recent);
  const sd = stdev(recent);
  return { mid, upper: mid + 2 * sd, lower: mid - 2 * sd };
}

function percentileRank(values, current) {
  return (values.filter((value) => value <= current).length / values.length) * 100;
}

function maxDrawdown(values) {
  let peak = values[0];
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    worst = Math.min(worst, (value / peak - 1) * 100);
  }
  return worst;
}

function trueRange(bars, index) {
  if (index === 0) return bars[index].high - bars[index].low;
  const previousClose = bars[index - 1].close;
  return Math.max(
    bars[index].high - bars[index].low,
    Math.abs(bars[index].high - previousClose),
    Math.abs(bars[index].low - previousClose),
  );
}

function atrPercent(bars, window = 14) {
  const ranges = [];
  for (let index = bars.length - window; index < bars.length; index += 1) {
    ranges.push(trueRange(bars, index));
  }
  return (mean(ranges) / bars.at(-1).close) * 100;
}

function percentChange(values, window) {
  if (values.length <= window) return 0;
  return (values.at(-1) / values[values.length - window - 1] - 1) * 100;
}

function annualizedVolatility(values, window = 20) {
  const recent = values.slice(-(window + 1));
  const returns = [];
  for (let index = 1; index < recent.length; index += 1) {
    returns.push(recent[index] / recent[index - 1] - 1);
  }
  return stdev(returns) * Math.sqrt(252) * 100;
}

function scoreAnalysis(metrics) {
  let score = 50;
  const reasons = [];
  const risks = [];
  if (metrics.current > metrics.ma20 && metrics.ma20 > metrics.ma60 && metrics.ma60 > metrics.ma120) {
    score += 12;
    reasons.push("均線呈多頭排列，趨勢結構偏強。");
  } else if (metrics.current < metrics.ma60) {
    score -= 10;
    risks.push("價格低於 60 日均線，中期趨勢轉弱。");
  }
  if (metrics.rsi14 >= 70) {
    score -= 14;
    risks.push("RSI 高於 70，短線追高風險升高。");
  } else if (metrics.rsi14 <= 35) {
    score += 12;
    reasons.push("RSI 偏低，具備分批觀察條件。");
  }
  if (metrics.macdHist > 0) {
    score += 6;
    reasons.push("MACD 柱狀體為正，動能仍偏多。");
  } else {
    score -= 4;
    risks.push("MACD 柱狀體為負，動能偏弱。");
  }
  if (metrics.percentile >= 85) {
    score -= 12;
    risks.push(`近一年價格百分位 ${formatNumber(metrics.percentile, 1)}%，安全邊際不足。`);
  } else if (metrics.percentile <= 30) {
    score += 10;
    reasons.push("價格位於近一年相對低位。");
  }
  if (metrics.drawdown60 >= -2) risks.push("價格貼近 60 日高點，較不適合急著投入。");
  if (metrics.volatility20 >= 28) risks.push(`20 日年化波動率 ${formatNumber(metrics.volatility20, 1)}%，波動偏高。`);
  score = Math.max(0, Math.min(100, Math.round(score)));

  let signal;
  let action;
  if (score >= 72) {
    signal = "分批投入條件佳";
    action = "可考慮小比例分批投入，避免一次投入全部資金。";
  } else if (score >= 58) {
    signal = "中性偏多，等待好價格";
    action = "可持續觀察，等待回測 20 日均線或 RSI 降溫後投入。";
  } else if (score >= 42) {
    signal = "中性偏弱，暫不追價";
    action = "保留資金，等待接近 60 日均線或出現明確回檔。";
  } else {
    signal = "風險偏高，等待";
    action = "目前不建議投入，等待價格降溫或趨勢重新整理。";
  }
  return { score, signal, action, reasons, risks };
}

function analyzeBars(symbol, bars, source, dataStatus, stockName = "", sourceLabel = "", priceNote = "") {
  const closes = bars.map((bar) => bar.close);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const current = closes.at(-1);
  const m = macd(closes);
  const b = bollinger(closes);
  const metrics = {
    symbol,
    stockName,
    date: bars.at(-1).date,
    current,
    ma20: sma(closes, 20),
    ma60: sma(closes, 60),
    ma120: sma(closes, 120),
    rsi14: rsi(closes, 14),
    macd: m.macd,
    macdSignal: m.signal,
    macdHist: m.hist,
    bollMid: b.mid,
    bollUpper: b.upper,
    bollLower: b.lower,
    return20: percentChange(closes, 20),
    return60: percentChange(closes, 60),
    drawdown60: (current / Math.max(...closes.slice(-60)) - 1) * 100,
    drawdown1y: maxDrawdown(closes),
    volatility20: annualizedVolatility(closes, 20),
    atr14Pct: atrPercent(bars, 14),
    percentile: percentileRank(closes, current),
    support20: Math.min(...lows.slice(-20)),
    support60: Math.min(...lows.slice(-60)),
    resistance20: Math.max(...highs.slice(-20)),
    resistance60: Math.max(...highs.slice(-60)),
    source,
    sourceLabel: sourceLabel || publicSourceLabel(source),
    dataStatus,
    priceNote: priceNote || `收盤價，${formatTaiwanDate(bars.at(-1).date)}`,
  };
  return { ...metrics, ...scoreAnalysis(metrics), bars };
}

function drawChart(analysis) {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const bars = analysis.bars.slice(-180);
  const closes = bars.map((bar) => bar.close);
  const allCloses = analysis.bars.map((bar) => bar.close);
  const ma20 = smaSeries(allCloses, 20).slice(-180);
  const ma60 = smaSeries(allCloses, 60).slice(-180);
  const ma120 = smaSeries(allCloses, 120).slice(-180);
  const margin = { left: 70, top: 62, right: 34, priceBottom: 470, rsiTop: 525, bottom: 675 };
  const minPrice = Math.min(...closes, ...ma120.filter(Boolean));
  const maxPrice = Math.max(...closes, ...ma20.filter(Boolean));
  const priceSpan = maxPrice - minPrice || 1;
  const xAt = (index) => margin.left + (index / (bars.length - 1)) * (width - margin.left - margin.right);
  const yPrice = (value) => margin.priceBottom - ((value - minPrice) / priceSpan) * (margin.priceBottom - margin.top);
  const yRsi = (value) => margin.bottom - (value / 100) * (margin.bottom - margin.rsiTop);

  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#17202a";
  ctx.font = "700 26px Microsoft JhengHei, sans-serif";
  const title = analysis.stockName ? `${analysis.symbol} ${analysis.stockName} 技術分析` : `${analysis.symbol} 技術分析`;
  ctx.fillText(title, margin.left, 36);
  ctx.font = "15px Microsoft JhengHei, sans-serif";
  ctx.fillStyle = "#64748b";
  ctx.fillText(`最新價 ${formatNumber(analysis.current)} ｜ 技術分數 ${analysis.score}/100 ｜ RSI14 ${formatNumber(analysis.rsi14, 1)}`, margin.left, 58);

  ctx.strokeStyle = "#cbd5e1";
  ctx.strokeRect(margin.left, margin.top, width - margin.left - margin.right, margin.priceBottom - margin.top);
  ctx.strokeRect(margin.left, margin.rsiTop, width - margin.left - margin.right, margin.bottom - margin.rsiTop);
  ctx.strokeStyle = "#e2e8f0";
  [0.25, 0.5, 0.75].forEach((fraction) => {
    const y = margin.top + fraction * (margin.priceBottom - margin.top);
    line(margin.left, y, width - margin.right, y);
  });
  [30, 70].forEach((level) => line(margin.left, yRsi(level), width - margin.right, yRsi(level)));

  drawSeries(closes.map((value, index) => [xAt(index), yPrice(value)]), "#111827", 3);
  drawSeries(ma20.map((value, index) => value == null ? null : [xAt(index), yPrice(value)]).filter(Boolean), "#f97316", 2);
  drawSeries(ma60.map((value, index) => value == null ? null : [xAt(index), yPrice(value)]).filter(Boolean), "#0f766e", 2);
  drawSeries(ma120.map((value, index) => value == null ? null : [xAt(index), yPrice(value)]).filter(Boolean), "#64748b", 2);

  const rsiValues = allCloses.map((_, index) => index < 14 ? null : rsi(allCloses.slice(0, index + 1), 14)).slice(-180);
  drawSeries(rsiValues.map((value, index) => value == null ? null : [xAt(index), yRsi(value)]).filter(Boolean), "#7c3aed", 2);

  ctx.fillStyle = "#475569";
  ctx.font = "14px Microsoft JhengHei, sans-serif";
  ctx.fillText(`MA20 ${formatNumber(analysis.ma20)} ｜ MA60 ${formatNumber(analysis.ma60)} ｜ MA120 ${formatNumber(analysis.ma120)}`, margin.left, margin.priceBottom + 24);
  ctx.fillText(`RSI14 ${formatNumber(analysis.rsi14, 1)} ｜ 支撐 ${formatNumber(analysis.support60)} ｜ 壓力 ${formatNumber(analysis.resistance60)}`, margin.left, margin.bottom + 26);

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  function drawSeries(points, color, widthValue) {
    if (points.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = widthValue;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (const point of points.slice(1)) ctx.lineTo(point[0], point[1]);
    ctx.stroke();
  }
}

function buildReport(analysis) {
  const date = analysis.date.toLocaleDateString("zh-TW");
  const title = analysis.stockName ? `${analysis.symbol} ${analysis.stockName}` : analysis.symbol;
  return `股票技術分析報告：${title}
產出時間：${new Date().toLocaleString("zh-TW")}
最新交易日：${date}

核心結論
- 今日訊號：${analysis.signal}
- 技術分數：${analysis.score}/100（${scoreNote(analysis.score)}）
- 行動參考：${analysis.action}
- 資料來源：${analysis.sourceLabel}
- 價格時間：${analysis.priceNote}

價格與趨勢
- 最新價：${formatNumber(analysis.current)}（${analysis.priceNote}）
- MA20 / MA60 / MA120：${formatNumber(analysis.ma20)} / ${formatNumber(analysis.ma60)} / ${formatNumber(analysis.ma120)}
- 20 日報酬：${formatNumber(analysis.return20)}%
- 60 日報酬：${formatNumber(analysis.return60)}%

動能與風險
- RSI14：${formatNumber(analysis.rsi14, 1)}
- MACD Histogram：${formatNumber(analysis.macdHist, 3)}
- 布林上緣 / 中線 / 下緣：${formatNumber(analysis.bollUpper)} / ${formatNumber(analysis.bollMid)} / ${formatNumber(analysis.bollLower)}
- 20 日年化波動率：${formatNumber(analysis.volatility20, 1)}%
- 近一年最大回撤：${formatNumber(Math.abs(analysis.drawdown1y), 1)}%
- 近一年價格百分位：${formatNumber(analysis.percentile, 1)}%
- 60 日支撐 / 壓力：${formatNumber(analysis.support60)} / ${formatNumber(analysis.resistance60)}

主要判斷
${analysis.reasons.map((item) => `- ${item}`).join("\n")}

主要風險
${analysis.risks.map((item) => `- ${item}`).join("\n")}

風險聲明
此報告只依公開價格資料與技術指標產生量化觀察，不包含模型預測或保證獲利判斷，也不是個人化投資建議。`;
}

function updateUi(analysis) {
  $("#signal-label").textContent = analysis.signal;
  $("#probability-label").textContent = formatTaiwanDate(analysis.date);
  $("#score-label").textContent = `${analysis.score}/100`;
  $("#score-note").textContent = scoreNote(analysis.score);
  $("#price-label").textContent = formatNumber(analysis.current);
  $("#price-note").textContent = analysis.priceNote;
  $("#source-label").textContent = analysis.sourceLabel;
  $("#source-note").textContent = "即時或收盤公開行情";
  $("#analysis-text").textContent = `最新價格：${formatNumber(analysis.current)}（${analysis.priceNote}）
資料來源：${analysis.sourceLabel}
技術分數：${analysis.score}/100（${scoreNote(analysis.score)}）
MA20 / MA60 / MA120：${formatNumber(analysis.ma20)} / ${formatNumber(analysis.ma60)} / ${formatNumber(analysis.ma120)}
RSI14：${formatNumber(analysis.rsi14, 1)}
MACD Histogram：${formatNumber(analysis.macdHist, 3)}
20 日年化波動率：${formatNumber(analysis.volatility20, 1)}%
近一年價格百分位：${formatNumber(analysis.percentile, 1)}%`;
  $("#action-text").textContent = `${analysis.action}

主要判斷：
${analysis.reasons.map((item) => `- ${item}`).join("\n")}

主要風險：
${analysis.risks.map((item) => `- ${item}`).join("\n")}`;
}

function downloadBlob(filename, type, content) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function timestampName() {
  return new Date().toISOString().replaceAll(":", "").replaceAll("-", "").slice(0, 15);
}

async function runAnalysis(event) {
  event.preventDefault();
  const rawSymbol = symbolInput.value.trim();
  const symbol = normalizeSymbol(rawSymbol);
  state.lastSymbol = symbol;
  analyzeButton.disabled = true;
  clearResults();
  try {
    if (!rawSymbol) throw new Error("請先輸入股票代號。");
    setStatus(`讀取 ${symbol} 行情資料。`);
    const { bars, source, sourceLabel, dataStatus, stockName, priceNote } = await fetchBars(symbol, rawSymbol);
    setStatus("計算即時資料狀態與技術指標。");
    const analysis = analyzeBars(symbol, bars, source, dataStatus, stockName, sourceLabel, priceNote);
    drawChart(analysis);
    updateUi(analysis);
    state.lastTimestamp = timestampName();
    state.lastReport = buildReport(analysis);
    downloadReportButton.disabled = false;
    downloadChartButton.disabled = false;
    setStatus(`分析完成：${analysis.signal}。\n最新價格：${formatNumber(analysis.current)}（${analysis.priceNote}）`);
  } catch (error) {
    clearResults();
    setStatus(`Status: FAILED\nRoot Cause: ${error.message}\nSuggested Fix: 請確認股票代號仍上市櫃、資料來源可用，或稍後重試。若該代號已下市或停止交易，系統不會顯示上一筆查詢結果。`);
  } finally {
    analyzeButton.disabled = false;
  }
}

form.addEventListener("submit", runAnalysis);

quickSymbolSelect.addEventListener("change", () => {
  if (!quickSymbolSelect.value) return;
  symbolInput.value = quickSymbolSelect.value;
  symbolInput.focus();
});

downloadReportButton.addEventListener("click", () => {
  downloadBlob(`${state.lastSymbol}_${state.lastTimestamp}_analysis.md`, "text/markdown;charset=utf-8", state.lastReport);
});

downloadChartButton.addEventListener("click", () => {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${state.lastSymbol}_${state.lastTimestamp}_chart.png`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
});

function drawPlaceholderChart() {
  drawChart({
    symbol: "待分析",
    bars: Array.from({ length: 120 }, (_, index) => ({
      date: new Date(),
      close: 80 + Math.sin(index / 15) * 4 + index * 0.08,
    })),
    current: 94,
    score: 0,
    signal: "等待分析",
    ma20: 93,
    ma60: 90,
    ma120: 87,
    rsi14: 50,
    support60: 88,
    resistance60: 96,
  });
}

resetQuickSelect();
loadUniverse();
requestAnimationFrame(drawPlaceholderChart);
