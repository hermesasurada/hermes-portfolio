#!/usr/bin/env python3
"""Portfolio V2 Manager — multi-account, multi-currency portfolio tracking."""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance not installed. Run: pip install yfinance")
    sys.exit(1)

# 공통 캐시 유틸리티
sys.path.insert(0, str(Path(__file__).parent))
from price_cache_utils import (
    ticker_currency as _ticker_currency_util,
)

DB_PATH = Path.home() / ".hermes" / "data" / "stock_history.db"
KST = ZoneInfo("Asia/Seoul")

MEMBER_ALIASES = {
    "wife": "claire",
    "son": "henry",
}


def normalize_member(member: str | None) -> str | None:
    """Normalize legacy CLI aliases to DB member keys."""
    if member is None:
        return None
    key = member.lower()
    return MEMBER_ALIASES.get(key, key)


def holding_category(ticker: str) -> str:
    if ticker == "BTC":
        return "crypto"
    if ticker.endswith((".KS", ".KQ")):
        return "kr"
    if ticker in {"USDKRW", "EURKRW", "JPYKRW"}:
        return "fx"
    return "overseas"


def db_available() -> bool:
    if not DB_PATH.exists():
        return False
    try:
        import sqlite3
        conn = sqlite3.connect(str(DB_PATH))
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('accounts','holdings')"
        ).fetchall()
        conn.close()
        return len(rows) == 2
    except Exception:
        return False


# ── Helpers ───────────────────────────────────────────────────────────────

def load_holdings():
    """DB에서 holdings 정보를 읽어 표시용 dict로 반환."""
    if not db_available():
        raise RuntimeError(f"Portfolio DB is unavailable: {DB_PATH}")
    
    import sqlite3
    conn = sqlite3.connect(str(DB_PATH))
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT a.id, a.member, a.account_type, a.currency, a.region, a.name
        FROM accounts a
    """)
    accounts_raw = cursor.fetchall()
    
    cursor.execute("""
        SELECT h.account_id, h.ticker, h.name, h.qty, h.avg_price, h.currency, h.invested, h.notes
        FROM holdings h
    """)
    holdings_raw = cursor.fetchall()
    
    conn.close()
    
    result = {"members": {}, "standalone": {}}
    member_accounts = {}
    
    for acc_id, member_name, acc_type, currency, region, acc_name in accounts_raw:
        member_key = member_name.lower()
        if member_key == "standalone":
            result["standalone"][acc_type] = {
                "name": acc_name or acc_type,
                "exchange": "업비트" if acc_type == "bitcoin" else "",
                "currency": currency,
                "holdings": []
            }
            member_accounts[acc_id] = ("standalone", acc_type)
            continue
        if member_key not in result["members"]:
            result["members"][member_key] = {
                "name": member_name,
                "accounts": {}
            }
        result["members"][member_key]["accounts"][acc_type] = {
            "name": acc_name or acc_type,
            "region": region,
            "currency": currency,
            "holdings": []
        }
        member_accounts[acc_id] = (member_key, acc_type)
    
    for acc_id, ticker, name, qty, avg_price, currency, invested, notes in holdings_raw:
        if acc_id in member_accounts:
            member_key, acc_type = member_accounts[acc_id]
            holding = {
                "ticker": ticker,
                "name": name,
                "qty": qty,
                "avg_price": avg_price,
                "invested": invested,
                "currency": currency,
                "added_date": notes
            }
            if member_key == "standalone":
                result["standalone"][acc_type]["holdings"].append(holding)
            else:
                result["members"][member_key]["accounts"][acc_type]["holdings"].append(holding)
    
    return result


def _find_account(conn, member: str, account: str):
    member = normalize_member(member)
    row = conn.execute(
        """
        SELECT a.id, a.member, a.account_type, a.currency
        FROM accounts a
        WHERE lower(a.member) = ? AND a.account_type = ?
        """,
        (member, account),
    ).fetchone()
    return row


def _ensure_ticker(conn, ticker: str, name: str, currency: str):
    category = holding_category(ticker)
    try:
        conn.execute(
            """
            INSERT INTO tickers (ticker, name, region, currency, added_date, category)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
                name = COALESCE(NULLIF(excluded.name, ''), tickers.name),
                currency = COALESCE(NULLIF(excluded.currency, ''), tickers.currency),
                category = COALESCE(tickers.category, excluded.category)
            """,
            (
                ticker,
                name,
                "KR" if category == "kr" else "US",
                currency,
                datetime.now().strftime("%Y-%m-%d"),
                category,
            ),
        )
    except Exception:
        pass


def _log_transaction_db(conn, member_name, account_id, ticker, side, qty, price, currency, note=""):
    conn.execute(
        """
        INSERT INTO transactions
          (trade_date, member, account_id, ticker, side, qty, price, currency, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            datetime.now(KST).strftime("%Y-%m-%d"),
            member_name,
            account_id,
            ticker,
            side,
            qty,
            price,
            currency,
            note,
            datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S"),
        ),
    )


