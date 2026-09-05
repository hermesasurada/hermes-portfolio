#!/usr/bin/env python3
"""Explicit, offline repair of five reviewed historical transaction unit mismatches.

Dry-run by default. --apply backs up the DB and original rows outside the repo,
then updates quantities/prices and affected snapshots in one transaction.
Daily prices, holdings, cash flows and already-aligned trades are never modified.
This is not an automatic collector/import rule: ambiguous rows abort the repair.
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from collections import Counter
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from portfolio_core.db import connect
from portfolio_core.paths import DB_PATH
from portfolio_core.performance_snapshots import build_account_series, rebuild_account_snapshots_in_transaction

TICKERS = ("LCID", "ETHU", "SSO", "USD", "TQQQ")


def plan_repairs(conn):
    """Use actual split factors, not an inferred price ratio, for conversion.

    A broad price-band check allows historical execution/average-cost records
    outside the regular-session candle. Both plausible or neither plausible means
    no guessing. Existing aligned records take precedence (idempotent reruns).
    """
    plan, aligned, unresolved = [], [], []
    for ticker in TICKERS:
        last = conn.execute("SELECT MAX(date) FROM daily_prices WHERE ticker=? AND close IS NOT NULL", (ticker,)).fetchone()[0]
        splits = conn.execute("SELECT split_date,ratio FROM stock_splits WHERE ticker=? ORDER BY split_date", (ticker,)).fetchall()
        for row in conn.execute("SELECT * FROM transactions WHERE ticker=? ORDER BY account_id,trade_date,id", (ticker,)):
            old = dict(row)
            quote = conn.execute("SELECT close FROM daily_prices WHERE ticker=? AND date=?", (ticker, row["trade_date"])).fetchone()
            if not quote or not quote[0] or not all(math.isfinite(float(v)) and float(v) > 0 for v in (quote[0], row["qty"], row["price"])):
                unresolved.append({"id": row["id"], "reason": "missing or invalid price/quantity"})
                continue
            if row["currency"] != "USD":
                unresolved.append({"id": row["id"], "reason": "unexpected trade currency"})
                continue
            ratio = float(row["price"]) / float(quote[0])
            if 0.75 <= ratio <= 1.35:
                aligned.append(row["id"])
                continue
            factor = Decimal(1)
            events = []
            for split in splits:
                if row["trade_date"] < split["split_date"] <= last:
                    value = Decimal(str(split["ratio"]))
                    if not value.is_finite() or value <= 0:
                        raise ValueError(f"Invalid split factor for {ticker}")
                    factor *= value
                    events.append(dict(split))
            qty = Decimal(str(row["qty"])) * factor
            price = Decimal(str(row["price"])) / factor
            adjusted_ratio = float(price) / float(quote[0])
            if factor == 1 or not 0.75 <= adjusted_ratio <= 1.35:
                unresolved.append({"id": row["id"], "reason": "split factor does not explain price scale"})
                continue
            plan.append({"before": old, "qty": float(qty), "price": float(price),
                         "factor": str(factor), "splits": events, "daily_close": quote[0]})
    return {"changes": plan, "aligned_ids": aligned, "unresolved": unresolved}


def apply_repairs(conn, plan):
    if not conn.in_transaction:
        raise ValueError("BEGIN IMMEDIATE is required")
    if plan["unresolved"]:
        raise ValueError(f"Unresolved transactions: {plan['unresolved']}")
    changes = plan["changes"]
    if not changes:
        return {}
    groups = {(r["before"]["account_id"], r["before"]["ticker"]) for r in changes}
    accounts = sorted({aid for aid,_ in groups})
    before_series = {aid: build_account_series(conn,aid) for aid in accounts}
    # Reviewed scope consists of fully closed historical positions. A partial
    # conversion must not silently turn them into synthetic opening positions.
    for aid, ticker in groups:
        net = conn.execute("SELECT COALESCE(SUM(CASE WHEN side='BUY' THEN qty ELSE -qty END),0) FROM transactions WHERE account_id=? AND ticker=?", (aid, ticker)).fetchone()[0]
        held = conn.execute("SELECT COALESCE(SUM(qty),0) FROM holdings WHERE account_id=? AND ticker=?", (aid, ticker)).fetchone()[0]
        delta = sum((r["qty"]-r["before"]["qty"]) * (1 if r["before"]["side"] == "BUY" else -1)
                    for r in changes if (r["before"]["account_id"], r["before"]["ticker"]) == (aid,ticker))
        if abs(net)>1e-7 or abs(held)>1e-7 or abs(delta)>1e-7:
            raise ValueError(f"Unbalanced/open position: account={aid}, ticker={ticker}")
    for change in changes:
        old = change["before"]
        current = conn.execute("SELECT * FROM transactions WHERE id=?", (old["id"],)).fetchone()
        if not current or dict(current) != old:
            raise ValueError(f"Transaction changed since review: {old['id']}")
        if not math.isclose(change["qty"]*change["price"],old["qty"]*old["price"],rel_tol=1e-12,abs_tol=1e-8):
            raise ValueError(f"Trade amount changed: {old['id']}")
        conn.execute("UPDATE transactions SET qty=?,price=? WHERE id=?", (change["qty"],change["price"],old["id"]))
    written = rebuild_account_snapshots_in_transaction(conn, accounts)
    for aid in accounts:
        after = [dict(r) for r in conn.execute("SELECT * FROM account_value_snapshots WHERE account_id=? ORDER BY date",(aid,))]
        before = before_series[aid]
        if [r['date'] for r in after] != [r['date'] for r in before]:
            raise ValueError(f"Snapshot date coverage changed: {aid}")
        for old,new in zip(before,after):
            if any(abs(old[key]-new[key])>0.011 for key in ('trade_cash_krw','flow_krw')):
                raise ValueError(f"Snapshot cash changed: {aid} {old['date']}")
        if before and abs(before[-1]['holdings_value_krw']-after[-1]['holdings_value_krw'])>0.011:
            raise ValueError(f"Ending account value changed: {aid}")
    return written


def backup_before_repair(folder, plan):
    """Caller holds the live write lock, but has not changed any rows yet."""
    folder.mkdir(parents=True, exist_ok=False, mode=0o700)
    backup = folder / "before.db"
    source = sqlite3.connect(DB_PATH.as_uri()+"?mode=ro", uri=True)
    target = sqlite3.connect(backup)
    try:
        source.backup(target)
        if target.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("Backup integrity check failed")
    finally:
        target.close()
        source.close()
    # A recovery manifest describes intended edits, not a claim of commit success.
    (folder / "repair-plan.json").write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding="utf-8")
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply",action="store_true")
    args = parser.parse_args()
    if not args.apply:
        conn=sqlite3.connect(DB_PATH.as_uri()+"?mode=ro",uri=True)
        conn.row_factory=sqlite3.Row
        try:
            conn.execute("BEGIN")
            plan=plan_repairs(conn)
        finally:
            conn.close()
    else:
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            plan=plan_repairs(conn)
            if plan["unresolved"]:
                raise ValueError(f"Unresolved transactions: {plan['unresolved']}")
            if plan["changes"]:
                folder=DB_PATH.parent/"backups"/("transaction-split-repair-"+datetime.now().strftime("%Y%m%d-%H%M%S")+"-"+uuid4().hex[:8])
                backup=backup_before_repair(folder,plan)
                print("Backup:",backup,flush=True)
                written=apply_repairs(conn,plan)
                print("Snapshot rows:",written)
        print("Committed")
    counts=Counter(r["before"]["ticker"] for r in plan["changes"])
    print(json.dumps({"changes":dict(counts),"total":sum(counts.values()),
                      "already_aligned":len(plan["aligned_ids"]),"unresolved":plan["unresolved"]},ensure_ascii=False))
    for r in plan["changes"]:
        old=r["before"]
        print(f"{old['id']} {old['ticker']} account={old['account_id']}: {old['qty']} @ {old['price']} -> {r['qty']} @ {r['price']}")


if __name__ == "__main__":
    main()
