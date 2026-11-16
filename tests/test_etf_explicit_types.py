"""구성종목 대상 판정은 관심목록의 개별주/ETF 구분을 이름 추정보다 먼저 본다(2026-11-16 사용자 지시).
1489.T처럼 영문명에 'ETF'가 없는 일본 ETF가 개별주로 잡혀 구성종목 수집·팝업에서 빠졌다."""
from portfolio_core import etf_holdings as E

E._cache = lambda: {}
E._leveraged_group = lambda: set()
E._explicit_types = lambda: {"1489.T": "etf", "XETF": "stock"}
JP_NAME = "NEXT FUNDS Nikkei 225 High Dividend Yield Stock 50 Index Exchange Traded Fd"
assert E.etf_holdings_available("1489.T", JP_NAME) is True          # 이름으로는 개별주지만 구분은 ETF
assert E.etf_holdings_available("XETF", "Something ETF") is False   # 구분이 개별주면 이름이 ETF여도 아님
assert E.etf_holdings_available("SPY", "SPDR S&P 500 ETF Trust") is True   # 구분 없으면 이름 추정
assert E.etf_holdings_available("AAPL", "Apple Inc.") is False

# 구분을 못 읽으면 이름 추정으로 돌아간다(본업을 막지 않음)
import portfolio_core.interest_watchlists as W
real = W.explicit_asset_types
W.explicit_asset_types = lambda: (_ for _ in ()).throw(RuntimeError("db"))
del E._explicit_types
import importlib
E2 = importlib.reload(E)
E2._cache = lambda: {}
E2._leveraged_group = lambda: set()
assert E2._explicit_types() == {}
W.explicit_asset_types = real
print("etf explicit type checks passed")
