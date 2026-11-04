"""A2 bounded public HTTP fetches. No application/DB integration or overwrites."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import time

import requests


def fetch(run, name, url, params=None, headers=None):
    config = json.loads((run / 'config.json').read_text())
    output = run / 'raw' / name
    if output.exists():
        raise ValueError('Output already exists; choose a new artifact name')
    log = run / 'requests.jsonl'
    records = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    branch = 'air' if any(host in url for host in ['air.krasn.ru', 'sensor.krasn.ru']) else 'satellite'
    if sum(r['branch'] == branch for r in records) >= config['budgets'][branch + '_requests']:
        raise ValueError('Request budget exhausted')
    if sum(r.get('bytes', 0) for r in records) >= config['budgets']['total_bytes']:
        raise ValueError('Byte budget exhausted')
    start = time.monotonic()
    safe_params = {key: '[redacted public site credential]' if any(word in key.lower() for word in ['key', 'token', 'pass']) else value
                   for key, value in (params or {}).items()}
    row = {'name': name, 'branch': branch, 'url': url, 'params': safe_params,
           'retrieved_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        request_headers = {'User-Agent': 'PlaceLens-source-feasibility/1.0 (public research)'}
        request_headers.update(headers or {})
        if headers:
            row['credential_source'] = 'public operator website; values omitted'
        response = requests.get(url, params=params, timeout=config['budgets']['timeout_seconds'], stream=True,
                                headers=request_headers)
        row.update(status=response.status_code, content_type=response.headers.get('Content-Type'),
                   date=response.headers.get('Date'))
        content = bytearray()
        used = sum(r.get('bytes', 0) for r in records)
        for chunk in response.iter_content(65536):
            content.extend(chunk)
            if used + len(content) > config['budgets']['total_bytes']:
                raise ValueError('Byte budget exhausted while receiving response')
        response.close()
        with output.open('xb') as target:
            target.write(content)
        row.update(bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
    except requests.RequestException as error:
        row.update(error_type=type(error).__name__, error=str(error))
    finally:
        row['duration_seconds'] = round(time.monotonic() - start, 3)
        with log.open('a') as target:
            target.write(json.dumps(row, ensure_ascii=False) + '\n')
    return row


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--name', required=True)
    parser.add_argument('--url', required=True)
    parser.add_argument('--params', default='{}', help='Public JSON query parameters, no credentials')
    args = parser.parse_args()
    print(json.dumps(fetch(args.run, args.name, args.url, json.loads(args.params)), ensure_ascii=False))
