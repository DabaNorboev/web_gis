"""Local HTTP and synthetic acquisition only; no external source or retained data."""
import contextlib
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from satellite_fetch import Source, RangeBridge
import satellite_city as city


class FetchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_HEAD(self):
                self.send_response(200)
                self.send_header('Content-Length', '3')
                self.end_headers()

            def do_GET(self):
                self.send_response(206 if self.path == '/range' else 200)
                self.send_header('Content-Length', '9' if self.path == '/partial' else '3')
                if self.path == '/range':
                    self.send_header('Content-Range', 'bytes 0-2/9')
                self.end_headers()
                self.wfile.write(b'abc')

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setup_run(self, root, **budgets):
        (root / 'raw').mkdir()
        cfg = {'started_at': datetime.now(timezone.utc).isoformat(), 'budgets': {
            'http_requests': 20, 'network_processing_minutes': 1,
            'download_bytes': 10000, 'final_storage_bytes': 100000,
            'timeout_seconds': 2, **budgets}}
        (root / 'config.json').write_text(json.dumps(cfg))
        return Source(root)

    def records(self, root):
        return [json.loads(line) for line in (root / 'requests.jsonl').read_text().splitlines()]

    def test_full_head_and_range_bridge_preserve_bytes_and_hash(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); source = self.setup_run(root)
            row = source.get('full', self.url + '/full')
            self.assertEqual((row['status'], row['bytes'], row['sha256']),
                             (200, 3, hashlib.sha256(b'abc').hexdigest()))
            self.assertEqual((root / 'raw/full').read_bytes(), b'abc')
            self.assertEqual(source.get('head', self.url + '/full', method='HEAD')['bytes'], 0)
            with RangeBridge(source, {'asset': self.url + '/range'}) as bridge:
                response = requests.get(bridge + '/asset', headers={'Range': 'bytes=0-2'}, timeout=2)
                self.assertEqual((response.status_code, response.content), (206, b'abc'))
                self.assertEqual(response.headers['Content-Range'], 'bytes 0-2/9')
            self.assertEqual(self.records(root)[-1]['range'], 'bytes=0-2')

    def test_partial_response_is_failed_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); source = self.setup_run(root)
            with self.assertRaises(requests.exceptions.ChunkedEncodingError):
                source.get('partial', self.url + '/partial')
            row = self.records(root)[0]
            self.assertIn('error_type', row)
            self.assertNotIn(self.url, row['error'])
            retained = (root / 'raw/partial').read_bytes()
            with self.assertRaises(FileExistsError):
                source.get('partial', self.url + '/full')
            self.assertEqual((root / 'raw/partial').read_bytes(), retained)

    def test_range_refusal_and_budgets(self):
        for budgets, message in [({'http_requests': 0}, 'Request/time'),
                                 ({'network_processing_minutes': -1}, 'Request/time'),
                                 ({'download_bytes': 0}, 'Byte budget'),
                                 ({'final_storage_bytes': 1}, 'Storage budget'),
                                 ({'download_bytes': 2}, 'Response exceeds')]:
            with self.subTest(budgets=budgets), tempfile.TemporaryDirectory() as td:
                source = self.setup_run(Path(td), **budgets)
                with self.assertRaisesRegex(RuntimeError, message):
                    source.get('limited', self.url + '/full')
        with tempfile.TemporaryDirectory() as td:
            source = self.setup_run(Path(td))
            with self.assertRaisesRegex(RuntimeError, 'no full download fallback'):
                source.get('refused', self.url + '/full', byte_range='bytes=0-2')

    def acquisition(self, root):
        source = self.setup_run(root)
        selection_dir = root / 'selection'; selection_dir.mkdir()
        tile = {'scene_id': 'synthetic', 'native_JP2_availability': {}, 'assets': {}}
        for band in ['B04', 'B08']:
            tile['native_JP2_availability'][band] = {'source': self.url + '/full', 'bytes': 3}
        for key in ['red', 'nir', 'visual', 'scl']:
            tile['assets'][key] = {'source': self.url + '/full', 'content_length': 3}
        for key, suffix in [('scl', 'scl.tif'), ('product_XML', 'product.xml'), ('granule_XML', 'granule.xml')]:
            row = source.get('synthetic-' + suffix, self.url + '/full')
            if key != 'scl': tile[key + '_sha256'] = row['sha256']
        boundary = root / 'boundary.json'; boundary.write_text('{}')
        city.save(root / 'target.geojson', {'properties': {'source': str(boundary),
                  'sha256': city.sha256(boundary), 'source_properties': {'source_url': 'synthetic'}}})
        selection = selection_dir / 'manifest.json'
        city.save(selection, {'proposals': [{'date': '2024-08-15', 'tiles': [tile]}],
                  'target': {'sha256': city.sha256(root / 'target.geojson')},
                  'artifacts': {'raw/' + r['name']: r for r in self.records(root)}})
        city.save(selection_dir / 'shortlist.json', [{'date': '2024-08-15', 'items': [{'id': 'synthetic'}]}])
        cfg = source.config | {'selection_manifest': str(selection), 'selection_sha256': city.sha256(selection),
                               'date': '2024-08-15', 'tiles': [tile]}
        (root / 'config.json').write_text(json.dumps(cfg))
        return cfg

    def test_acquire_reuses_complete_input_and_rejects_tampering(self):
        # Each attempt uses fresh synthetic inputs, including a real local HTTP journal.
        for tamper in [None, 'hash', 'source', 'partial']:
            with self.subTest(tamper=tamper), tempfile.TemporaryDirectory() as td:
                root = Path(td); self.acquisition(root)
                with contextlib.redirect_stdout(io.StringIO()): city.acquire(root)
                original = json.loads((root / 'inputs-manifest.json').read_text())
                count = len(self.records(root))
                # Only the temporary output manifest is removed, to exercise cached raw inputs.
                (root / 'inputs-manifest.json').unlink()
                p = root / 'raw/synthetic-B04.jp2'
                if tamper == 'hash': p.write_bytes(b'bad')
                if tamper == 'partial': p.write_bytes(b'a')
                if tamper == 'source':
                    rows = self.records(root)
                    next(r for r in rows if r['name'] == p.name)['url'] = self.url + '/other'
                    (root / 'requests.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows))
                if tamper:
                    with self.assertRaisesRegex(ValueError, 'partial or changed|differs from selection'):
                        city.acquire(root)
                    self.assertFalse((root / 'inputs-manifest.json').exists())
                else:
                    with contextlib.redirect_stdout(io.StringIO()): city.acquire(root)
                    self.assertEqual(json.loads((root / 'inputs-manifest.json').read_text()), original)
                self.assertEqual(len(self.records(root)), count)


if __name__ == '__main__':
    unittest.main()
