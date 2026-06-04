import json
import ssl
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
OUTPUT_DIR = DATA_DIR / "stocks"
UNIVERSE_FILE = DATA_DIR / "universe.json"
MONTH_COUNT = 14
TOP_ETF_COUNT = 20
TOP_STOCK_COUNT = 20
ETF_CANDIDATE_COUNT = 32
STOCK_CANDIDATE_COUNT = 32
SSL_CONTEXT = ssl._create_unverified_context()
TAIPEI_TZ = timezone(timedelta(hours=8))
FALLBACK_MARK = "reused previous JSON because live update failed"


def taipei_now_iso() -> str:
    return datetime.now(TAIPEI_TZ).isoformat(timespec="seconds")


def recent_months(count: int) -> list[datetime]:
    now = datetime.now()
    year = now.year
    month = now.month
    months = []
    for _ in range(count):
        months.append(datetime(year, month, 1))
        month -= 1
        if month == 0:
            year -= 1
            month = 12
    return months


def fetch_text(url: str) -> str:
    last_error: Exception | None = None
    for attempt in range(2):
        request = Request(
            url,
            headers={
                "User-Agent": "tw-stock-ai-web/1.0",
                "Accept": "application/json,text/plain,*/*",
                "Referer": "https://www.twse.com.tw/",
            },
        )
        try:
            with urlopen(request, timeout=16, context=SSL_CONTEXT) as response:
                return response.read().decode("utf-8", errors="replace")
        except Exception as exc:
            last_error = exc
            time.sleep(0.8 * (attempt + 1))
    raise last_error or RuntimeError(f"Failed to fetch {url}")


def fetch_json(url: str) -> dict:
    return json.loads(fetch_text(url))


def parse_number(value: object) -> float | None:
    if value is None:
        return None
    cleaned = str(value).replace(",", "").replace("--", "").replace("-", "").strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_roc_date(value: str) -> str | None:
    try:
        year, month, day = [int(part) for part in value.split("/")]
    except ValueError:
        return None
    return f"{year + 1911:04d}-{month:02d}-{day:02d}"


def twse_day_all_url() -> str:
    return "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"


def twse_month_url(symbol: str, month_start: datetime) -> str:
    params = urlencode(
        {
            "response": "json",
            "date": f"{month_start.year}{month_start.month:02d}01",
            "stockNo": symbol,
        }
    )
    return f"https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?{params}"


def yahoo_history_url(symbol: str) -> str:
    params = urlencode(
        {
            "range": "1y",
            "interval": "1d",
            "includePrePost": "false",
            "events": "history",
        }
    )
    return f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}.TW?{params}"


def quote_url(symbols: list[str]) -> str:
    channels = []
    for symbol in symbols:
        channels.append(f"tse_{symbol}.tw")
        channels.append(f"otc_{symbol}.tw")
    params = urlencode(
        {
            "ex_ch": "|".join(channels),
            "json": "1",
            "delay": "0",
            "_": str(int(datetime.now().timestamp() * 1000)),
        }
    )
    return f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?{params}"


def first_quote_level(value: object) -> float | None:
    if value is None:
        return None
    return parse_number(str(value).split("_", 1)[0])


def quote_price(item: dict) -> float | None:
    traded = parse_number(item.get("z")) or parse_number(item.get("pz"))
    if traded is not None:
        return traded
    ask = first_quote_level(item.get("a"))
    bid = first_quote_level(item.get("b"))
    if ask is not None and bid is not None:
        return (ask + bid) / 2
    return bid or ask or parse_number(item.get("y"))


def fetch_realtime_quotes(symbols: list[str]) -> dict[str, dict]:
    if not symbols:
        return {}
    quotes: dict[str, dict] = {}
    for index in range(0, len(symbols), 30):
        chunk = symbols[index:index + 30]
        try:
            payload = fetch_json(quote_url(chunk))
            for item in payload.get("msgArray", []):
                code = str(item.get("c", "")).strip()
                if code in chunk:
                    quotes[code] = item
        except Exception as exc:
            print(f"realtime quote chunk failed {chunk}: {exc}")
        time.sleep(0.4)
    return quotes


def classify_symbol(symbol: str) -> str | None:
    if not symbol.isdigit():
        return None
    if symbol.startswith("00") and len(symbol) >= 4:
        return "ETF"
    if len(symbol) == 4:
        return "STOCK"
    return None


