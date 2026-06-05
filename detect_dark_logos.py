#!/usr/bin/env python3
"""흰색/연한 기업 로고(흰 배경 카드에서 안 보이는 것)를 자동 감지해
``logo_dark.json`` 목록을 갱신한다.

프런트엔드(format.js)는 이 목록에 든 로고에 ``filter: brightness(0)``(dark-logo)
를 적용해 검정으로 반전, 흰 배경에서도 보이게 만든다. 기존에 PLTR/ASML/DIS를
JS에 하드코딩하던 것을 데이터 기반으로 일괄 처리하기 위한 도구.

판정 기준(ink_frac): 알파>40인 픽셀 중 "흰 배경에서 식별되는" 픽셀
(luminance<=225 또는 채도>=35)이 이미지 전체에서 차지하는 비율. 이 값이
임계치 미만이면 사실상 흰 로고로 보고 반전 대상으로 표시한다. 흰 배경 위
컬러 로고(예: SK텔레콤·네이버)는 잉크 픽셀이 충분해 제외된다.

Pillow 필요(런타임 서버 의존성 아님 — 오프라인 유지보수 전용):
    python3 -m venv .venv && .venv/bin/pip install Pillow
    .venv/bin/python detect_dark_logos.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

from portfolio_core.paths import LOGO_DIR

OUTPUT_PATH = LOGO_DIR.parent / "logo_dark.json"
INK_FRAC_THRESHOLD = 0.025


def _luminance(r: int, g: int, b: int) -> float:
    return 0.299 * r + 0.587 * g + 0.114 * b


def ink_fraction(path: Path) -> float | None:
    """흰 배경에서 식별 가능한 픽셀이 이미지 전체에서 차지하는 비율."""
    image = Image.open(path).convert("RGBA")
    image.thumbnail((96, 96))
    pixels = image.load()
    width, height = image.size
    total = width * height
    if not total:
        return None
    ink = 0
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a < 40:
                continue
            sat = max(r, g, b) - min(r, g, b)
            if _luminance(r, g, b) <= 225 or sat >= 35:
                ink += 1
    return ink / total


def detect(logo_dir: Path = LOGO_DIR) -> list[str]:
    dark: list[str] = []
    for path in sorted(logo_dir.glob("*.png")):
        frac = ink_fraction(path)
        if frac is not None and frac < INK_FRAC_THRESHOLD:
            dark.append(path.stem)
    return sorted(dark)


def main() -> int:
    dark = detect()
    OUTPUT_PATH.write_text(json.dumps(dark, ensure_ascii=False, indent=2) + "\n")
    print(f"flagged {len(dark)} dark logos -> {OUTPUT_PATH}")
    print(", ".join(dark))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
