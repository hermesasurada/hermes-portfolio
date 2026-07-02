from __future__ import annotations

FX_TICKERS = (
    "USDKRW", "EURKRW", "JPYKRW", "CNYKRW", "TWDKRW",
    "GBPKRW", "CHFKRW", "CADKRW", "AUDKRW", "SGDKRW", "HKDKRW",
)
FX_NAMES = {
    "USDKRW": "달러/원",
    "EURKRW": "유로/원",
    "JPYKRW": "엔/원",
    "CNYKRW": "위안/원",
    "TWDKRW": "대만 달러/원",
    "GBPKRW": "파운드/원",
    "CHFKRW": "스위스 프랑/원",
    "CADKRW": "캐나다 달러/원",
    "AUDKRW": "호주 달러/원",
    "SGDKRW": "싱가포르 달러/원",
    "HKDKRW": "홍콩 달러/원",
}
FX_DEFAULT_RATES = {
    "USD": 1450.0,
    "EUR": 1700.0,
    "JPY": 9.3,
    "CNY": 205.0,
    "TWD": 47.0,
    "GBP": 1950.0,
    "CHF": 1800.0,
    "CAD": 1070.0,
    "AUD": 950.0,
    "SGD": 1130.0,
    "HKD": 185.0,
    "KRW": 1.0,
}
CRYPTO_MARKETS = {
    "BTC": {"name": "Bitcoin", "market": "KRW-BTC", "currency": "KRW"},
    "ETH": {"name": "이더리움", "market": "KRW-ETH", "currency": "KRW"},
    "SOL": {"name": "솔라나", "market": "KRW-SOL", "currency": "KRW"},
    "XRP": {"name": "리플", "market": "KRW-XRP", "currency": "KRW"},
    "DOGE": {"name": "도지코인", "market": "KRW-DOGE", "currency": "KRW"},
}

# 배당 조회 윈도우 — 과거 30일·미래 1년 (dividends/dividend_sources/dividend_schedule 공용)
DIVIDEND_LOOKBACK_DAYS = 30
DIVIDEND_LOOKAHEAD_DAYS = 365

KOREAN_SUFFIXES = (".KS", ".KQ")
LOCAL_MARKET_SUFFIXES = (".KS", ".KQ", ".T", ".TO", ".PA", ".DE", ".L", ".SW", ".AX", ".SI", ".HK")
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
    "NASDAQ": {"name": "NASDAQ 종합", "symbol": "^IXIC", "currency": "USD", "region": "US"},
    "NASDAQ100": {"name": "NASDAQ 100", "symbol": "^NDX", "currency": "USD", "region": "US"},
    "DOW": {"name": "Dow", "symbol": "^DJI", "currency": "USD", "region": "US"},
    "RUSSELL2000": {"name": "Russell 2000", "symbol": "^RUT", "currency": "USD", "region": "US"},
    "KOSPI": {"name": "KOSPI", "symbol": "KS11", "currency": "KRW", "region": "KR"},
    "NIKKEI225": {"name": "Nikkei 225", "symbol": "^N225", "currency": "JPY", "region": "JP"},
    "SHANGHAI": {"name": "Shanghai Composite", "symbol": "000001.SS", "currency": "CNY", "region": "CN"},
    "HANGSENG": {"name": "Hang Seng", "symbol": "^HSI", "currency": "HKD", "region": "HK"},
    "TAIWAN": {"name": "Taiwan Weighted", "symbol": "^TWII", "currency": "TWD", "region": "TW"},
    "NIFTY50": {"name": "Nifty 50", "symbol": "^NSEI", "currency": "INR", "region": "IN"},
    "FTSE100": {"name": "FTSE 100", "symbol": "^FTSE", "currency": "GBP", "region": "GB"},
    "DAX": {"name": "DAX", "symbol": "^GDAXI", "currency": "EUR", "region": "DE"},
    "CAC40": {"name": "CAC 40", "symbol": "^FCHI", "currency": "EUR", "region": "FR"},
    "EUROSTOXX50": {"name": "Euro Stoxx 50", "symbol": "^STOXX50E", "currency": "EUR", "region": "EU"},
}
