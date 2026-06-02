import json
import ssl
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
TRACKED_SYMBOLS = ROOT / "data" / "tracked-symbols.json"
OUTPUT_DIR = ROOT / "data" / "stocks"
MONTH_COUNT = 14
SSL_CONTEXT = ssl._create_unverified_context()


def taipei_now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


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


def twse_url(symbol: str, month_start: datetime) -> str:
    params = urlencode(
        {
            "response": "json",
            "date": f"{month_start.year}{month_start.month:02d}01",
            "stockNo": symbol,
        }
    )
    return f"https://www.twse.com.tw/exchangeReport/STOCK_DAY?{params}"


def parse_number(value: str) -> float | None:
    cleaned = value.replace(",", "").replace("--", "").strip()
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


def fetch_json(url: str) -> dict:
    request = Request(
        url,
        headers={
            "User-Agent": "tw-stock-ai-web/1.0",
            "Accept": "application/json,text/plain,*/*",
        },
    )
    with urlopen(request, timeout=20, context=SSL_CONTEXT) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_symbol(symbol: str) -> dict:
    records = {}
    errors = []
    for month_start in recent_months(MONTH_COUNT):
        try:
            payload = fetch_json(twse_url(symbol, month_start))
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
        time.sleep(0.35)

    bars = [records[key] for key in sorted(records)]
    if len(bars) < 150:
        raise RuntimeError(f"{symbol} valid records are insufficient: {len(bars)}; errors={errors}")

    return {
        "symbol": symbol,
        "source": "TWSE GitHub Actions static JSON",
        "generatedAt": taipei_now_iso(),
        "bars": bars[-260:],
    }


def main() -> None:
    symbols = json.loads(TRACKED_SYMBOLS.read_text(encoding="utf-8"))
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    failures = []
    for symbol in symbols:
        clean_symbol = str(symbol).strip().upper().replace(".TW", "")
        if not clean_symbol.isdigit():
            failures.append(f"{symbol}: unsupported symbol")
            continue
        try:
            payload = fetch_symbol(clean_symbol)
            (OUTPUT_DIR / f"{clean_symbol}.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(f"updated {clean_symbol}: {len(payload['bars'])} records")
        except Exception as exc:
            failures.append(f"{clean_symbol}: {exc}")

    if failures:
        print("Failures:")
        for failure in failures:
            print(f"- {failure}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
