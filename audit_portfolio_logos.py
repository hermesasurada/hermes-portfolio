#!/usr/bin/env python3
"""Offline logo audit: report suspicious assets without changing them."""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
from pathlib import Path

from PIL import Image

from download_portfolio_logos import target_tickers
from portfolio_core.logos import _is_letter_placeholder
from portfolio_core.paths import LOGO_DIR
from portfolio_web_server import logo_hint


def audit():
    rows = []
    for ticker, name in target_tickers(False):
        hint = logo_hint(ticker, name or ticker)
        url = hint["url"]
        path = LOGO_DIR / url.split("/logos/", 1)[1].split("?", 1)[0] if url else None
        flags = []
        row = {"ticker": ticker, "name": name, "file": path.name if path else None, "flags": flags}
        if not path or not path.exists():
            flags.append("missing")
        else:
            body = path.read_bytes()
            row["sha256"] = hashlib.sha256(body).hexdigest()
            if path.suffix == ".png":
                try:
                    with Image.open(path) as image:
                        image = image.convert("RGBA")
                        w, h = image.size
                        row["size"] = [w, h]
                        if min(w, h) < 32:
                            flags.append("low_resolution")
                        if max(w / h, h / w) > 3:
                            flags.append("wide_wordmark")
                        pixels = list(image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata())
                        alpha = [p for p in pixels if p[3] > 40]
                        ink = [p for p in alpha if min(p[:3]) < 220]
                        if len(alpha) < w * h * .01:
                            flags.append("empty")
                        elif len(ink) < w * h * .025 and not hint.get("dark"):
                            flags.append("white_on_white")
                        if _is_letter_placeholder(body):
                            flags.append("possible_placeholder")
                except Exception:
                    flags.append("invalid_image")
            else:
                if "<text" in body.decode(errors="replace"):
                    flags.append("text_svg_review")
            row["dark"] = hint.get("dark", False)
            meta_path = path.with_suffix(".source.json")
            try:
                row["provenance"] = json.loads(meta_path.read_text()) if meta_path.exists() else None
            except (OSError, ValueError):
                row["provenance"] = None
                flags.append("invalid_provenance")
        rows.append(row)
    return rows


def write_report(rows, output):
    output.mkdir(parents=True, exist_ok=True)
    (output / "audit.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    # A browser contact sheet displays the original assets, without altering images.
    for page, start in enumerate(range(0, len(rows), 90), 1):
        cards = []
        for row in rows[start:start + 90]:
            path = LOGO_DIR / row["file"] if row["file"] else None
            img = "—"
            if path and path.exists():
                mime = "image/svg+xml" if path.suffix == ".svg" else "image/png"
                src = base64.b64encode(path.read_bytes()).decode()
                img = f'<img style="filter:{"brightness(0)" if row.get("dark") else "none"}" src="data:{mime};base64,{src}">'
            cards.append(f'<article>{img}<b>{html.escape(row["ticker"])}</b><small>{html.escape(row["name"] or "")}</small><em>{html.escape(", ".join(row["flags"]))}</em></article>')
        (output / f"page-{page}.html").write_text('<!doctype html><meta charset="utf-8"><style>body{font:11px system-ui;display:grid;grid-template-columns:repeat(10,1fr);gap:4px;background:#eef1f5}article{background:white;padding:3px;text-align:center;height:68px;overflow:hidden}img{display:block;width:30px;height:30px;object-fit:contain;margin:0 auto 2px}b,small,em{display:block}small{height:22px;overflow:hidden;font-size:9px}em{color:#b22;font-size:8px}</style>' + ''.join(cards))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("/tmp/portfolio-logo-audit"))
    args = parser.parse_args()
    rows = audit()
    write_report(rows, args.output)
    print(json.dumps({"total": len(rows), "flagged": [r for r in rows if r["flags"]]}, ensure_ascii=False, indent=2))
