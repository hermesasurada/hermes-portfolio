#!/usr/bin/env python3
"""
10년치 일별 종가 데이터 관리 시스템
- 초기: 전체 10년치 다운로드
- 일일:增量 업데이트 (마지막 업데이트일 이후만)
- 조회: CLI 쿼리
"""

import argparse
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import yfinance as yf
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from price_cache_utils import ticker_currency

try:
    from FinanceDataReader import DataReader as FDR
    _FDR_AVAILABLE = True
except ImportError:
    _FDR_AVAILABLE = False

DB_PATH = Path.home() / ".hermes" / "data" / "stock_history.db"

# ─── Database ────────────────────────────────────────────────

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS tickers (
            ticker TEXT PRIMARY KEY,
            name TEXT,
            region TEXT,
            currency TEXT,
            added_date TEXT
        );
        CREATE TABLE IF NOT EXISTS daily_prices (
            date TEXT NOT NULL,
            ticker TEXT NOT NULL,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume INTEGER,
            adj_close REAL,
            source TEXT DEFAULT 'yfinance',
            PRIMARY KEY (date, ticker),
            FOREIGN KEY (ticker) REFERENCES tickers(ticker)
        );
        CREATE INDEX IF NOT EXISTS idx_prices_date ON daily_prices(date);
        CREATE INDEX IF NOT EXISTS idx_prices_ticker ON daily_prices(ticker);
    """)
    conn.commit()
    conn.close()


def load_tickers_from_holdings():
    """DB holdings에서 티커 목록을 읽는다."""
    if not DB_PATH.exists():
        return {}
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        """
        SELECT h.ticker, h.name, a.region, h.currency, COALESCE(h.notes, h.created_at)
        FROM holdings h
        JOIN accounts a ON h.account_id = a.id
        """
    ).fetchall()
    conn.close()
    tickers = {}
    for ticker, name, region, currency, added_date in rows:
        if ticker not in tickers:
            tickers[ticker] = {
                'name': name or ticker,
                'region': region or 'US',
                'currency': currency or ticker_currency(ticker),
                'added_date': (added_date or '2025-06-01')[:10]
            }
    return tickers


def sync_tickers(tickers_dict):
    """DB에 ticker 메타 정보 동기화"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    for ticker, info in tickers_dict.items():
        c.execute("""
            INSERT OR REPLACE INTO tickers (ticker, name, region, currency, added_date)
            VALUES (?, ?, ?, ?, ?)
        """, (ticker, info['name'], info['region'], info['currency'], info['added_date']))
    conn.commit()
    conn.close()


