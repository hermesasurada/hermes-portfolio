import io
import base64
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image, ImageDraw
from portfolio_core import logos, logo_assets


def png(color="red", size=(64, 64)):
    out = io.BytesIO()
    img = Image.new("RGBA", size, color)
    if color != (0, 0, 0, 0):
        ImageDraw.Draw(img).rectangle((8, 8, 24, 24), fill="white")
    img.save(out, format="PNG")
    return out.getvalue()


class LogoTests(unittest.TestCase):
    def test_validation(self):
        self.assertIsNotNone(logo_assets.validate_asset(png()))
        self.assertIsNone(logo_assets.validate_asset(png(size=(16, 16))))
        self.assertIsNone(logo_assets.validate_asset(png(color=(0, 0, 0, 0))))
        self.assertIsNone(logo_assets.validate_asset(b"<html>error</html>"))
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="red" d="M0 0h64v64H0z"/></svg>'
        self.assertIsNotNone(logo_assets.validate_asset(svg))
        for content in [b'<script>alert(1)</script>', b'<image href="https://evil.test/x"/>', b'<path onload="alert(1)"/>', b'<style>@import "https://evil.test";</style>']:
            self.assertIsNone(logo_assets.validate_asset(svg.replace(b'</svg>', content + b'</svg>')))
        solid = io.BytesIO()
        Image.new('RGBA', (64, 64), 'gray').save(solid, format='PNG')
        self.assertIsNone(logo_assets.validate_asset(solid.getvalue()))

    def test_logo_brand_namespace(self):
        from portfolio_web_server import logo_hint
        with patch('portfolio_web_server.logo_url', side_effect=lambda key: '/logos/' + key), patch('portfolio_web_server.is_dark_logo', return_value=False):
            self.assertEqual(logo_hint('SOL', '솔라나')['url'], '/logos/SOL')
            self.assertEqual(logo_hint('473330.KS', 'SOL 미국채')['url'], '/logos/473330.KS')
            self.assertEqual(logo_hint('138930.KS', 'BNK금융지주')['url'], '/logos/138930.KS')

    def test_source_appearance_overrides_old_filter(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(logos, 'LOGO_DIR', Path(tmp)), patch.object(logos, 'dark_logo_stems', return_value={'TEST'}):
            logos._save_sourced_logo('TEST', png(), 'png', 'official-icon')
            self.assertFalse(logos.is_dark_logo('TEST'))

    def test_embedded_white_logo_needs_contrast_filter(self):
        white = png(color='white')
        svg = b'<svg><image href="data:image/png;base64,' + base64.b64encode(white) + b'"/></svg>'
        self.assertTrue(logo_assets.needs_dark_filter(svg, 'svg'))
        self.assertFalse(logo_assets.needs_dark_filter(png(), 'png'))

    def test_private_network_rejected(self):
        self.assertFalse(logo_assets.public_url("file:///tmp/x"))
        with patch.object(logo_assets.socket, "getaddrinfo", return_value=[(0, 0, 0, '', ('127.0.0.1', 443))]):
            self.assertFalse(logo_assets.public_url("https://internal.test/logo"))

    def test_declared_icon_and_actual_url(self):
        page = b'<link rel="apple-touch-icon" href="/apple.png"><link rel="icon" href="//cdn.example.com/icon.png">'
        with patch.object(logo_assets, 'download', side_effect=[(page, 'https://example.com/'), (png(size=(192, 192)), 'https://example.com/apple.png')]):
            result = logo_assets.official_icon('example.com')
            self.assertEqual(result[1:], ('png', 'https://example.com/apple.png'))

    def test_official_precedes_provider_and_records_source(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(logos, 'LOGO_DIR', Path(tmp)), patch.object(logos, 'fallback_copy_sources', return_value={}), patch.object(logos, 'official_icon', return_value=(png(), 'png', 'https://example.com/icon.png')), patch.object(logos, 'fetch_logo') as fmp:
            result = logos.cache_logo('TEST', domain='example.com')
            self.assertEqual(result['source'], 'official-icon')
            fmp.assert_not_called()
            self.assertTrue((Path(tmp) / 'TEST.source.json').exists())

    def test_existing_and_pinned_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            (path / 'TEST.png').write_bytes(png())
            (path / 'OFFICIAL.svg').write_text('<svg/>')
            with patch.object(logos, 'LOGO_DIR', path), patch.object(logos, 'existing_logo_path', wraps=lambda t, logo_dir=None: next((p for ext in ('png', 'svg') if (p := path / f'{t}.{ext}').exists()), None)), patch.object(logos, 'fallback_copy_sources', return_value={'TEST': 'OFFICIAL'}), patch.object(logos, 'official_icon') as remote:
                self.assertEqual(logos.cache_logo('TEST')['source'], 'existing')
                result = logos.copy_fallback_logo('TEST', path)
                self.assertEqual(result['source'], 'copy:OFFICIAL')
                self.assertFalse((path / 'TEST.png').exists())
                self.assertTrue((path / 'TEST.svg').exists())
                remote.assert_not_called()

    def test_reviewed_source_failure_does_not_downgrade(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(logos, 'LOGO_DIR', Path(tmp)), patch.object(logos, 'existing_logo_path', return_value=None), patch.object(logos, 'fallback_copy_sources', return_value={}), patch.object(logos, 'download', return_value=None), patch.object(logos, 'fetch_logo') as fmp, patch.object(logos, 'official_icon') as icon:
            result = logos.cache_logo('RBC', keep_existing=False)
            self.assertFalse(result['saved'])
            fmp.assert_not_called()
            icon.assert_not_called()

    def test_manual_svg_preserved_on_force(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'TEST.svg'
            path.write_text('<svg/>')
            with patch.object(logos, 'LOGO_DIR', Path(tmp)), patch.object(logos, 'existing_logo_path', return_value=path), patch.object(logos, 'official_icon') as remote:
                self.assertEqual(logos.cache_logo('TEST', keep_existing=False)['source'], 'existing')
                remote.assert_not_called()

    def test_provider_provenance_is_not_marked_reviewed(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(logos, 'LOGO_DIR', Path(tmp)), patch.object(logos, 'existing_logo_path', return_value=None), patch.object(logos, 'fallback_copy_sources', return_value={}), patch.object(logos, 'official_icon', return_value=None), patch.object(logos, 'fetch_square_symbol', return_value=(png(), 'favicon:google')):
            result = logos.cache_logo('TEST', domain='example.com')
            self.assertFalse(result['reviewed'])
            self.assertTrue(result['needs_review'])
            self.assertIn('domain=example.com', result['url'])


if __name__ == '__main__':
    unittest.main()
