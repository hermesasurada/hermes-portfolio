from __future__ import annotations

FX_TICKERS = ("USDKRW", "EURKRW", "JPYKRW")
FX_DEFAULT_RATES = {
    "USD": 1450.0,
    "EUR": 1700.0,
    "JPY": 9.3,
    "KRW": 1.0,
}

KOREAN_SUFFIXES = (".KS", ".KQ")
LOCAL_MARKET_SUFFIXES = (".KS", ".KQ", ".T", ".TO", ".PA", ".DE")
ETF_BRANDS = ("KODEX", "TIGER", "ACE", "SOL", "ETF", "ETN", "QQQ")
KOREAN_ETF_BRANDS = ("KODEX", "TIGER", "ACE", "SOL")
# US ETF tickers that carry no obvious name token (used by asset_class).
US_ETF_TICKERS = frozenset(
    {
        "QLD", "TSLL", "TQQQ", "SQQQ", "SOXL", "SOXS", "SPY", "VOO", "VTI",
        "IVV", "QQQ", "DIA", "IWM", "ARKK", "ARKG", "SCHD",
        "1629.T", "200A.T",
    }
)
MARKET_INDEXES = {
    "SP500": {"name": "S&P 500", "symbol": "^GSPC", "currency": "USD", "region": "US"},
    "NASDAQ": {"name": "NASDAQ Composite", "symbol": "^IXIC", "currency": "USD", "region": "US"},
    "KOSPI": {"name": "KOSPI", "symbol": "KS11", "currency": "KRW", "region": "KR"},
}
