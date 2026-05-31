from __future__ import annotations

from pathlib import Path
from zoneinfo import ZoneInfo

DB_PATH = Path.home() / ".hermes" / "data" / "stock_history.db"
LOGO_DIR = Path.home() / ".hermes" / "data" / "portfolio_v2" / "logos"
PRICE_CACHE_PATH = Path.home() / ".hermes" / "data" / "portfolio_v2" / "price_cache.json"
KST = ZoneInfo("Asia/Seoul")
US_EASTERN = ZoneInfo("America/New_York")

