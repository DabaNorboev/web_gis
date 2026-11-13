"""Budgeted source HTTP and a localhost range bridge for GDAL (research only)."""
import datetime as dt
import hashlib
import json
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests


class Source:
    def __init__(self, run):
        self.run = Path(run)
        self.config = json.loads((self.run/'config.json').read_text())
        self.lock = threading.Lock()

    def get(self, name, url, *, method='GET', byte_range=None):
        with self.lock:
            cfg = self.config
            records = [json.loads(x) for x in (self.run/'requests.jsonl').read_text().splitlines()] if (self.run/'requests.jsonl').exists() else []
            budget = cfg['budgets']
            elapsed = (dt.datetime.now(dt.timezone.utc)-dt.datetime.fromisoformat(cfg['started_at'])).total_seconds()
            if len(records) >= budget['http_requests'] or elapsed > budget['network_processing_minutes']*60:
                raise RuntimeError('Request/time budget reached')
            used = sum(r.get('bytes', 0) for r in records)
            remaining = budget['download_bytes']-used
            if remaining <= 0:
                raise RuntimeError('Byte budget reached')
            storage = sum(p.stat().st_size for p in self.run.rglob('*') if p.is_file())
            if storage >= budget['final_storage_bytes']:
                raise RuntimeError('Storage budget reached')
            row = {'name': name, 'url': url, 'method': method, 'range': byte_range,
                   'retrieved_at': dt.datetime.now(dt.timezone.utc).isoformat()}
            path = self.run/'raw'/name
            start = time.monotonic()
            count = 0
            digest = hashlib.sha256()
            try:
                headers = {'User-Agent': 'PlaceLens-one-period-research/1.0', 'Accept-Encoding': 'identity'}
                if byte_range:
                    headers['Range'] = byte_range
                with requests.request(method, url, headers=headers, stream=True, timeout=budget['timeout_seconds'], allow_redirects=False) as response:
                    row.update(status=response.status_code, headers={k: v for k, v in response.headers.items()
                               if k.lower() in ['content-length', 'content-range', 'content-type', 'etag', 'last-modified', 'accept-ranges']})
                    if byte_range and response.status_code != 206:
                        raise RuntimeError('Source did not honour byte range; no full download fallback')
                    length = int(response.headers.get('Content-Length', 0))
                    if method != 'HEAD' and length > min(remaining, budget['final_storage_bytes']-storage):
                        raise RuntimeError('Response exceeds remaining byte/storage budget')
                    with path.open('xb') as out:
                        for block in response.iter_content(1024*1024):
                            if count+len(block) > min(remaining, budget['final_storage_bytes']-storage):
                                raise RuntimeError('Download limit; partial response preserved')
                            out.write(block)
                            digest.update(block)
                            count += len(block)
                    row.update(bytes=count, sha256=digest.hexdigest())
            except Exception as exc:
                row.update(error_type=type(exc).__name__, error=str(exc), bytes=count, sha256=digest.hexdigest())
                raise
            finally:
                row['elapsed_seconds'] = round(time.monotonic()-start, 3)
                with (self.run/'requests.jsonl').open('a') as log:
                    log.write(json.dumps(row)+'\n')
            return row


class RangeBridge:
    """GDAL does raster work; this bridge only counts/preserves HTTP range responses."""
    def __init__(self, source, assets):
        self.source, self.assets = source, assets
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_HEAD(self):
                self.serve('HEAD')

            def do_GET(self):
                self.serve('GET')

            def serve(self, method):
                key = self.path.lstrip('/').split('?')[0]
                if key not in bridge.assets:
                    self.send_error(404)
                    return
                try:
                    seq = len(list(source.run.joinpath('raw').glob('range-*')))
                    row = source.get(f'range-{seq:03d}.bin', bridge.assets[key], method=method,
                                     byte_range=self.headers.get('Range'))
                    self.send_response(row['status'])
                    for k, v in row['headers'].items():
                        self.send_header(k, v)
                    self.end_headers()
                    if method != 'HEAD':
                        self.wfile.write((source.run/'raw'/row['name']).read_bytes())
                except Exception as exc:
                    self.send_error(502, type(exc).__name__)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)

    def __enter__(self):
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f'http://127.0.0.1:{self.server.server_port}'

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