def fetch_top_universe() -> list[dict]:
    payload = fetch_json(twse_day_all_url())
    candidates: list[dict] = []
    rows = payload if isinstance(payload, list) else payload.get("data", [])
    for row in rows:
        if isinstance(row, dict):
            symbol = str(row.get("Code") or row.get("證券代號") or "").strip()
            name = str(row.get("Name") or row.get("證券名稱") or "").strip()
            trade_volume = parse_number(row.get("TradeVolume") or row.get("成交股數")) or 0
            trade_value = parse_number(row.get("TradeValue") or row.get("成交金額")) or 0
            close = parse_number(row.get("ClosingPrice") or row.get("收盤價"))
        else:
            if len(row) < 8:
                continue
            symbol = str(row[0]).strip()
            name = str(row[1]).strip()
            trade_volume = parse_number(row[2]) or 0
            trade_value = parse_number(row[3]) or 0
            close = parse_number(row[7])
        if not symbol:
            continue
        category = classify_symbol(symbol)
        if not category:
            continue
        if trade_value <= 0 or close is None:
            continue
        candidates.append(
            {
                "symbol": symbol,
                "name": name,
                "category": category,
                "tradeVolume": trade_volume,
                "tradeValue": trade_value,
                "snapshotClose": close,
            }
        )

    etfs = sorted((item for item in candidates if item["category"] == "ETF"), key=lambda item: item["tradeValue"], reverse=True)[:ETF_CANDIDATE_COUNT]
    stocks = sorted((item for item in candidates if item["category"] == "STOCK"), key=lambda item: item["tradeValue"], reverse=True)[:STOCK_CANDIDATE_COUNT]
    universe = etfs + stocks
    for rank, item in enumerate(etfs, start=1):
        item["rank"] = rank
    for rank, item in enumerate(stocks, start=1):
        item["rank"] = rank
    return universe


def load_existing_universe() -> list[dict]:
    if not UNIVERSE_FILE.exists():
        return []
    try:
        payload = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"existing universe is not usable: {exc}")
        return []
    symbols = payload.get("symbols", [])
    return symbols if isinstance(symbols, list) else []


def load_existing_payload(symbol: str) -> dict | None:
    path = OUTPUT_DIR / f"{symbol}.json"
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"existing payload is not usable for {symbol}: {exc}")
        return None
    bars = payload.get("bars", [])
    if not isinstance(bars, list) or not bars:
        return None
    payload["source"] = f"{payload.get('source', 'Previous GitHub Actions JSON')} + {FALLBACK_MARK}"
    payload["generatedAt"] = taipei_now_iso()
    return payload


def fetch_symbol_history(symbol: str, quote: dict | None) -> dict:
    try:
        return fetch_symbol_history_yahoo(symbol, quote)
    except Exception as yahoo_exc:
        print(f"Yahoo fallback to TWSE monthly for {symbol}: {yahoo_exc}")
    return fetch_symbol_history_twse(symbol, quote)


def merge_quote(records: dict[str, dict], quote: dict | None) -> None:
    if not quote:
        return
    price = quote_price(quote)
    open_price = parse_number(quote.get("o")) or price
    high = parse_number(quote.get("h")) or price
    low = parse_number(quote.get("l")) or price
    volume = parse_number(quote.get("v")) or 0
    date_value = str(quote.get("d") or "").strip()
    if len(date_value) == 8 and price is not None:
        date = f"{date_value[:4]}-{date_value[4:6]}-{date_value[6:8]}"
        records[date] = {
            "date": date,
            "open": open_price,
            "high": high,
            "low": low,
            "close": price,
            "volume": volume,
        }


def fetch_symbol_history_yahoo(symbol: str, quote: dict | None) -> dict:
    payload = fetch_json(yahoo_history_url(symbol))
    result = (payload.get("chart", {}).get("result") or [None])[0]
    if not result:
        raise RuntimeError(f"Yahoo returned no data for {symbol}")
    timestamps = result.get("timestamp") or []
    quote_data = (result.get("indicators", {}).get("quote") or [{}])[0]
    records: dict[str, dict] = {}
    for index, timestamp in enumerate(timestamps):
        open_price = quote_data.get("open", [None] * len(timestamps))[index]
        high = quote_data.get("high", [None] * len(timestamps))[index]
        low = quote_data.get("low", [None] * len(timestamps))[index]
        close = quote_data.get("close", [None] * len(timestamps))[index]
        volume = quote_data.get("volume", [0] * len(timestamps))[index]
        if None in (open_price, high, low, close):
            continue
        date = datetime.fromtimestamp(timestamp, tz=timezone.utc).astimezone().strftime("%Y-%m-%d")
        records[date] = {
            "date": date,
            "open": float(open_price),
            "high": float(high),
            "low": float(low),
            "close": float(close),
            "volume": float(volume or 0),
        }
    merge_quote(records, quote)
    bars = [records[key] for key in sorted(records)]
    if len(bars) < 150:
        raise RuntimeError(f"{symbol} Yahoo records insufficient: {len(bars)}")
    return {
        "symbol": symbol,
        "source": "Yahoo Finance history + TWSE MIS GitHub Actions snapshot",
        "generatedAt": taipei_now_iso(),
        "bars": bars[-260:],
    }


