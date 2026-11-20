#!/usr/bin/env python3
"""Pin the saved A2 air responses as a small development input; no network or DB."""
import argparse
import datetime as dt
import hashlib
import json
import math
from pathlib import Path

SITES = [4228, 3846, 3858]
FILES = {
    'air-project9-api.json': 'af9dbf67d2065b408d4fcc9c496a5b1b59acbf9eab28e4bfde09fe000a187451',
    'air-2026-week.json': '6f2f3fd6d2f3ebe01a97e63493f871e15f03341790c94c09cd40cd731ca9548f',
    'air-help.html': 'e3b53725d4626ec811fbaf70db99240b568154b16dd6b0a7691d1635f83aef72',
    'air-data-app.js': '52dcf09a7de7c152f9499cd5b21b31af6700fef525c6cd40e62fe79fac0fcc30',
}


def digest(body):
    return hashlib.sha256(body).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def prepare(source, access, output):
    bodies = {name: (source / 'raw' / name).read_bytes() for name in FILES}
    for name, body in bodies.items():
        if digest(body) != FILES[name]:
            raise ValueError('Saved input hash mismatch: ' + name)
    requests = [json.loads(line) for line in (source / 'requests.jsonl').read_text().splitlines()]
    origins = []
    for name in FILES:
        matches = [r for r in requests if r['name'] == name and r.get('sha256') == FILES[name]]
        if len(matches) != 1 or matches[0]['bytes'] != len(bodies[name]):
            raise ValueError('Acquisition record mismatch: ' + name)
        origins.append(matches[0])
    project = json.loads(bodies['air-project9-api.json'])
    observations = json.loads(bodies['air-2026-week.json'])
    if any(x['status']['code'] != 1 for x in [project, observations]):
        raise ValueError('Not a successful API envelope')
    sites = {s['id']: s for s in project['data']['sites']}
    records = observations['data']
    start = dt.datetime(2026, 8, 9)
    expected = {(sid, (start + dt.timedelta(hours=h)).isoformat(sep=' '))
                for sid in SITES for h in range(168)}
    seen = set()
    normalized = []
    for i, row in enumerate(records):
        key = (row['site'], row['time'])
        if key not in expected or key in seen:
            raise ValueError('Duplicate or out-of-scope source key')
        seen.add(key)
        value = row.get('pm25')
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                                  or not math.isfinite(value)):
            raise ValueError('Invalid PM2.5 value')
        normalized.append({
            'source': 'air.krasn.ru/project/9', 'station_id': str(row['site']),
            'observed_at_raw': row['time'], 'timezone': None, 'utc_offset': None,
            'observed_at_utc': None, 'time_reason': 'SOURCE_TIMEZONE_UNCONFIRMED',
            'aggregation': 'hourly', 'indicator': 'pm2_5', 'source_field': 'pm25',
            'unit': 'µg/m³', 'value': value, 'row_present': True,
            'missing_reason': 'SOURCE_VALUE_NULL_OR_ABSENT' if value is None else None,
            'qc': 'UNKNOWN', 'qc_raw': None, 'qc_reason': 'SOURCE_QC_NOT_PROVIDED',
            'raw_file': 'raw/air-2026-week.json', 'raw_index': i,
        })
    if len(records) != 504 or seen != expected:
        raise ValueError('Saved week is not the expected 504 hourly keys')
    client = bodies['air-data-app.js']
    marker = b'{id:_r.iPm25,name:"PM2.5",units:"\\u043c\\u043a\\u0433/\\u043c3",field:"pm25"}'
    offset = client.index(marker)
    output.mkdir(parents=True, exist_ok=False)
    (output / 'raw').mkdir()
    for name in FILES:
        if name != 'air-data-app.js':
            (output / 'raw' / name).write_bytes(bodies[name])
    (output / 'raw/client-pm25-excerpt.js.txt').write_bytes(marker)
    write_json(output / 'origins.json', origins)
    write_json(output / 'client-excerpt.json', {
        'original_name': 'air-data-app.js', 'original_sha256': FILES['air-data-app.js'],
        'original_bytes': len(client), 'byte_offset': offset, 'length': len(marker),
        'excerpt': 'raw/client-pm25-excerpt.js.txt'})
    stations = []
    for sid in SITES:
        s = sites[sid]
        stations.append({
            'source': 'air.krasn.ru/project/9', 'station_id': str(sid), 'name': s['name'],
            'lon': s['geom_x'], 'lat': s['geom_y'], 'crs': None,
            'coordinate_reason': 'SOURCE_DATUM_CRS_UNCONFIRMED',
            'coordinate_source': 'raw/air-project9-api.json', 'coordinate_source_id': sid,
            'coordinate_observed_at': None, 'source_updated_at': None,
            'status': 'UNKNOWN', 'timezone': None,
            'metadata_reason': 'SOURCE_DATES_ARE_NOT_COORDINATE_OBSERVATION_OR_UPDATE_TIMES',
            'coordinate_history': None, 'equipment_history': None,
            'history_reason': 'NOT_PROVIDED',
            'source_begin_date': s.get('begin_date'), 'source_end_date': s.get('end_date'),
        })
    write_json(output / 'stations.json', stations)
    with (output / 'observations.jsonl').open('x') as stream:
        for row in normalized:
            stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + '\n')
    # Preserve the actual fresh probe separately from reused 2026-11-03 responses.
    (output / 'access').mkdir()
    for name in ['requests.jsonl', 'project9.json', 'one-hour.json']:
        path = access / name
        if path.exists():
            (output / 'access' / name).write_bytes(path.read_bytes())
    stats = []
    for sid in SITES:
        rows = [r for r in normalized if r['station_id'] == str(sid)]
        stats.append({'station_id': str(sid), 'rows': len(rows),
                      'missing_hour_bins': 168 - len(rows),
                      'null_values': sum(r['value'] is None for r in rows),
                      'zero_values': sum(r['value'] == 0 for r in rows),
                      'min': min(r['value'] for r in rows if r['value'] is not None),
                      'max': max(r['value'] for r in rows if r['value'] is not None)})
    write_json(output / 'checks.json', {
        'rows': len(records), 'unique_keys': len(seen), 'duplicates': 0,
        'out_of_scope': 0, 'stations': stats,
        'raw_fields': sorted(set().union(*(r.keys() for r in records))),
        'qc_fields_found': [], 'value_comparison_count': len(normalized),
        'temperature_minus_42_5_rows': sum(r.get('t') == -42.5 for r in records),
    })
    inventory = [{'path': p.relative_to(output).as_posix(), 'bytes': p.stat().st_size,
                  'sha256': digest(p.read_bytes())}
                 for p in sorted(output.rglob('*')) if p.is_file()]
    write_json(output / 'manifest.json', {
        'schema': 'placelens.air-input.v1', 'purpose': 'development input; no runtime activation',
        'prepared_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'source_run': source.as_posix(), 'access_run': access.as_posix(),
        'window_raw': {'begin_inclusive': '2026-08-09 00:00:00',
                       'end_exclusive': '2026-08-16 00:00:00'},
        'timezone': None, 'utc_offset': None, 'files': inventory,
    })
    print(json.dumps({'output': str(output), 'stations': stats,
                      'manifest_sha256': digest((output / 'manifest.json').read_bytes())}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--access', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    prepare(args.source, args.access, args.output)
