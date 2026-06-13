from __future__ import annotations

import re

from .constants import ETF_BRANDS, FX_TICKERS, KOREAN_SUFFIXES, MARKET_INDEXES, US_ETF_TICKERS


def ticker_currency(ticker: str) -> str:
    if ticker == "BTC":
        return "KRW"
    if ticker.endswith(KOREAN_SUFFIXES):
        return "KRW"
    if ticker.endswith((".PA", ".DE")):
        return "EUR"
    if ticker.endswith((".T", ".TO")):
        return "JPY"
    return "USD"


def currency_symbol(currency: str) -> str:
    return {"USD": "$", "EUR": "EUR ", "JPY": "JPY ", "KRW": "KRW "}.get(currency, f"{currency} ")


def is_korean_stock_ticker(ticker: str) -> bool:
    return ticker.endswith(KOREAN_SUFFIXES)


def kr_ticker_code(ticker: str) -> str:
    """'005930.KS' → '005930'. KRX 단축코드(6자리 영숫자)만 남긴다."""
    code = str(ticker or "").strip().upper()
    for suffix in KOREAN_SUFFIXES:
        code = code.removesuffix(suffix)
    return code


def is_us_stock_ticker(ticker: str, currency: str | None) -> bool:
    if currency != "USD":
        return False
    if ticker in FX_TICKERS:
        return False
    if ticker in MARKET_INDEXES:
        return False
    return "." not in ticker


def normalize_yfinance_symbol(ticker: str) -> str | None:
    if ticker == "BTC":
        return "BTC-KRW"
    if ticker in FX_TICKERS:
        return None
    if ticker in MARKET_INDEXES:
        return MARKET_INDEXES[ticker]["symbol"]
    return ticker


def account_label(member: str, account_type: str, account_name: str | None) -> str:
    if account_name:
        return account_name
    labels = {
        "overseas": "해외주식계좌",
        "pension_kr": "연금저축",
        "retirement_kr": "퇴직연금",
        "kr_individual": "한국개별주",
        "bitcoin": "비트코인",
    }
    return labels.get(account_type, f"{member} {account_type}")


def account_kind(account_type: str) -> str:
    return "pension" if account_type in {"pension_kr", "retirement_kr"} else "general"


def account_scope(account_type: str) -> str | None:
    """Which security family an account may hold. Single source of truth shared
    by transaction validation and the API/frontend. (#5)"""
    if account_type == "overseas":
        return "overseas"
    if account_type == "kr_individual":
        return "kr_stock"
    if account_type in {"pension_kr", "retirement_kr"}:
        return "kr_etf"
    if account_type == "bitcoin":
        return "crypto"
    return None


def ticker_scope(ticker: str, name: str, category: str | None, currency: str | None) -> str | None:
    upper_ticker = ticker.upper()
    if upper_ticker == "BTC" or category == "crypto":
        return "crypto"
    if category == "index":
        return None
    if category == "kr" or upper_ticker.endswith(KOREAN_SUFFIXES) or currency == "KRW":
        return "kr_etf" if asset_class(upper_ticker, name) == "etf" else "kr_stock"
    return "overseas"


def asset_class(ticker: str, name: str) -> str:
    if ticker == "BTC":
        return "crypto"
    upper_name = (name or "").upper()
    upper_ticker = ticker.upper()
    name_tokens = set(re.findall(r"[A-Z0-9]+", upper_name))
    if upper_ticker in US_ETF_TICKERS or any(token in name_tokens for token in ETF_BRANDS):
        return "etf"
    return "stock"
