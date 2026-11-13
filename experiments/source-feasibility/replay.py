"""Replay saved public HTTP requests into a new run, never over an existing run."""
import argparse
import datetime as dt
import json
from pathlib import Path

from fetch import fetch


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-run', required=True, type=Path)
    parser.add_argument('--to-run', required=True, type=Path)
    args = parser.parse_args()
    args.to_run.mkdir(parents=True, exist_ok=False)
    for name in ['raw', 'derived', 'figures', 'evidence']:
        (args.to_run/name).mkdir()
    config = json.loads((args.from_run/'config.json').read_text())
    config.update(run_id=args.to_run.name, created_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                  replay_of=str(args.from_run))
    (args.to_run/'config.json').write_text(json.dumps(config, ensure_ascii=False, indent=2)+'\n')
    (args.to_run/'selected-scenes.json').write_bytes((args.from_run/'selected-scenes.json').read_bytes())
    for line in (args.from_run/'requests.jsonl').read_text().splitlines():
        row = json.loads(line)
        # Sensor table used a public website key; the archive API itself needed no key.
        # Do not replay credentials or successful HTML as if it were a measurement API.
        if row.get('status') != 200 or row.get('credential_source'):
            continue
        result = fetch(args.to_run, row['name'], row['url'], row.get('params'))
        print(json.dumps({'name': row['name'], 'status': result.get('status'),
                          'bytes': result.get('bytes'), 'error': result.get('error_type')}), flush=True)
