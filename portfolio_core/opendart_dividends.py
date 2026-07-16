"""OpenDART(금융감독원 전자공시) 기반 한국 종목 배당 소스.

미국의 Polygon에 대응하는 한국 배당 "권위 소스". KRX 수시공시 중
'현금ㆍ현물배당결정'(pblntf_ty=I) 공시 문서를 파싱해 **주당 현금배당금 +
배당기준일(record) + 지급예정일(pay)** 을 확정값으로 가져온다. 선언 즉시
올라오므로 미래 확정 배당까지 잡힌다(SEIBRO 빈 종목·미래분 보강).

흐름: 종목코드 → corp_code(고유번호) → list.json(현금배당결정 검색) →
document.xml(공시 원문 파싱). corp_code 매핑은 corpCode.xml(zip)을 받아
로컬 JSON으로 캐시한다.

API 키: 환경변수 OPENDART_API_KEY 또는 ~/.hermes/opendart.env. (cron 안전)
호출 한도: 20,000건/일 — 문서 호출 사이 소폭 페이싱만 둔다.
"""
from __future__ import annotations

import io
import json
import os
import re
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

from .paths import KST, LOGO_DIR
from .tickers import kr_ticker_code

OPENDART_ENV_PATH = Path.home() / ".hermes" / "opendart.env"
CORP_CODE_CACHE = LOGO_DIR.parent / "dart_corpcodes.json"
CORP_CODE_TTL_DAYS = 7
LIST_LOOKBACK_DAYS = 550          # ~18개월 (직전 결산 + 분기 배당 포괄)
_API = "https://opendart.fss.or.kr/api"
_DOC_PACING_SECONDS = 0.05

_key_cache: str | None = None
_corp_map_cache: dict[str, str] | None = None


def _api_key() -> str | None:
    global _key_cache
    if _key_cache is not None:
        return _key_cache or None
    key = os.environ.get("OPENDART_API_KEY", "").strip()
    if not key and OPENDART_ENV_PATH.exists():
        try:
            for line in OPENDART_ENV_PATH.read_text().splitlines():
                line = line.strip()
                if line.startswith("OPENDART_API_KEY="):
                    key = line.split("=", 1)[1].strip()
                    break
        except Exception:
            key = ""
    _key_cache = key
    return key or None


