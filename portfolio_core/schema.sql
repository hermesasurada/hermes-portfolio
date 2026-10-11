-- 기본 테이블(계좌·종목·잔고·거래) — 운영 DB에서 그대로 옮긴 DDL(2026-10-11).
-- 그동안 이 네 표는 코드에 DDL이 없어 운영 DB에만 존재했고, 테스트가 운영 DB에서 DDL을 빌려 썼다.
-- 파생 표(가격·배당·캐시 등)는 db.py의 ensure_* 함수가 만든다.
CREATE TABLE IF NOT EXISTS tickers (
    ticker TEXT PRIMARY KEY,
    name TEXT,
    region TEXT,
    currency TEXT,
    added_date TEXT,
    category TEXT,
    next_earnings_date TEXT,
    earnings_updated_at TEXT,
    display_name TEXT,
    sector TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member TEXT NOT NULL,
    account_type TEXT NOT NULL,
    currency TEXT NOT NULL,
    region TEXT,
    name TEXT,
    history_start TEXT
);
CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    name TEXT,
    qty REAL NOT NULL,
    avg_price REAL NOT NULL,
    currency TEXT NOT NULL,
    invested REAL,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    UNIQUE(account_id, ticker)
);
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_date TEXT NOT NULL,
    member TEXT,
    account_id INTEGER,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    qty REAL NOT NULL,
    price REAL NOT NULL,
    currency TEXT,
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    apply_to_holdings INTEGER NOT NULL DEFAULT 1,
    hidden INTEGER NOT NULL DEFAULT 0,
    entry_score REAL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);
