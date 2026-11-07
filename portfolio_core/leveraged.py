"""레버리지·인버스 상품 판정 — 종목명 기준."""

from __future__ import annotations

import re

# Direxion Bull 2X / GraniteShares 2x Long / T-REX 2X / ProShares Ultra /
# Tradr 1.5X Short / KODEX 레버리지·인버스 …
LEVERAGED_NAME_PATTERN = re.compile(
    r"(\b[1-3](?:\.\d)?\s?x\b|레버리지|leverag|인버스|inverse|\bbull\b|\bbear\b|\bultra(?:pro|short)?\b|롱\s?\d|숏\s?\d|\blong\s\d|\bshort\s\d)",
    re.IGNORECASE,
)


def is_leveraged_product(name: str | None) -> bool:
    return bool(name) and LEVERAGED_NAME_PATTERN.search(str(name)) is not None
