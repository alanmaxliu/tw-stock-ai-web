const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const OK_CACHE_SECONDS = 45;

function jsonResponse(payload, status = 200, cacheSeconds = 0) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}` : "no-store",
    },
  });
}

function normalizeSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase().replace(/\.TW$/, "");
  if (!/^\d{4,6}$/.test(symbol)) return "";
  return symbol;
}

function parseNumber(value) {
  if (value == null) return null;
  const text = String(value).split("_", 1)[0].replaceAll(",", "").replaceAll("--", "").trim();
  if (!text || text === "-") return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function quotePrice(item) {
  const traded = parseNumber(item.z) ?? parseNumber(item.pz);
  if (traded != null) return { price: traded, priceType: "成交價" };
  const ask = parseNumber(item.a);
  const bid = parseNumber(item.b);
  if (ask != null && bid != null) return { price: (ask + bid) / 2, priceType: "買賣中間價" };
  if (bid != null) return { price: bid, priceType: "買一參考價" };
  if (ask != null) return { price: ask, priceType: "賣一參考價" };
  const previous = parseNumber(item.y);
  if (previous != null) return { price: previous, priceType: "昨收參考價" };
  return { price: null, priceType: "無可用價格" };
}

function quoteUrl(symbol) {
  const params = new URLSearchParams({
    ex_ch: [`tse_${symbol}.tw`, `otc_${symbol}.tw`].join("|"),
    json: "1",
    delay: "0",
    _: String(Date.now()),
  });
  return `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?${params.toString()}`;
}

function yahooHistoryUrl(symbol) {
  const params = new URLSearchParams({
    range: "1y",
    interval: "1d",
    includePrePost: "false",
    events: "history",
  });
  return `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.TW?${params.toString()}`;
}

function twseMonthUrl(symbol, date) {
  const params = new URLSearchParams({
    response: "json",
    date: `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}01`,
    stockNo: symbol,
  });
  return `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?${params.toString()}`;
}

function recentMonthStarts(count) {
  const now = new Date();
  const output = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  for (let index = 0; index < count; index += 1) {
    output.push(new Date(Date.UTC(year, month, 1)));
    month -= 1;
    if (month < 0) {
      year -= 1;
      month = 11;
    }
  }
  return output;
}

function parseRocDate(value) {
  const parts = String(value || "").split("/").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return "";
  return `${parts[0] + 1911}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}`;
}

async function fetchQuote(symbol) {
  const response = await fetch(quoteUrl(symbol), {
    headers: {
      "User-Agent": "tw-stock-worker/1.0",
      "Referer": "https://mis.twse.com.tw/",
      "Accept": "application/json,text/plain,*/*",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!response.ok) throw new Error(`TWSE MIS HTTP ${response.status}`);
  const payload = await response.json();
  const item = (payload.msgArray || []).find((entry) => String(entry?.c || "") === symbol);
  if (!item) throw new Error("TWSE MIS 查無此股票代號。");

  const { price, priceType } = quotePrice(item);
  if (price == null) throw new Error("TWSE MIS 未回傳可用價格。");

  return {
    symbol,
    name: item.n || "",
    date: item.d || item["^"] || "",
    time: item.t || item["%"] || "",
    price,
    priceType,
    open: parseNumber(item.o),
    high: parseNumber(item.h),
    low: parseNumber(item.l),
    previousClose: parseNumber(item.y),
    volume: parseNumber(item.v),
    bid: parseNumber(item.b),
    ask: parseNumber(item.a),
    source: "TWSE MIS via Cloudflare Worker",
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchYahooBars(symbol) {
  const response = await fetch(yahooHistoryUrl(symbol), {
    headers: {
      "User-Agent": "tw-stock-worker/1.0",
      "Accept": "application/json,text/plain,*/*",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error("Yahoo 查無歷史資料。");
  const timestamps = result.timestamp || [];
  const quoteData = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const open = quoteData.open?.[index];
    const high = quoteData.high?.[index];
    const low = quoteData.low?.[index];
    const close = quoteData.close?.[index];
    const volume = quoteData.volume?.[index];
    if (![open, high, low, close].every(Number.isFinite)) continue;
    bars.push({
      date: new Date(timestamps[index] * 1000).toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }
  if (bars.length < 60) throw new Error(`Yahoo 歷史資料不足，目前只有 ${bars.length} 筆。`);
  return { bars: bars.slice(-260), historySource: "Yahoo Finance via Cloudflare Worker" };
}

async function fetchTwseBars(symbol) {
  const payloads = await Promise.all(recentMonthStarts(14).map(async (date) => {
    const response = await fetch(twseMonthUrl(symbol, date), {
      headers: {
        "User-Agent": "tw-stock-worker/1.0",
        "Referer": "https://www.twse.com.tw/",
        "Accept": "application/json,text/plain,*/*",
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!response.ok) throw new Error(`TWSE HTTP ${response.status}`);
    return response.json();
  }));
  const records = new Map();
  for (const payload of payloads) {
    for (const row of payload.data || []) {
      const date = parseRocDate(row[0]);
      const open = parseNumber(row[3]);
      const high = parseNumber(row[4]);
      const low = parseNumber(row[5]);
      const close = parseNumber(row[6]);
      const volume = parseNumber(row[1]) ?? 0;
      if (!date || [open, high, low, close].some((value) => value == null)) continue;
      records.set(date, { date, open, high, low, close, volume });
    }
  }
  const bars = Array.from(records.values()).sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 60) throw new Error(`TWSE 歷史資料不足，目前只有 ${bars.length} 筆。`);
  return { bars: bars.slice(-260), historySource: "TWSE monthly history via Cloudflare Worker" };
}

async function fetchHistory(symbol) {
  try {
    return await fetchYahooBars(symbol);
  } catch (yahooError) {
    const twseResult = await fetchTwseBars(symbol);
    twseResult.historySource = `${twseResult.historySource}; Yahoo fallback reason: ${yahooError.message}`;
    return twseResult;
  }
}

function mergeQuoteIntoBars(bars, quote) {
  const output = [...bars];
  const quoteDate = `${quote.date.slice(0, 4)}-${quote.date.slice(4, 6)}-${quote.date.slice(6, 8)}`;
  const latest = output.at(-1);
  const quoteBar = {
    date: quoteDate,
    open: quote.open ?? quote.price,
    high: quote.high ?? quote.price,
    low: quote.low ?? quote.price,
    close: quote.price,
    volume: quote.volume ?? 0,
  };
  if (latest?.date === quoteDate) output[output.length - 1] = { ...latest, ...quoteBar };
  else if (!latest || latest.date < quoteDate) output.push(quoteBar);
  return output.slice(-260);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== "GET") {
      return jsonResponse({ status: "FAILED", error: "只支援 GET。" }, 405);
    }

    const url = new URL(request.url);
    const symbol = normalizeSymbol(url.searchParams.get("symbol"));
    if (!symbol) {
      return jsonResponse({
        status: "FAILED",
        error: "請提供 4 到 6 碼台股代號，例如 /stock?symbol=0050。",
      }, 400);
    }

    const cacheKey = new Request(url.toString(), request);
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    try {
      const quote = await fetchQuote(symbol);
      const history = await fetchHistory(symbol);
      const response = jsonResponse({
        status: "OK",
        quote,
        bars: mergeQuoteIntoBars(history.bars, quote),
        source: `${history.historySource} + TWSE MIS quote via Cloudflare Worker`,
        cachedForSeconds: OK_CACHE_SECONDS,
      }, 200, OK_CACHE_SECONDS);
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      return jsonResponse({
        status: "FAILED",
        symbol,
        error: error.message,
        fetchedAt: new Date().toISOString(),
      }, 502);
    }
  },
};