def _db_add_position(member, account, ticker, name, qty, price, currency=None, note=""):
    import sqlite3
    member = normalize_member(member)
    ticker = ticker.upper()
    inferred_currency = _ticker_currency(ticker)
    currency = inferred_currency if not currency or currency == "USD" and inferred_currency != "USD" else currency
    invested = qty * price

    with sqlite3.connect(str(DB_PATH)) as conn:
        row = _find_account(conn, member, account)
        if not row:
            print(f"  ✗ 계좌 없음: {member} / {account}")
            return
        account_id, member_name, account_type, account_currency = row
        existing = conn.execute(
            "SELECT id, qty, avg_price, invested FROM holdings WHERE account_id = ? AND ticker = ?",
            (account_id, ticker),
        ).fetchone()

        if existing:
            holding_id, old_qty, old_avg, old_invested = existing
            total_qty = old_qty + qty
            if total_qty <= 0:
                print(f"  ✗ 추가 후 수량이 0 이하입니다: {ticker}")
                return
            new_avg = ((old_avg * old_qty) + invested) / total_qty
            new_invested = (old_invested or old_avg * old_qty) + invested
            conn.execute(
                """
                UPDATE holdings
                SET member = ?, qty = ?, avg_price = ?, invested = ?, name = ?, currency = ?,
                    notes = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (member_name, total_qty, round(new_avg, 2), round(new_invested, 0), name, currency, note or datetime.now().strftime("%Y-%m-%d"), holding_id),
            )
            print(f"  {ticker} 추가: 총 {total_qty}주 (평균가 {new_avg:,.2f}{currency})")
        else:
            conn.execute(
                """
                INSERT INTO holdings
                  (member, account_id, ticker, name, qty, avg_price, currency, invested, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (member_name, account_id, ticker, name, qty, round(price, 2), currency, round(invested, 0), note or datetime.now().strftime("%Y-%m-%d")),
            )
            print(f"  {ticker} 추가: {qty}주 @ {price:,.2f}{currency}")

        _ensure_ticker(conn, ticker, name, currency)
        _log_transaction_db(conn, member_name, account_id, ticker, "BUY", qty, price, currency, note)


def _db_remove_position(member, account, ticker, qty=None):
    import sqlite3
    member = normalize_member(member)
    ticker = ticker.upper()

    with sqlite3.connect(str(DB_PATH)) as conn:
        row = _find_account(conn, member, account)
        if not row:
            print(f"  ✗ 계좌 없음: {member} / {account}")
            return
        account_id, member_name, account_type, account_currency = row
        holding = conn.execute(
            "SELECT id, qty, avg_price, currency FROM holdings WHERE account_id = ? AND ticker = ?",
            (account_id, ticker),
        ).fetchone()
        if not holding:
            print(f"  ✗ 보유 종목 없음: {ticker}")
            return

        holding_id, old_qty, avg_price, currency = holding
        sell_qty = old_qty if qty is None or qty >= old_qty else qty
        if qty is None or qty >= old_qty:
            conn.execute("DELETE FROM holdings WHERE id = ?", (holding_id,))
            print(f"  {ticker} 전체 제거")
        else:
            new_qty = old_qty - qty
            conn.execute(
                """
                UPDATE holdings
                SET qty = ?, invested = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (new_qty, round(new_qty * avg_price, 0), holding_id),
            )
            print(f"  {ticker} {qty}주 판매")

        _log_transaction_db(conn, member_name, account_id, ticker, "SELL", sell_qty, avg_price, currency, "매도")


def get_price(ticker, currency="USD"):
    """Get current price from DB first, then live fetch."""
    # Determine currency from ticker suffix
    holding_currency = _ticker_currency(ticker)
    if holding_currency != currency:
        currency = holding_currency

    # 1순위: daily_prices 테이블 (가장 최근 close)
    try:
        import sqlite3
        conn = sqlite3.connect(str(DB_PATH))
        cursor = conn.cursor()
        cursor.execute("""
            SELECT close, date 
            FROM daily_prices 
            WHERE ticker = ?
            ORDER BY date DESC
            LIMIT 1
        """, (ticker,))
        row = cursor.fetchone()
        conn.close()
        
        if row and row[0]:
            return row[0]
    except:
        pass

    # 2순위: live fetch
    price = _live_fetch(ticker)
    return price


def _ticker_currency(ticker):
    """Determine currency from ticker suffix (공통 모듈 위임)."""
    return _ticker_currency_util(ticker)


def _live_fetch(ticker):
    """Live fetch a price via yfinance or Upbit. Korean stocks use FDR."""
    if ticker == "BTC":
        return _get_btc_krw_price()

    # Korean stocks — use FinanceDataReader (yfinance fails for KR)
    if ticker.endswith((".KS", ".KQ")):
        return _fetch_kr_price(ticker)

    try:
        stock = yf.Ticker(ticker)
        info = stock.info or {}
        price = info.get("currentPrice") or info.get("regularMarketPrice")
        if price:
            return price
        prev = info.get("regularMarketPreviousClose")
        if prev and prev > 0:
            return prev
    except Exception:
        pass
    return None


def _fetch_kr_price(ticker):
    """Fetch Korean stock price via FinanceDataReader."""
    try:
        from FinanceDataReader import DataReader as FDR
    except ImportError:
        return None

    code = ticker.replace(".KS", "").replace(".KQ", "")
    try:
        df = FDR(code, "20250101")
        if len(df) > 0:
            return float(df["Close"].iloc[-1])
    except Exception as e:
        print(f"  ✗ {ticker} (FDR): {e}")
    return None


def _get_btc_krw_price():
    """Get BTC/KRW price from Upbit."""
    import urllib.request
    import ssl
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(
            "https://api.upbit.com/v1/ticker?markets=KRW-BTC",
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            data = json.loads(resp.read())
            if data:
                return data[0].get("trade_price", 0)
    except Exception as e:
        print(f"  ⚠ Upbit API 실패: {e}")
    return None


def fmt_krw(n):
    if n is None:
        return "N/A"
    return f"{n:,.0f}원"


def fmt_usd(n):
    if n is None:
        return "N/A"
    return f"${n:,.2f}"


def fmt_pct(v):
    sign = "+" if v >= 0 else ""
    return f"{sign}{v:.1f}%"


# ── Portfolio Operations ──────────────────────────────────────────────────

def add_position(member, account, ticker, name, qty, price, currency=None, note=""):
    """Add or update a position."""
    member = normalize_member(member)
    if not db_available():
        print(f"  ✗ Portfolio DB unavailable: {DB_PATH}")
        return
    _db_add_position(member, account, ticker, name, qty, price, currency, note)


def remove_position(member, account, ticker, qty=None):
    """Remove or reduce a position."""
    member = normalize_member(member)
    if not db_available():
        print(f"  ✗ Portfolio DB unavailable: {DB_PATH}")
        return
    _db_remove_position(member, account, ticker, qty)


def view_portfolio(member=None, account=None, pretty=True):
    """Display portfolio summary."""
    member = normalize_member(member)
    data = load_holdings()

    def _fmt_cur(currency):
        return {"USD": "$", "KRW": "원", "EUR": "€", "JPY": "¥"}[currency]

    def _render(name, holdings_list):
        print(f"\n  {'='*60}")
        print(f"  {name}")
        print(f"  {'='*60}")

        if not holdings_list:
            print("  (보유 없음)")
            return 0

        # Group by currency
        from collections import defaultdict
        by_cur = defaultdict(list)
        for h in holdings_list:
            cur = _ticker_currency(h["ticker"])
            by_cur[cur].append(h)

        grand_total_krw = 0
        total_cost_krw = 0

        for cur in ["USD", "EUR", "JPY", "KRW"]:
            items = by_cur.get(cur)
            if not items:
                continue

            cur_total = 0
            cur_cost = 0

            for h in items:
                ticker_cur = _ticker_currency(h["ticker"])
                price = get_price(h["ticker"], ticker_cur)
                cost = h.get("invested", h["qty"] * h["avg_price"])
                cur_cost += cost

                if price:
                    value = h["qty"] * price
                    pnl = value - cost
                    pnl_pct = (pnl / cost) * 100 if cost > 0 else 0
                    cur_total += value

                    cur_sym = _fmt_cur(ticker_cur)
                    print(f"  {h['ticker']} ({h['name']})")
                    print(f"    수량: {h['qty']} | 평단: {h['avg_price']:,.0f}{cur_sym} | 현재: {price:,.0f}{cur_sym}")
                    print(f"    평가: {value:,.0f}{cur_sym} | 손익: {pnl:,.0f}{cur_sym} ({pnl_pct:+.1f}%)")
                else:
                    cur_sym = _fmt_cur(ticker_cur)
                    print(f"  {h['ticker']} ({h['name']})")
                    print(f"    수량: {h['qty']} | 평단: {h['avg_price']:,.0f}{cur_sym} | 현재: 조회불가")

            # Convert to KRW for grand total
            if cur == "USD":
                usd_krw = get_price("USDKRW", "KRW") or 1450
                cur_total_krw = cur_total * usd_krw
                cur_cost_krw = cur_cost * usd_krw
            elif cur == "EUR":
                eur_krw = get_price("EURKRW", "KRW") or 1700
                cur_total_krw = cur_total * eur_krw
                cur_cost_krw = cur_cost * eur_krw
            elif cur == "JPY":
                jpy_krw = get_price("JPYKRW", "KRW") or 9.3
                cur_total_krw = cur_total * jpy_krw
                cur_cost_krw = cur_cost * jpy_krw
            else:
                cur_total_krw = cur_total
                cur_cost_krw = cur_cost

            grand_total_krw += cur_total_krw
            total_cost_krw += cur_cost_krw

            cur_sym = _fmt_cur(cur)
            print(f"  {'─'*60}")
            print(f"  {cur} 총 평가: {cur_total:,.0f}{cur_sym}")
            if cur_cost > 0:
                cur_pnl = cur_total - cur_cost
                print(f"  {cur} 총 손익: {cur_pnl:,.0f}{cur_sym} ({cur_pnl/cur_cost*100:+.1f}%)")
            print(f"{'='*60}")

        return grand_total_krw

    if member:
        grand_total = 0
        if member == "standalone":
            for acc_key, acc_data in data.get("standalone", {}).items():
                if account and acc_key != account:
                    continue
                grand_total += _render(acc_data["name"], acc_data.get("holdings", []))
        else:
            m = data["members"].get(member)
            if not m:
                print(f"  ✗ '{member}' 없음")
                return

            for acc_key, a in m["accounts"].items():
                if account and acc_key != account:
                    continue
                grand_total += _render(f"{m['name']} - {a['name']}", a.get("holdings", []))
    else:
        # Full summary
        print(f"\n  {'='*60}")
        print(f"  📊 전체 포트폴리오")
        print(f"  {'='*60}")

        grand_total = 0
        for m_key, m in data["members"].items():
            for a_key, a in m["accounts"].items():
                val = _render(f"{m['name']} - {a['name']}", a.get("holdings", []))
                grand_total += val

        for acc_key, acc in data.get("standalone", {}).items():
            val = _render(acc["name"], acc.get("holdings", []))
            grand_total += val

        print(f"  {'='*60}")
        print(f"  전액 평가: {grand_total:,.0f}원")
        print(f"{'='*60}")

    return grand_total


# ── CLI ───────────────────────────────────────────────────────────────────

def build_parser():
    p = argparse.ArgumentParser(description="Portfolio V2 Manager")
    sub = p.add_subparsers(dest="cmd")

    # add
    add_p = sub.add_parser("add", help="Add/upgrade position")
    add_p.add_argument("member", help="raymond | claire(wife) | henry(son) | standalone")
    add_p.add_argument("account", help="overseas | pension_kr | retirement_kr | kr_individual | bitcoin")
    add_p.add_argument("ticker", help="Ticker symbol")
    add_p.add_argument("name", help="Asset name")
    add_p.add_argument("qty", type=float, help="Quantity")
    add_p.add_argument("price", type=float, help="Price per unit")
    add_p.add_argument("--currency", default=None, help="Override currency. Defaults to ticker suffix detection.")
    add_p.add_argument("--note", default="", help="Optional note")

    # remove
    rm_p = sub.add_parser("remove", help="Sell/remove position")
    rm_p.add_argument("member", help="raymond | claire(wife) | henry(son) | standalone")
    rm_p.add_argument("account", help="overseas | pension_kr | retirement_kr | kr_individual | bitcoin")
    rm_p.add_argument("ticker", help="Ticker")
    rm_p.add_argument("qty", type=float, nargs="?", default=None, help="Qty to sell (omit=all)")

    # view
    view_p = sub.add_parser("view", help="View portfolio")
    view_p.add_argument("member", nargs="?", default=None, help="Specific member or 'standalone'")
    view_p.add_argument("--account", default=None, help="Specific account")

    # summary
    sub.add_parser("summary", help="Full portfolio summary")

    return p


def main():
    parser = build_parser()
    args = parser.parse_args()

    if not args.cmd:
        parser.print_help()
        return

    if args.cmd == "add":
        add_position(
            args.member, args.account, args.ticker, args.name,
            args.qty, args.price, args.currency, args.note
        )
    elif args.cmd == "remove":
        remove_position(args.member, args.account, args.ticker, args.qty)
    elif args.cmd == "view":
        view_portfolio(args.member, args.account)
    elif args.cmd == "summary":
        view_portfolio()


if __name__ == "__main__":
    main()
