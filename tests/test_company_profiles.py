import copy
import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from portfolio_core import company_profiles as profiles


class CompanyProfilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'profiles.json'
        self.data = {'version': 1, 'profiles': {'TEST': {
            'kind': 'company', 'paragraphs': ['제품을 생산하고 고객에게 공급하는 기업. ' * 14],
            'reviewed_at': '2026-09-09', 'basis': '2026년 2분기',
            'sources': [{'title': '공식 자료', 'url': 'https://example.com/results'}],
        }}}
        self.conn = sqlite3.connect(':memory:')
        self.addCleanup(self.conn.close)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('CREATE TABLE tickers(ticker TEXT PRIMARY KEY, name TEXT, display_name TEXT)')
        self.conn.executemany('INSERT INTO tickers VALUES (?,?,?)', [('TEST', 'Original', '표시명'), ('PENDING', '대기', '')])

        @contextmanager
        def connect():
            yield self.conn

        self.enterContext(patch.object(profiles, 'connect', connect))
        self.enterContext(patch.object(profiles, 'PROFILE_PATH', self.path))
        profiles._read_catalog.cache_clear()

    def write(self):
        self.path.write_text(json.dumps(self.data), encoding='utf-8')

    def test_read_only_and_no_cached_provider_fallback(self):
        self.write()
        # No provider cache table: profile reads must not depend on one.
        result = profiles.load_company_profile(' test ')
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['name'], '표시명')
        self.assertEqual(result['sources'][0]['url'], 'https://example.com/results')
        self.assertEqual(profiles.load_company_profile('PENDING')['status'], 'pending')

    def test_missing_catalog(self):
        self.assertEqual(profiles.load_company_profile('TEST')['status'], 'pending')

    def test_unknown_and_injection_are_rejected(self):
        for ticker in ['', 'UNKNOWN', "TEST' OR 1=1 --", '../../private']:
            with self.assertRaises(ValueError):
                profiles.load_company_profile(ticker)

    def test_atomic_catalog_replacement_invalidates_cache(self):
        self.write()
        profiles.load_company_profile('TEST')
        self.data['profiles']['TEST']['basis'] = '새 자료'
        other = self.path.with_suffix('.new')
        other.write_text(json.dumps(self.data))
        other.replace(self.path)
        self.assertEqual(profiles.load_company_profile('TEST')['basis'], '새 자료')

    def test_validation(self):
        self.assertIs(profiles.validate_catalog(self.data), self.data)
        for key, value in [('kind', 'raw'), ('paragraphs', ['소개입니다.' * 100]),
                           ('paragraphs', ['짧음']), ('reviewed_at', 'unknown'), ('basis', ''),
                           ('sources', []), ('sources', [{'title': 'bad', 'url': 'javascript:alert(1)'}])]:
            invalid = copy.deepcopy(self.data)
            invalid['profiles']['TEST'][key] = value
            with self.assertRaises(ValueError):
                profiles.validate_catalog(invalid)


if __name__ == '__main__':
    unittest.main()
