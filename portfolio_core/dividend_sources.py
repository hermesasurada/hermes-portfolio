from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from html import unescape
from pathlib import Path
from typing import Any

from .constants import DIVIDEND_LOOKAHEAD_DAYS, DIVIDEND_LOOKBACK_DAYS, KOREAN_SUFFIXES
from .dates import now_kst_text, parse_iso_date, positive_float, to_iso_text, today_kst
from .opendart_dividends import fetch_opendart_dividends, is_opendart_candidate
from .paths import KST
from .tickers import normalize_yfinance_symbol, ticker_currency

DIVIDEND_CACHE_HOURS = 24
NASDAQ_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.nasdaq.com",
    "Referer": "https://www.nasdaq.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
}
SEIBRO_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
}
STOCKANALYSIS_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
}
CURRENCY_SYMBOLS = {
    "$": "USD",
    "€": "EUR",
    "¥": "JPY",
    "₩": "KRW",
}


# 공용 헬퍼 위임 (중복 제거). 사이트별 포맷 파서는 아래에 그대로 둔다.
_today = today_kst
_now_text = now_kst_text
_date_text = to_iso_text
_parse_date = parse_iso_date
_float_value = positive_float


def _date_from_us_text(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return datetime.strptime(value.strip(), "%m/%d/%Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def _date_from_short_month_text(value: str | None) -> str | None:
    if not value:
        return None
    text = value.strip()
    if text.lower() in {"n/a", "na", "-", "—"}:
        return None
    for fmt in ("%Y-%m-%d", "%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _date_from_kr_text(value: str | None) -> str | None:
    if not value:
        return None
    text = value.strip()
    for fmt in ("%Y/%m/%d", "%Y.%m.%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _amount_from_text(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value)
    text = re.sub(r"[^0-9.\-]", "", text)
    return _float_value(text)


def _currency_from_amount_text(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return CURRENCY_SYMBOLS.get(text[:1], fallback)


def _fetch_text(url: str, headers: dict[str, str]) -> str:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=12) as resp:
        return resp.read().decode("utf-8", "ignore")


def _month_name_to_number(name: str) -> int | None:
    months = {
        "january": 1,
        "february": 2,
        "march": 3,
        "april": 4,
        "may": 5,
        "june": 6,
        "july": 7,
        "august": 8,
        "september": 9,
        "october": 10,
        "november": 11,
        "december": 12,
    }
    return months.get(name.lower())


def _date_from_english_text(month: str, day: str, year: str) -> str | None:
    month_number = _month_name_to_number(month)
    if not month_number:
        return None
    try:
        return date(int(year), month_number, int(day)).isoformat()
    except ValueError:
        return None


def _cache_due(fetched_at: str | None) -> bool:
    if not fetched_at:
        return True
    try:
        fetched = datetime.strptime(fetched_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST)
    except ValueError:
        return True
    return datetime.now(KST) - fetched > timedelta(hours=DIVIDEND_CACHE_HOURS)


# ── Polygon.io (미국 배당 권위 소스) ────────────────────────────────────────
# 무료 티어 분당 5콜 제한이라 호출을 자체 스로틀링한다. 선언일·기준일·미래
# 확정분까지 제공해 yahoo/stockanalysis/nasdaq 조합보다 풍부.
POLYGON_ENV_PATH = Path.home() / ".hermes" / "polygon.env"
POLYGON_MAX_PER_MIN = 5
POLYGON_DIVIDENDS_URL = "https://api.polygon.io/v3/reference/dividends"
_polygon_key_cache: str | None = None
_polygon_call_times: list[float] = []


def _polygon_api_key() -> str | None:
    global _polygon_key_cache
    if _polygon_key_cache is not None:
        return _polygon_key_cache or None
    key = os.environ.get("POLYGON_API_KEY", "").strip()
    if not key and POLYGON_ENV_PATH.exists():
        try:
            for line in POLYGON_ENV_PATH.read_text().splitlines():
                line = line.strip()
                if line.startswith("POLYGON_API_KEY="):
                    key = line.split("=", 1)[1].strip()
                    break
        except Exception:
            key = ""
    _polygon_key_cache = key
    return key or None


def _polygon_throttle() -> None:
    """분당 POLYGON_MAX_PER_MIN 콜을 넘지 않도록 필요한 만큼 대기 (배치 전용)."""
    now = time.monotonic()
    while _polygon_call_times and now - _polygon_call_times[0] >= 60:
        _polygon_call_times.pop(0)
    if len(_polygon_call_times) >= POLYGON_MAX_PER_MIN:
        wait = 60 - (now - _polygon_call_times[0]) + 0.5
        if wait > 0:
            time.sleep(wait)
        now = time.monotonic()
        while _polygon_call_times and now - _polygon_call_times[0] >= 60:
            _polygon_call_times.pop(0)
    _polygon_call_times.append(time.monotonic())


def _polygon_candidate(ticker: str) -> bool:
    return ticker_currency(ticker) == "USD" and "." not in ticker and ticker != "BTC"


def _polygon_attempt_due(ticker: str, status: str | None) -> bool:
    return bool(_polygon_api_key()) and _polygon_candidate(ticker) and "polygon" not in (status or "")


def _fetch_polygon_dividends(ticker: str) -> list[dict]:
    key = _polygon_api_key()
    if not key:
        return []
    params = urllib.parse.urlencode({"ticker": ticker, "limit": 1000, "apiKey": key})
    req = urllib.request.Request(
        f"{POLYGON_DIVIDENDS_URL}?{params}",
        headers={"Accept": "application/json", "User-Agent": "portfolio-dividends/1.0"},
    )
    _polygon_throttle()
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    events = []
    for row in data.get("results", []):
        ex_date = row.get("ex_dividend_date")
        if not ex_date:
            continue
        events.append({
            "ticker": ticker,
            "ex_date": ex_date,
            "pay_date": row.get("pay_date"),
            "declaration_date": row.get("declaration_date"),
            "record_date": row.get("record_date"),
            "amount": _float_value(row.get("cash_amount")),
            "currency": row.get("currency") or "USD",
            "source": "polygon",
        })
    return events


def _nasdaq_candidate(ticker: str) -> bool:
    return ticker_currency(ticker) == "USD" and "." not in ticker


def _stockanalysis_candidate(ticker: str) -> bool:
    return ticker_currency(ticker) == "USD" and "." not in ticker and ticker != "BTC"


def _seibro_candidate(ticker: str) -> bool:
    return ticker_currency(ticker) == "KRW" and ticker.upper().endswith(KOREAN_SUFFIXES)


def _nasdaq_attempt_due(ticker: str, status: str | None) -> bool:
    return _nasdaq_candidate(ticker) and "nasdaq" not in (status or "")


def _stockanalysis_attempt_due(ticker: str, status: str | None) -> bool:
    return _stockanalysis_candidate(ticker) and "stockanalysis" not in (status or "")


def _opendart_attempt_due(ticker: str, status: str | None) -> bool:
    return is_opendart_candidate(ticker) and "opendart" not in (status or "")


def _kr_history_attempt_due(ticker: str, status: str | None) -> bool:
    return _seibro_candidate(ticker) and "kr_history" not in (status or "")


def _fetch_nasdaq_dividends(ticker: str) -> list[dict]:
    url = f"https://api.nasdaq.com/api/quote/{ticker}/dividends?assetclass=stocks"
    headers = {
        **NASDAQ_HEADERS,
        "Referer": f"https://www.nasdaq.com/market-activity/stocks/{ticker.lower()}/dividend-history",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=12) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    rows = (((payload.get("data") or {}).get("dividends") or {}).get("rows") or [])
    events = []
    for row in rows:
        ex_date = _date_from_us_text(row.get("exOrEffDate"))
        amount = _amount_from_text(row.get("amount"))
        if not ex_date or amount is None:
            continue
        dividend_type = str(row.get("type") or "").lower()
        if dividend_type and "cash" not in dividend_type:
            continue
        events.append(
            {
                "ticker": ticker,
                "ex_date": ex_date,
                "pay_date": _date_from_us_text(row.get("paymentDate")),
                "amount": amount,
                "currency": row.get("currency") or "USD",
                "source": "nasdaq",
            }
        )
    return events


# ── KRX KIND: 한국 ETF 분배금 (SEIBRO 대체) ──────────────────────────────────
# SEIBRO selectCompanySchedule.do가 더 이상 분배일정 테이블을 주지 않아(타임아웃/
# 랜딩 페이지) KIND 'ETF이익금분배신고(분배금안내)' 공시에서 기준일·지급일·주당
# 분배금을 확정값으로 받는다. 종목명으로 분배금 공시를 찾고 → 일괄공시 문서를 열어
# → ISIN에 6자리 코드가 들어간 해당 종목 행을 뽑는다. 일괄공시 1건이 다수 ETF를
# 담으므로 문서는 접수번호(acptno) 기준으로 메모이즈해 종목 간 재사용한다.
KIND_BASE = "https://kind.krx.co.kr"
KIND_DISCLOSURE_URL = f"{KIND_BASE}/disclosure/disclosurebystocktype.do"
KIND_VIEWER_URL = f"{KIND_BASE}/common/disclsviewer.do"
KIND_ETF_ENTRY = f"{KIND_DISCLOSURE_URL}?method=searchDisclosureByStockTypeEtf"
KIND_HISTORY_LOOKBACK_DAYS = 200   # 최근 ~6개월 확정분(기준일·지급일·금액)
KIND_LOOKAHEAD_DAYS = 20           # 공시는 기준일 ~3영업일 전 → 임박 확정분 포착

_kind_opener_cache: list = []
_kind_doc_cache: dict[str, list[dict]] = {}


def _kind_opener():
    if not _kind_opener_cache:
        import http.cookiejar

        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        opener.addheaders = [("User-Agent", SEIBRO_HEADERS["User-Agent"])]
        try:
            opener.open(KIND_ETF_ENTRY, timeout=12).read()   # JSESSIONID 적재
        except Exception:
            pass
        _kind_opener_cache.append(opener)
    return _kind_opener_cache[0]


def _kind_form_post(url: str, params: dict, referer: str, timeout: int = 15) -> str:
    data = urllib.parse.urlencode(params, encoding="utf-8").encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Referer": referer,
            "X-Requested-With": "XMLHttpRequest",
        },
    )
    with _kind_opener().open(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def _kind_cells(row_html: str) -> list[str]:
    return [
        unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", cell))).strip()
        for cell in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row_html, re.DOTALL)
    ]


def _kind_distribution_acptnos(name: str, start: str, end: str) -> list[str]:
    html = _kind_form_post(
        KIND_DISCLOSURE_URL,
        {
            "method": "searchDisclosureByStockTypeEtfSub",
            "forward": "disclosurebystocktype_etf_sub",
            "etfIsuSrtNm": name,        # 정확한 종목명 단독 필터가 유일하게 동작(코드 필터는 0건)
            "reportNm": "분배금",
            "fromDate": start,
            "toDate": end,
            "currentPageSize": "100",
            "pageIndex": "1",
            "orderMode": "1",
            "orderStat": "D",
        },
        referer=KIND_ETF_ENTRY,
    )
    acptnos: list[str] = []
    for match in re.finditer(r"openDisclsViewer\('(\d{14})'", html):
        if match.group(1) not in acptnos:
            acptnos.append(match.group(1))
    return acptnos


def _kind_document_rows(acptno: str) -> list[dict]:
    """일괄공시 문서 → [{isin,name,record_date,pay_date,amount}]. acptno 기준 메모이즈."""
    if acptno in _kind_doc_cache:
        return _kind_doc_cache[acptno]
    rows: list[dict] = []
    try:
        opener = _kind_opener()
        viewer = opener.open(
            f"{KIND_VIEWER_URL}?method=search&acptno={acptno}&docno=&viewerhost=&viewerport=",
            timeout=15,
        ).read().decode("utf-8", "replace")
        doc_nos = [n for n in dict.fromkeys(re.findall(r"\d{14}", viewer)) if n != acptno]
        for doc_no in doc_nos:
            stub = _kind_form_post(
                KIND_VIEWER_URL,
                {"method": "searchContents", "docNo": doc_no, "acptNo": acptno, "viewerHost": "", "viewerPort": ""},
                referer=KIND_VIEWER_URL,
            )
            path = re.search(r"setPath\('[^']*','([^']+\.html?)'", stub)
            if not path:
                continue
            doc_url = path.group(1)
            if doc_url.startswith("/"):
                doc_url = KIND_BASE + doc_url
            raw = opener.open(
                urllib.request.Request(doc_url, headers={"Referer": KIND_VIEWER_URL}), timeout=15
            ).read()
            text = None
            for enc in ("utf-8", "euc-kr", "cp949"):
                try:
                    text = raw.decode(enc)
                    break
                except Exception:
                    continue
            if text is None:
                continue
            for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", text, re.DOTALL):
                cells = _kind_cells(tr)
                # 행 구조: ISIN · 종목약명 · 지급기준일 · 지급예정일 · 분배금(원) · 기타
                if len(cells) >= 5 and re.match(r"KR[0-9A-Z]{10}", cells[0]):
                    rows.append({
                        "isin": cells[0],
                        "name": cells[1],
                        "record_date": _date_from_kr_text(cells[2]),
                        "pay_date": _date_from_kr_text(cells[3]),
                        "amount": _amount_from_text(cells[4]),
                    })
    except Exception as exc:
        print(f"[dividends] {acptno} kind-doc failed: {type(exc).__name__}: {exc}")
    _kind_doc_cache[acptno] = rows
    return rows


_KRX_SHORT_CODE = re.compile(r"[0-9A-Z]{6}")   # 신규 ETF는 0167Z0처럼 영숫자 단축코드


def _kind_candidate(ticker: str) -> bool:
    return _seibro_candidate(ticker) and bool(_KRX_SHORT_CODE.fullmatch(ticker.split(".", 1)[0].upper()))


def _kind_attempt_due(ticker: str, status: str | None) -> bool:
    return _kind_candidate(ticker) and "kind" not in (status or "")


def _fetch_kind_etf_dividends(ticker: str, name: str | None) -> list[dict]:
    code = ticker.split(".", 1)[0].upper()
    if not name or not _KRX_SHORT_CODE.fullmatch(code):
        return []
    today = _today()
    start = (today - timedelta(days=KIND_HISTORY_LOOKBACK_DAYS)).isoformat()
    end = (today + timedelta(days=KIND_LOOKAHEAD_DAYS)).isoformat()
    try:
        from .dividend_schedule import previous_kr_business_day
    except Exception:
        previous_kr_business_day = None

    events: dict[str, dict] = {}
    for acptno in _kind_distribution_acptnos(name, start, end):
        for row in _kind_document_rows(acptno):
            if code not in row["isin"] or row["amount"] is None or not row["record_date"]:
                continue
            record = date.fromisoformat(row["record_date"])
            # yfinance 관례에 맞춰 ex_date = 배당기준일 직전 영업일 (병합 시 정렬·중복억제).
            ex = previous_kr_business_day(record) if previous_kr_business_day else record
            ex_text = ex.isoformat()
            events[ex_text] = {
                "ticker": ticker,
                "ex_date": ex_text,
                "record_date": row["record_date"],
                "pay_date": row["pay_date"],
                "amount": row["amount"],
                "currency": "KRW",
                "source": "kind",
            }
    return sorted(events.values(), key=lambda event: event["ex_date"])


def _stockanalysis_urls(ticker: str) -> tuple[str, ...]:
    symbol = ticker.lower()
    return (
        f"https://stockanalysis.com/stocks/{symbol}/dividend/",
        f"https://stockanalysis.com/etf/{symbol}/dividend/",
    )


def _js_string_field(text: str, key: str) -> str | None:
    match = re.search(rf"{re.escape(key)}:\"((?:\\.|[^\"])*)\"", text)
    if not match:
        return None
    return bytes(match.group(1), "utf-8").decode("unicode_escape")


def _fetch_stockanalysis_dividends(ticker: str) -> list[dict]:
    fallback_currency = ticker_currency(ticker)
    html = ""
    for url in _stockanalysis_urls(ticker):
        try:
            html = _fetch_text(url, STOCKANALYSIS_HEADERS)
            if "history:[" in html:
                break
        except Exception:
            continue
    if "history:[" not in html:
        return []

    block_match = re.search(r"history:\[(.*?)\],chartData:", html, re.DOTALL)
    if not block_match:
        return []
    events = []
    for row_match in re.finditer(r"\{([^{}]+)\}", block_match.group(1)):
        row = row_match.group(1)
        ex_date = _date_from_short_month_text(_js_string_field(row, "dt"))
        amount_text = _js_string_field(row, "amt")
        amount = _amount_from_text(amount_text)
        if not ex_date or amount is None:
            continue
        events.append(
            {
                "ticker": ticker,
                "ex_date": ex_date,
                "pay_date": _date_from_short_month_text(_js_string_field(row, "pay")),
                "amount": amount,
                "currency": _currency_from_amount_text(amount_text, fallback_currency),
                "source": "stockanalysis",
            }
        )
    return events


def _fetch_yahoo_dividends(ticker: str) -> list[dict]:
    import yfinance as yf

    symbol = normalize_yfinance_symbol(ticker) or ticker
    stock = yf.Ticker(symbol)
    currency = ticker_currency(ticker)
    events: dict[str, dict] = {}

    # 배당 상세 팝업은 최근 10년 이력만 보여준다. 18개월은 너무 짧고,
    # max는 불필요하게 오래된 분할/배당 이력을 끌어온다.
    hist = stock.history(period="10y", actions=True)
    if hist is not None and not hist.empty and "Dividends" in hist:
        dividends = hist[hist["Dividends"].fillna(0) > 0]["Dividends"]
        for idx, amount in dividends.items():
            ex_date = _date_text(idx)
            amount_value = _float_value(amount)
            if ex_date and amount_value:
                events[ex_date] = {
                    "ticker": ticker,
                    "ex_date": ex_date,
                    "pay_date": None,
                    "amount": amount_value,
                    "currency": currency,
                    "source": "yf-history",
                }

    try:
        calendar = stock.calendar or {}
    except Exception:
        calendar = {}
    ex_date = _date_text(calendar.get("Ex-Dividend Date"))
    pay_date = _date_text(calendar.get("Dividend Date"))
    if ex_date:
        last_amount = None
        if events:
            last_amount = events[sorted(events)[-1]].get("amount")
        event = events.get(ex_date) or {
            "ticker": ticker,
            "ex_date": ex_date,
            "amount": last_amount,
            "currency": currency,
            "source": "yf-calendar",
        }
        event["pay_date"] = pay_date or event.get("pay_date")
        event["source"] = "yf-calendar"
        events[ex_date] = event

    return list(events.values())


def _source_error(source: str, ticker: str, exc: Exception) -> str:
    """소스별 수집 실패를 상태문자열+로그 한 줄로 남긴다 (launchd 로그로 추적 가능).
    상태는 'xxx_error(TypeName)' 형태 — 진단의 LIKE '%_error%' 매칭 유지."""
    print(f"[dividends] {ticker} {source} failed: {type(exc).__name__}: {exc}")
    return f"{source}_error({type(exc).__name__})"


def _fetch_dividends(ticker: str, name: str | None = None) -> tuple[list[dict], str]:
    events: dict[str, dict] = {}
    sources = []
    if _seibro_candidate(ticker):
        # OpenDART(현금배당결정 공시) = 한국 배당 권위 소스. 확정 주당배당금·
        # 배당기준일·지급예정일을 먼저 깔고(미래 확정분 포함), SEIBRO/yfinance는
        # OpenDART와 ±4일 내 겹치지 않는 ex_date만 보강(중복 방지).
        opendart_ex_dates: list[date] = []
        if is_opendart_candidate(ticker):
            try:
                opendart_events = fetch_opendart_dividends(ticker)
                sources.append("opendart" if opendart_events else "opendart0")
                for event in opendart_events:
                    if event.get("ex_date"):
                        events[event["ex_date"]] = event
                        try:
                            opendart_ex_dates.append(date.fromisoformat(event["ex_date"]))
                        except ValueError:
                            pass
            except Exception as exc:
                sources.append(_source_error("opendart", ticker, exc))

        def _near_opendart(ex_date_text: str) -> bool:
            if not opendart_ex_dates:
                return False
            try:
                d = date.fromisoformat(ex_date_text)
            except ValueError:
                return False
            return any(abs((d - od).days) <= 4 for od in opendart_ex_dates)

        # KIND ETF 분배금 공시 = ETF 권위 소스(기준일·지급일·주당분배금 확정값).
        # SEIBRO 대체. opendart와 ±4일 내 겹치지 않는 ex_date만 덮어쓴다.
        kind_ex_dates: list[date] = []
        try:
            kind_events = _fetch_kind_etf_dividends(ticker, name)
            sources.append("kind" if kind_events else "kind0")
            for event in kind_events:
                ex = event.get("ex_date")
                if ex and not _near_opendart(ex):
                    events[ex] = event
                    try:
                        kind_ex_dates.append(date.fromisoformat(ex))
                    except ValueError:
                        pass
        except Exception as exc:
            sources.append(_source_error("kind", ticker, exc))

        def _near_kind(ex_date_text: str) -> bool:
            if not kind_ex_dates:
                return False
            try:
                d = date.fromisoformat(ex_date_text)
            except ValueError:
                return False
            return any(abs((d - kd).days) <= 4 for kd in kind_ex_dates)

        try:
            history_events = [
                event for event in _fetch_yahoo_dividends(ticker)
                if event.get("source") == "yf-history" and event.get("amount") is not None
            ]
            sources.append("kr_history" if history_events else "kr_history0")
            for event in history_events:
                ex = event.get("ex_date")
                # KIND 윈도 밖(과거)만 yfinance로 보강 — 최근분은 KIND가 권위.
                if ex and not _near_opendart(ex) and not _near_kind(ex):
                    events.setdefault(ex, {
                        **event,
                        "source": "kr-history",
                    })
        except Exception as exc:
            sources.append(_source_error("kr_history", ticker, exc))
    else:
        try:
            yahoo_events = _fetch_yahoo_dividends(ticker)
            if yahoo_events:
                sources.append("yahoo")
            for event in yahoo_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception as exc:
            sources.append(_source_error("yahoo", ticker, exc))

    if _stockanalysis_candidate(ticker):
        try:
            stockanalysis_events = _fetch_stockanalysis_dividends(ticker)
            sources.append("stockanalysis" if stockanalysis_events else "stockanalysis0")
            for event in stockanalysis_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception as exc:
            sources.append(_source_error("stockanalysis", ticker, exc))

    if _nasdaq_candidate(ticker):
        try:
            nasdaq_events = _fetch_nasdaq_dividends(ticker)
            sources.append("nasdaq" if nasdaq_events else "nasdaq0")
            for event in nasdaq_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception as exc:
            sources.append(_source_error("nasdaq", ticker, exc))

    # Polygon: 권위 소스이므로 마지막에 같은 ex_date를 덮어써 선언일/기준일/미래
    # 확정분까지 채운다. (분당 5콜 스로틀은 _fetch_polygon_dividends 내부 처리)
    if _polygon_candidate(ticker) and _polygon_api_key():
        try:
            polygon_events = _fetch_polygon_dividends(ticker)
            sources.append("polygon" if polygon_events else "polygon0")
            for event in polygon_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception as exc:
            sources.append(_source_error("polygon", ticker, exc))

    return list(events.values()), "+".join(sources) or "none"
