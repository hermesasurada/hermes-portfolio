"""Bounded, non-executable logo assets from company-declared icon links."""
from __future__ import annotations

import io
import base64
import ipaddress
import re
import socket
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "text/html,image/*;q=0.9,*/*;q=0.5"}
MAX_BYTES = 2_000_000


def public_url(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return False
    try:
        return all(ipaddress.ip_address(addr[4][0]).is_global for addr in socket.getaddrinfo(parsed.hostname, parsed.port or 443))
    except (OSError, ValueError):
        return False


class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not public_url(newurl):
            raise ValueError("non-public logo redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, timeout=8):
    if not public_url(url):
        return None
    try:
        with urllib.request.build_opener(PublicRedirect).open(urllib.request.Request(url, headers=HEADERS), timeout=timeout) as response:
            body = response.read(MAX_BYTES + 1)
            return (body, response.url) if len(body) <= MAX_BYTES else None
    except Exception:
        return None


def validate_asset(body):
    """Return (bytes, extension, width, height); never accept active SVG content."""
    if not body or len(body) > MAX_BYTES:
        return None
    if b"<svg" in body[:1000]:
        if re.search(br"<!DOCTYPE|<!ENTITY", body, re.I):
            return None
        try:
            root = ET.fromstring(body)
            allowed = {"svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "title", "desc", "style", "use", "pattern", "image"}
            for node in root.iter():
                if node.tag.split("}")[-1] not in allowed:
                    return None
                for key, val in node.attrib.items():
                    key = key.split("}")[-1].lower()
                    if key.startswith("on"):
                        return None
                    if key in {"href", "src"} and not val.startswith("#"):
                        if not val.startswith("data:image/png;base64,"):
                            return None
                        embedded = base64.b64decode(val.split(",", 1)[1], validate=True)
                        if not embedded.startswith(b"\x89PNG\r\n\x1a\n") or not validate_asset(embedded):
                            return None
                text = ' '.join(node.attrib.values()) + (node.text or "")
                if re.search(r"@import|javascript:|url\(\s*['\"]?(?!#)", text, re.I):
                    return None
            box = root.get("viewBox", "").replace(",", " ").split()
            if len(box) == 4:
                w, h = float(box[2]), float(box[3])
            else:
                w, h = float(root.get("width", "0").removesuffix("px")), float(root.get("height", "0").removesuffix("px"))
            if w <= 0 or h <= 0:
                return None
            return body, "svg", w, h
        except (ET.ParseError, ValueError):
            return None
    try:
        from PIL import Image
        with Image.open(io.BytesIO(body)) as img:
            if img.width * img.height > 25_000_000 or min(img.size) < 32:
                return None
            if img.format == "ICO":
                img = img.ico.getimage(max(img.ico.sizes(), key=lambda s: s[0] * s[1]))
            img = img.convert("RGBA")
            img.thumbnail((512, 512))
            if not img.getchannel("A").getbbox():
                return None
            if len(img.getcolors(2) or [0, 1, 2]) == 1:
                return None  # solid error/placeholder tile
            out = io.BytesIO()
            img.save(out, format="PNG")
            return out.getvalue(), "png", img.width, img.height
    except Exception:
        return None


def needs_dark_filter(body, ext):
    """White artwork on transparent backgrounds needs the existing UI filter."""
    if ext == "svg":
        embedded = re.findall(rb'data:image/png;base64,([^\s"\']+)', body)
        if embedded and all(needs_dark_filter(base64.b64decode(data), "png") for data in embedded):
            return True
        colors = re.findall(rb"(?:fill[:=]\s*['\"]?)(#[0-9a-fA-F]{3,8}|white|black)", body)
        return bool(colors) and all(c.lower() in {b"white", b"#fff", b"#ffffff"} for c in colors)
    from PIL import Image
    with Image.open(io.BytesIO(body)) as img:
        img = img.convert("RGBA")
        img.thumbnail((96, 96))
        pixels = img.get_flattened_data() if hasattr(img, "get_flattened_data") else img.getdata()
        ink = sum(a > 40 and (min(r, g, b) < 220 or max(r, g, b) - min(r, g, b) >= 35) for r, g, b, a in pixels)
        return ink / (img.width * img.height) < .025


class IconLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "link" and any(x in (attrs.get("rel") or "").lower().split() for x in ("icon", "apple-touch-icon", "apple-touch-icon-precomposed")):
            if attrs.get("href"):
                self.links.append(attrs["href"])


def official_icon(domain, timeout=8):
    if not domain:
        return None
    page = download(f"https://{domain}/", timeout)
    if not page:
        return None
    body, page_url = page
    parser = IconLinks()
    parser.feed(body.decode("utf-8", errors="replace"))
    urls = list(dict.fromkeys(urljoin(page_url, link) for link in parser.links))[:8]
    if not urls:
        urls = [urljoin(page_url, "/favicon.ico")]
    best = None
    for url in urls:
        fetched = download(url, timeout)
        asset = validate_asset(fetched[0]) if fetched else None
        if not asset:
            continue
        data, ext, w, h = asset
        if max(w / h, h / w) > 1.5:
            continue
        rank = 512 if ext == "svg" else min(w, h)
        if best is None or rank > best[0]:
            best = (rank, data, ext, fetched[1])
        if rank >= 192:
            break
    return best[1:] if best else None
