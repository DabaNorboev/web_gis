#!/usr/bin/env python3
"""Bounded offline-only air access check: two GETs, no retries or DB writes."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import time
import requests

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
queries = [
    ('project9.json', 'https://air.krasn.ru/api/2.0/projects/9', {}),
    ('one-hour.json', 'https://air.krasn.ru/api/2.0/data', {
        'time_begin': '2026-08-09 00:00:00', 'time_end': '2026-08-09 01:00:00',
        'time_interval': 'hour', 'sites': '4228,3846,3858', 'projects': '9'}),
]
for name, url, params in queries:
    row = {'name': name, 'url': url, 'params': params,
           'retrieved_at': dt.datetime.now(dt.timezone.utc).isoformat()}
    started = time.monotonic()
    try:
        with requests.get(url, params=params, timeout=(5, 15), stream=True,
                          allow_redirects=False,
                          headers={'User-Agent': 'PlaceLens-offline-air-input/1.0'}) as response:
            row.update(http_status=response.status_code,
                       content_type=response.headers.get('Content-Type'),
                       server_date=response.headers.get('Date'))
            body = bytearray()
            for chunk in response.iter_content(8192):
                if len(body) + len(chunk) > 262144:
                    raise ValueError('response exceeds 256 KiB limit')
                body.extend(chunk)
            (args.output / name).write_bytes(body)
            row.update(bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
            try:
                data = json.loads(body)
                row.update(api_status=data.get('status'),
                           rows=len(data['data']) if isinstance(data.get('data'), list) else None)
            except (ValueError, AttributeError):
                row['parse_error'] = 'not an API object'
    except (requests.RequestException, ValueError) as error:
        row['error_type'] = type(error).__name__
    row['duration_seconds'] = round(time.monotonic() - started, 3)
    with (args.output / 'requests.jsonl').open('a') as stream:
        stream.write(json.dumps(row, ensure_ascii=False) + '\n')
    print(json.dumps(row, ensure_ascii=False))
