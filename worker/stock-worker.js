const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
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

export default {
  async fetch(request) {
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

    try {
      const quote = await fetchQuote(symbol);
      return jsonResponse({ status: "OK", quote });
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