def _get(url: str, timeout: float = 25.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "portfolio-dividends/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _refresh_corp_codes(key: str) -> dict[str, str]:
    raw = _get(f"{_API}/corpCode.xml?crtfc_key={key}")
    zf = zipfile.ZipFile(io.BytesIO(raw))
    xml = zf.read(zf.namelist()[0]).decode("utf-8", "replace")
    mapping: dict[str, str] = {}
    # <list><corp_code>..</corp_code><stock_code>..</stock_code></list>
    for block in re.findall(r"<list>(.*?)</list>", xml, flags=re.S):
        sc = re.search(r"<stock_code>\s*(\d{6})\s*</stock_code>", block)
        cc = re.search(r"<corp_code>\s*(\d{8})\s*</corp_code>", block)
        if sc and cc:
            mapping[sc.group(1)] = cc.group(1)
    if mapping:
        try:
            CORP_CODE_CACHE.parent.mkdir(parents=True, exist_ok=True)
            CORP_CODE_CACHE.write_text(json.dumps(mapping, ensure_ascii=False))
        except Exception:
            pass
    return mapping


def _corp_map() -> dict[str, str]:
    global _corp_map_cache
    if _corp_map_cache is not None:
        return _corp_map_cache
    key = _api_key()
    if not key:
        _corp_map_cache = {}
        return _corp_map_cache
    # 신선한 캐시가 있으면 사용
    try:
        if CORP_CODE_CACHE.exists():
            age_days = (time.time() - CORP_CODE_CACHE.stat().st_mtime) / 86400
            if age_days < CORP_CODE_TTL_DAYS:
                _corp_map_cache = json.loads(CORP_CODE_CACHE.read_text())
                return _corp_map_cache
    except Exception as exc:
        print(f"[dividends] OpenDART corp-code cache read failed: {type(exc).__name__}: {exc}")
    try:
        _corp_map_cache = _refresh_corp_codes(key)
    except Exception as exc:
        print(f"[dividends] OpenDART corp-code refresh failed: {type(exc).__name__}: {exc}")
        # 갱신 실패 시 기존 캐시라도 사용
        try:
            _corp_map_cache = json.loads(CORP_CODE_CACHE.read_text()) if CORP_CODE_CACHE.exists() else {}
        except Exception as cache_exc:
            print(f"[dividends] OpenDART corp-code fallback failed: {type(cache_exc).__name__}: {cache_exc}")
            _corp_map_cache = {}
    return _corp_map_cache


_stock_code = kr_ticker_code   # 공용 헬퍼 위임


def is_opendart_candidate(ticker: str) -> bool:
    if not _api_key():
        return False
    code = _stock_code(ticker)
    return bool(re.fullmatch(r"\d{6}", code)) and code in _corp_map()


def _prev_business_day(d: date) -> date:
    d -= timedelta(days=1)
    while d.weekday() >= 5:  # 토(5)·일(6) 건너뜀
        d -= timedelta(days=1)
    return d


def _parse_decision(rcept_no: str) -> dict | None:
    """현금ㆍ현물배당결정 공시 원문에서 배당 정보 추출."""
    key = _api_key()
    raw = _get(f"{_API}/document.xml?crtfc_key={key}&rcept_no={urllib.parse.quote(rcept_no)}")
    zf = zipfile.ZipFile(io.BytesIO(raw))
    xml = zf.read(zf.namelist()[0]).decode("utf-8", "replace")
    text = re.sub(r"<[^>]+>", " ", xml)
    text = re.sub(r"[ \t\xa0]+", " ", text)

    def grab(pattern: str) -> str | None:
        m = re.search(pattern, text)
        return m.group(1).strip() if m else None

    jong = grab(r"배당종류\s*([가-힣]+배당)")
    if jong and "현금" not in jong:  # 주식배당 등은 제외
        return None
    amount_text = grab(r"1주당 배당금\(원\)\s*보통주식\s*([\d,]+)")
    record = grab(r"배당기준일\s*(\d{4}-\d{2}-\d{2})")
    pay = grab(r"배당금지급 예정일자\s*(\d{4}-\d{2}-\d{2})")
    if not amount_text or not record:
        return None
    try:
        amount = float(amount_text.replace(",", ""))
    except ValueError:
        return None
    if amount <= 0:
        return None
    return {"amount": amount, "record": record, "pay": pay}


def fetch_opendart_dividends(ticker: str) -> list[dict]:
    key = _api_key()
    if not key:
        return []
    code = _stock_code(ticker)
    corp_code = _corp_map().get(code)
    if not corp_code:
        return []
    today = datetime.now(KST).date()
    bgn = (today - timedelta(days=LIST_LOOKBACK_DAYS)).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")
    list_url = (
        f"{_API}/list.json?crtfc_key={key}&corp_code={corp_code}"
        f"&bgn_de={bgn}&end_de={end}&pblntf_ty=I&page_count=100"
    )
    data = json.loads(_get(list_url).decode("utf-8"))
    if data.get("status") != "000":
        return []
    filings = [
        x for x in data.get("list", [])
        if "현금ㆍ현물배당결정" in (x.get("report_nm") or "")
    ]
    # 같은 배당(배당기준일)의 정정은 최신 접수건이 우선 → record_date별 최신만
    by_record: dict[str, dict] = {}
    for filing in sorted(filings, key=lambda x: x.get("rcept_dt") or "", reverse=True):
        time.sleep(_DOC_PACING_SECONDS)
        info = _parse_decision(filing["rcept_no"])
        if not info:
            continue
        record = info["record"]
        if record in by_record:  # 이미 더 최신 접수건 처리됨
            continue
        rcept_dt = filing.get("rcept_dt") or ""
        declaration = f"{rcept_dt[:4]}-{rcept_dt[4:6]}-{rcept_dt[6:8]}" if len(rcept_dt) == 8 else None
        by_record[record] = {**info, "declaration": declaration}

    events = []
    for record, info in by_record.items():
        try:
            ex_date = _prev_business_day(date.fromisoformat(record))
        except ValueError:
            continue
        events.append({
            "ticker": ticker,
            "ex_date": ex_date.isoformat(),
            "pay_date": info.get("pay"),
            "amount": info["amount"],
            "currency": "KRW",
            "source": "opendart",
            "declaration_date": info.get("declaration"),
            "record_date": record,
        })
    return events