def get_last_date(ticker):
    """해당 티커의 마지막 업데이트 날짜"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT MAX(date) FROM daily_prices WHERE ticker = ?", (ticker,))
    result = c.fetchone()[0]
    conn.close()
    return result


def save_prices(ticker, df):
    """DataFrame을 DB에 저장한다. 같은 날짜는 최신 소스로 교정한다."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    inserted = 0
    source = df.attrs.get("source", "yfinance")
    for date, row in df.iterrows():
        date_str = date.strftime('%Y-%m-%d')
        try:
            c.execute("""
                INSERT OR REPLACE INTO daily_prices
                (date, ticker, open, high, low, close, volume, adj_close, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (date_str, ticker,
                  row.get('Open', row.get('open')),
                  row.get('High', row.get('high')),
                  row.get('Low', row.get('low')),
                  row.get('Close', row.get('close')),
                  row.get('Volume', row.get('volume')),
                  row.get('Adj Close', row.get('adj_close')),
                  source))
            if c.rowcount:
                inserted += 1
        except Exception:
            pass
    conn.commit()
    conn.close()
    return inserted


def _is_kr(ticker: str) -> bool:
    return ticker.endswith((".KS", ".KQ"))


def _fdr_to_df(ticker: str, start: str, end: str | None = None) -> "pd.DataFrame | None":
    """FDR로 KR 주식 데이터 조회. yfinance 호환 컬럼명으로 반환."""
    if not _FDR_AVAILABLE:
        print(f"  ✗ FDR 미설치 (pip install finance-datareader)")
        return None
    code = ticker.replace(".KS", "").replace(".KQ", "")
    try:
        df = FDR(code, start or "2015-01-01", end)
        if df is None or df.empty:
            return None
        df.index = pd.to_datetime(df.index)
        # FDR 컬럼은 Open/High/Low/Close/Volume/Change 이미 일치
        df["Adj Close"] = df["Close"]  # adj_close 컬럼용 dummy
        df.attrs["source"] = "fdr"
        return df
    except Exception as e:
        print(f"  ✗ {ticker} (FDR): {e}")
        return None


def fetch_ticker(ticker, period='10y'):
    """단일 티커 데이터 다운로드 (KR: FDR, 해외: yfinance)."""
    if _is_kr(ticker):
        start = (datetime.now() - timedelta(days=365 * 10)).strftime('%Y-%m-%d')
        return _fdr_to_df(ticker, start)
    try:
        df = yf.Ticker(ticker).history(period=period)
        if df.empty:
            return None
        df.attrs["source"] = "yf"
        return df
    except Exception as e:
        print(f"  ✗ {ticker}: {e}")
        return None


def fetch_ticker_range(ticker, start, end):
    """범위 지정 다운로드 (증량용, KR: FDR, 해외: yfinance)."""
    if _is_kr(ticker):
        return _fdr_to_df(ticker, start, end)
    try:
        df = yf.Ticker(ticker).history(start=start, end=end)
        if df.empty:
            return None
        df.attrs["source"] = "yf"
        return df
    except Exception as e:
        print(f"  ✗ {ticker}: {e}")
        return None


# ─── Full Load ───────────────────────────────────────────────

def cmd_full_load(args):
    """10년치 전체 다운로드"""
    print("📥 초기 데이터 다운로드 시작...")
    init_db()

    all_tickers = load_tickers_from_holdings()

    if not all_tickers:
        print("⚠ 티커가 없습니다. stock_history.db holdings/tickers를 확인하세요.")
        return

    print(f"📊 총 {len(all_tickers)} 종목 다운로드")
    print(f"   DB holdings: {len(all_tickers)}종목")
    print()

    sync_tickers(all_tickers)

    total_inserted = 0
    failed = 0
    for i, (ticker, info) in enumerate(all_tickers.items(), 1):
        print(f"[{i}/{len(all_tickers)}] {ticker} ({info['name']})...")
        df = fetch_ticker(ticker, period='10y')
        if df is not None and not df.empty:
            inserted = save_prices(ticker, df)
            rows = len(df)
            total_inserted += inserted
            print(f"  → {rows}개 중 {inserted}개 저장 ({rows - inserted}개 중복skip)")
        else:
            failed += 1
        time.sleep(0.5)  # API rate limit

    print(f"\n✅ 완료: {total_inserted:,}행 저장, {failed}종목 실패")


# ─── Daily Update ────────────────────────────────────────────

def cmd_update(args):
    """Incremental update (마지막 업데이트일 이후)"""
    print("📈 일일 업데이트 시작...")
    init_db()

    all_tickers = load_tickers_from_holdings()

    updated = 0
    failed = 0

    for ticker, info in all_tickers.items():
        last_date = get_last_date(ticker)

        if last_date:
            # 마지막 업데이트일 + 1일부터
            start = (datetime.strptime(last_date, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')
        else:
            # 전일
            start = (datetime.now() - timedelta(days=3)).strftime('%Y-%m-%d')

        end = datetime.now().strftime('%Y-%m-%d')

        if start > end:
            continue

        # yfinance returns empty for single-day range queries (start == end).
        # Extend end by 1 day as a workaround.
        if start == end:
            end = (datetime.strptime(end, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')

        df = fetch_ticker_range(ticker, start, end)
        if df is not None and not df.empty:
            inserted = save_prices(ticker, df)
            if inserted > 0:
                updated += inserted
                print(f"  ✓ {ticker}: {inserted}행 업데이트")
        else:
            failed += 1

        time.sleep(0.5)

    print(f"\n✅ 업데이트 완료: {updated}행 추가, {failed}종목 실패")


# ─── Query ───────────────────────────────────────────────────

def cmd_query(args):
    """종목별 데이터 조회"""
    init_db()
    ticker = args.ticker
    days = args.days or 30

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # ticker 정보
    c.execute("SELECT * FROM tickers WHERE ticker = ?", (ticker,))
    info = c.fetchone()
    if not info:
        print(f"⚠ '{ticker}' 티커를 찾을 수 없습니다.")
        conn.close()
        return

    print(f"\n📊 {ticker} ({info[1]})")
    print(f"   지역: {info[2]} | 통화: {info[3]}")
    print()

    # 최근 N일
    cutoff = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')
    c.execute("""
        SELECT date, open, high, low, close, volume
        FROM daily_prices
        WHERE ticker = ? AND date >= ?
        ORDER BY date DESC
        LIMIT ?
    """, (ticker, cutoff, days))

    rows = c.fetchall()
    if not rows:
        print("   데이터 없음")
        conn.close()
        return

    print(f"  {'날짜':<12s} {'종가':>10s} {'변동':>8s} {'거래량':>12s}")
    print(f"  {'─'*42}")
    prev_close = None
    for date, open_p, high, low, close, volume in rows:
        change = ""
        if prev_close and close:
            pct = ((close - prev_close) / prev_close) * 100
            change = f"{pct:+.2f}%"
        vol_str = f"{volume:,}" if volume else "-"
        print(f"  {date:<12s} {close:>10,.0f} {change:>8s} {vol_str:>12s}")
        prev_close = close

    # 통계
    closes = [r[4] for r in rows if r[4]]
    if closes:
        print(f"\n   통계를 (최근 {len(closes)}일):")
        print(f"   최고: {max(closes):,.0f}")
        print(f"   최저: {min(closes):,.0f}")
        print(f"   평균: {sum(closes)/len(closes):,.0f}")

    conn.close()


def cmd_stats(args):
    """전체 통계"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("SELECT COUNT(*) FROM tickers")
    ticker_count = c.fetchone()[0]

    c.execute("SELECT COUNT(*) FROM daily_prices")
    price_count = c.fetchone()[0]

    c.execute("SELECT MIN(date), MAX(date) FROM daily_prices")
    date_range = c.fetchone()

    print(f"📊 데이터베이스 통계")
    print(f"   티커 수: {ticker_count}")
    print(f"   가격 데이터: {price_count:,}행")
    if date_range[0] and date_range[1]:
        print(f"   기간: {date_range[0]} ~ {date_range[1]}")

    # 티커별 행 수 상위 10
    c.execute("""
        SELECT ticker, COUNT(*) as cnt, MIN(date) as first, MAX(date) as last
        FROM daily_prices
        GROUP BY ticker
        ORDER BY cnt DESC
        LIMIT 10
    """)
    print(f"\n   상위 10 종목 (행 수):")
    for ticker, cnt, first, last in c.fetchall():
        print(f"   {ticker}: {cnt:,}행 ({first} ~ {last})")

    conn.close()


def cmd_export(args):
    """CSV export (Obsidian 임베드용)"""
    init_db()
    ticker = args.ticker
    output = Path(args.output) if args.output else Path.home() / f"{ticker}.csv"

    conn = sqlite3.connect(DB_PATH)
    df = pd.read_sql_query("""
        SELECT date, open, high, low, close, volume, adj_close
        FROM daily_prices
        WHERE ticker = ?
        ORDER BY date ASC
    """, conn, params=(ticker,))
    conn.close()

    if df.empty:
        print(f"⚠ '{ticker}' 데이터 없음")
        return

    df.to_csv(output, index=False, date_format='%Y-%m-%d')
    print(f"✅ {ticker} → {output} ({len(df)}행)")


# ─── Main ────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='10년치 일별 종가 데이터 관리')
    sub = parser.add_subparsers(dest='command')

    sub.add_parser('full-load', help='10년치 전체 다운로드')
    sub.add_parser('update', help='일일增量 업데이트')
    q = sub.add_parser('query', help='종목별 조회')
    q.add_argument('ticker', help='티커')
    q.add_argument('--days', '-d', type=int, default=30, help='조회 기간(일)')
    sub.add_parser('stats', help='DB 통계')
    e = sub.add_parser('export', help='CSV 내보내기')
    e.add_argument('ticker', help='티커')
    e.add_argument('--output', '-o', help='출력 파일')

    args = parser.parse_args()

    if args.command == 'full-load':
        cmd_full_load(args)
    elif args.command == 'update':
        cmd_update(args)
    elif args.command == 'query':
        cmd_query(args)
    elif args.command == 'stats':
        cmd_stats(args)
    elif args.command == 'export':
        cmd_export(args)
    else:
        parser.print_help()