def fetch_symbol_history_twse(symbol: str, quote: dict | None) -> dict:
    records: dict[str, dict] = {}
    errors = []
    for month_start in recent_months(MONTH_COUNT):
        try:
            payload = fetch_json(twse_month_url(symbol, month_start))
            for row in payload.get("data", []):
                date = parse_roc_date(row[0])
                open_price = parse_number(row[3])
                high = parse_number(row[4])
                low = parse_number(row[5])
                close = parse_number(row[6])
                volume = parse_number(row[1])
                if not date or None in (open_price, high, low, close):
                    continue
                records[date] = {
                    "date": date,
                    "open": open_price,
                    "high": high,
                    "low": low,
                    "close": close,
                    "volume": volume or 0,
                }
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            errors.append(f"{month_start:%Y-%m}: {exc}")

    merge_quote(records, quote)

    bars = [records[key] for key in sorted(records)]
    if len(bars) < 150:
        raise RuntimeError(f"{symbol} valid records are insufficient: {len(bars)}; errors={errors}")

    return {
        "symbol": symbol,
        "source": "TWSE monthly history + TWSE MIS GitHub Actions snapshot",
        "generatedAt": taipei_now_iso(),
        "bars": bars[-260:],
    }


def cleanup_stale_files(active_symbols: set[str]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for path in OUTPUT_DIR.glob("*.json"):
        if path.stem not in active_symbols:
            path.unlink()


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    existing_universe = load_existing_universe()
    try:
        universe = fetch_top_universe()
    except Exception as exc:
        if not existing_universe:
            print(f"failed to fetch top universe and no existing universe is available: {exc}")
            return
        print(f"failed to fetch top universe; reusing existing universe: {exc}")
        universe = existing_universe
    symbols = [item["symbol"] for item in universe]
    quotes = fetch_realtime_quotes(symbols)
    def update_one(item: dict) -> tuple[dict | None, str | None]:
        symbol = item["symbol"]
        try:
            payload = fetch_symbol_history(symbol, quotes.get(symbol))
            (OUTPUT_DIR / f"{symbol}.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            latest = payload["bars"][-1]
            print(f"updated {symbol} {item['name']}: {len(payload['bars'])} records")
            return {
                **item,
                "latestClose": latest["close"],
                "latestDate": latest["date"],
                "updatedAt": payload["generatedAt"],
            }, None
        except Exception as exc:
            existing_payload = load_existing_payload(symbol)
            if existing_payload:
                latest = existing_payload["bars"][-1]
                (OUTPUT_DIR / f"{symbol}.json").write_text(
                    json.dumps(existing_payload, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                return {
                    **item,
                    "latestClose": latest.get("close"),
                    "latestDate": latest.get("date"),
                    "updatedAt": existing_payload["generatedAt"],
                    "stale": True,
                }, f"{symbol}: live update failed; reused previous JSON: {exc}"
            return None, f"{symbol}: {exc}"

    final_universe = []
    failures = []
    with ThreadPoolExecutor(max_workers=24) as executor:
        futures = [executor.submit(update_one, item) for item in universe]
        for future in as_completed(futures):
            item, failure = future.result()
            if item:
                final_universe.append(item)
            if failure:
                failures.append(failure)

    category_order = {"ETF": 0, "STOCK": 1}
    final_universe.sort(key=lambda item: (category_order.get(item["category"], 9), item["rank"]))
    final_etfs = [item for item in final_universe if item["category"] == "ETF"][:TOP_ETF_COUNT]
    final_stocks = [item for item in final_universe if item["category"] == "STOCK"][:TOP_STOCK_COUNT]
    final_universe = final_etfs + final_stocks
    if not final_universe:
        print("no symbols were updated; keeping previous repository data without failing workflow")
        return

    active_symbols = {item["symbol"] for item in final_universe}

    cleanup_stale_files(active_symbols)
    UNIVERSE_FILE.write_text(
        json.dumps(
            {
                "generatedAt": taipei_now_iso(),
                "rankBy": "tradeValue",
                "description": "Top 20 listed ETFs and top 20 listed stocks by TWSE trade value.",
                "symbols": final_universe,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    if failures:
        print("Failures:")
        for failure in failures:
            print(f"- {failure}")


if __name__ == "__main__":
    main()
