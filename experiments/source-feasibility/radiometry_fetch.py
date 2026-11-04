"""Bounded, credential-free reference retrieval for the two existing A2 products."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import time

import requests


def fetch(run, name, url, params=None):
    config = json.loads((run/'config.json').read_text())
    target = run/'raw'/name
    if target.exists():
        raise ValueError('Existing evidence must not be overwritten')
    log = run/'requests.jsonl'
    records = [json.loads(v) for v in log.read_text().splitlines()] if log.exists() else []
    if len(records) >= config['budgets']['http_requests']:
        raise ValueError('Request budget reached')
    used = sum(v.get('bytes', 0) for v in records)
    if used >= config['budgets']['download_bytes']:
        raise ValueError('Download budget reached')
    if sum(p.stat().st_size for p in run.rglob('*') if p.is_file()) >= config['budgets']['final_storage_bytes']:
        raise ValueError('Final storage budget reached')
    row = {'name': name, 'url': url, 'params': params, 'retrieved_at': dt.datetime.now(dt.timezone.utc).isoformat()}
    started = time.monotonic()
    try:
        with requests.get(url, params=params, stream=True, timeout=config['budgets']['timeout_seconds'],
                          headers={'User-Agent': 'PlaceLens-A2-radiometry/1.0'}) as response:
            row.update(status=response.status_code, content_type=response.headers.get('Content-Type'),
                       date=response.headers.get('Date'))
            digest, count = hashlib.sha256(), 0
            with target.open('xb') as output:
                for block in response.iter_content(1024*1024):
                    if used+count+len(block) > config['budgets']['download_bytes']:
                        raise ValueError('Download limit reached; partial response preserved')
                    output.write(block)
                    digest.update(block)
                    count += len(block)
            row.update(bytes=count, sha256=digest.hexdigest())
    except requests.RequestException as error:
        row.update(error_type=type(error).__name__, error=str(error))
    finally:
        row['elapsed_seconds'] = round(time.monotonic()-started, 3)
        with log.open('a') as output:
            output.write(json.dumps(row, ensure_ascii=False)+'\n')
    return row


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run', required=True, type=Path)
    p.add_argument('--name', required=True)
    p.add_argument('--url', required=True)
    p.add_argument('--params', default='{}')
    a = p.parse_args()
    print(json.dumps(fetch(a.run, a.name, a.url, json.loads(a.params)), ensure_ascii=False))
