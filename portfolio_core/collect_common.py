from __future__ import annotations

import fcntl
from contextlib import contextmanager
from pathlib import Path

from .price_store import CATEGORIES


@contextmanager
def collector_lock(name: str):
    """Prevent overlapping cron runs for the same collector scope."""
    lock_path = Path(f"/tmp/hermes-portfolio-{name}.lock")
    with lock_path.open("w") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(f"Skipped: another {name} collector is still running")
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def parse_categories(values: list[str] | None) -> list[str]:
    if not values:
        return list(CATEGORIES)
    categories: list[str] = []
    for value in values:
        categories.extend(item.strip() for item in value.split(",") if item.strip())
    if "all" in categories:
        return list(CATEGORIES)
    unknown = sorted(set(categories) - set(CATEGORIES))
    if unknown:
        raise SystemExit(f"Unknown category: {', '.join(unknown)}")
    return sorted(set(categories), key=list(CATEGORIES).index)
