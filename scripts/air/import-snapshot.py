#!/usr/bin/env python3
"""Validate air-input.v1 offline and write a new, unactivated air-snapshot.v1."""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sys

SOURCE = 'air.krasn.ru/project/9'
KEY = ('source', 'station_id', 'observed_at_raw', 'indicator', 'aggregation')
POLICY = 'identical semantics collapse with union of raw references; any conflict rejects input'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False,
                       separators=(',', ':')) + '\n').encode('utf-8')


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result, 'Duplicate JSON member: ' + key)
        result[key] = value
    return result


def decode(body):
    def invalid(value):
        raise ValueError('Nonfinite JSON number: ' + value)
    return json.loads(body, object_pairs_hook=pairs, parse_constant=invalid)


def safe_path(name):
    require(isinstance(name, str) and name and '\\' not in name, 'Invalid inventory path')
    path = PurePosixPath(name)
    require(not path.is_absolute() and path.as_posix() == name
            and all(p not in ('..', '.') for p in path.parts), 'Unsafe inventory path: ' + name)
    return path


def load_input(root):
    require(root.is_dir() and not root.is_symlink(), 'Input must be a real directory')
    manifest_path = root / 'manifest.json'
    require(not manifest_path.is_symlink(), 'Symlink manifest rejected')
    body = manifest_path.read_bytes()
    manifest = decode(body)
    require(manifest['schema'] == 'placelens.air-input.v1', 'Unsupported input schema')
    require(isinstance(manifest['purpose'], str) and manifest['purpose'], 'Missing purpose')
    require(isinstance(manifest['prepared_at'], str), 'Missing preparation time')
    dt.datetime.fromisoformat(manifest['prepared_at'])
    require(manifest['timezone'] is None and manifest['utc_offset'] is None,
            'v1 timezone must remain unknown')
    require(isinstance(manifest['files'], list) and manifest['files'], 'Empty inventory')
    files = {'manifest.json': body}
    for entry in manifest['files']:
        name = entry['path']
        path = safe_path(name)
        require(name not in files, 'Duplicate/reserved inventory path: ' + name)
        current = root
        for part in path.parts:
            current = current / part
            require(not current.is_symlink(), 'Symlink input rejected: ' + name)
        require(current.is_file(), 'Missing inventory file: ' + name)
        data = current.read_bytes()
        require(type(entry['bytes']) is int and entry['bytes'] >= 0
                and len(data) == entry['bytes'], 'Size mismatch: ' + name)
        require(isinstance(entry['sha256'], str)
                and re.fullmatch('[0-9a-f]{64}', entry['sha256'])
                and digest(data) == entry['sha256'], 'Hash mismatch: ' + name)
        files[name] = data
    # Reject unlisted files and directory symlinks too; never copy a live tree later.
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            path = Path(directory) / name
            require(not path.is_symlink(), 'Symlink input rejected')
        for name in names:
            require((Path(directory) / name).relative_to(root).as_posix() in files,
                    'Unlisted input file')
    for name in ('stations.json', 'observations.jsonl', 'origins.json', 'checks.json',
                 'client-excerpt.json', 'raw/client-pm25-excerpt.js.txt'):
        require(name in files, 'Required input missing: ' + name)
    return manifest, files


def hour(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\d \d\d:00:00', value),
            'Expected source hourly time string')
    return dt.datetime.strptime(value, '%Y-%m-%d %H:%M:%S')


def numeric(value):
    require(value is None or (type(value) in (int, float) and math.isfinite(value)),
            'Non-numeric/nonfinite source value')
    return int(value) if type(value) is float and value.is_integer() else value


def envelope(value):
    require(isinstance(value, dict) and isinstance(value.get('status'), dict)
            and type(value['status'].get('code')) is int and value['status']['code'] == 1
            and 'data' in value, 'Unsuccessful API envelope (even if HTTP 200)')
    return value['data']


def station_from_raw(raw, path):
    require(type(raw['id']) is int, 'Invalid source station ID')
    require(isinstance(raw['name'], str) and raw['name'], 'Invalid station name')
    for field in ('geom_x', 'geom_y'):
        numeric(raw[field])
    return {
        'source': SOURCE, 'station_id': str(raw['id']), 'name': raw['name'],
        'lon': raw['geom_x'], 'lat': raw['geom_y'], 'crs': None,
        'coordinate_reason': 'SOURCE_DATUM_CRS_UNCONFIRMED',
        'coordinate_source': path, 'coordinate_source_id': raw['id'],
        'coordinate_observed_at': None, 'source_updated_at': None, 'status': 'UNKNOWN',
        'timezone': None,
        'metadata_reason': 'SOURCE_DATES_ARE_NOT_COORDINATE_OBSERVATION_OR_UPDATE_TIMES',
        'coordinate_history': None, 'equipment_history': None, 'history_reason': 'NOT_PROVIDED',
        'source_begin_date': raw.get('begin_date'), 'source_end_date': raw.get('end_date'),
    }


def observation_from_raw(raw, path, index):
    require(type(raw['site']) is int, 'Invalid raw station ID')
    hour(raw['time'])
    value = numeric(raw.get('pm25'))
    return {
        'source': SOURCE, 'station_id': str(raw['site']), 'observed_at_raw': raw['time'],
        'timezone': None, 'utc_offset': None, 'observed_at_utc': None,
        'time_reason': 'SOURCE_TIMEZONE_UNCONFIRMED', 'aggregation': 'hourly',
        'indicator': 'pm2_5', 'source_field': 'pm25', 'unit': 'µg/m³', 'value': value,
        'row_present': True,
        'missing_reason': 'SOURCE_VALUE_NULL_OR_ABSENT' if value is None else None,
        'qc': 'UNKNOWN', 'qc_raw': None, 'qc_reason': 'SOURCE_QC_NOT_PROVIDED',
        'raw_file': path, 'raw_index': index,
    }


def validate(manifest, files):
    begin = hour(manifest['window_raw']['begin_inclusive'])
    end = hour(manifest['window_raw']['end_exclusive'])
    require(begin < end, 'Empty/reversed window')
    origins = decode(files['origins.json'])
    require(isinstance(origins, list) and origins, 'Missing origins')
    json_files = {name: decode(body) for name, body in files.items() if name.endswith('.json')}
    for name, value in json_files.items():
        if name.startswith(('raw/', 'access/')):
            envelope(value)
    raw_series = {}
    for origin in origins:
        name = origin['name']
        require(isinstance(name, str) and PurePosixPath(name).name == name, 'Invalid origin name')
        path = 'raw/' + name
        require(type(origin['status']) is int and origin['status'] == 200, 'Origin HTTP failure')
        require(isinstance(origin['url'], str) and isinstance(origin['retrieved_at'], str),
                'Incomplete provenance')
        dt.datetime.fromisoformat(origin['retrieved_at'])
        if path in files:
            require(origin['bytes'] == len(files[path]) and origin['sha256'] == digest(files[path]),
                    'Origin size/hash mismatch')
        params = origin.get('params')
        if isinstance(params, dict) and params.get('time_interval') == 'hour':
            require(path in json_files and path not in raw_series, 'Missing/duplicate raw series')
            require(params['projects'] == '9'
                    and params['time_begin'] == manifest['window_raw']['begin_inclusive']
                    and params['time_end'] == manifest['window_raw']['end_exclusive'],
                    'Origin window/project mismatch')
            rows = envelope(json_files[path])
            require(isinstance(rows, list), 'Raw series must be an array')
            raw_series[path] = rows
    require(raw_series, 'No hourly raw series with provenance')
    excerpt = decode(files['client-excerpt.json'])
    require(excerpt['excerpt'] == 'raw/client-pm25-excerpt.js.txt'
            and excerpt['length'] == len(files[excerpt['excerpt']]), 'Invalid client excerpt')
    require(any(o['name'] == excerpt['original_name']
                and o['sha256'] == excerpt['original_sha256']
                and o['bytes'] == excerpt['original_bytes'] for o in origins), 'Excerpt origin missing')
    require(files[excerpt['excerpt']] ==
            b'{id:_r.iPm25,name:"PM2.5",units:"\\u043c\\u043a\\u0433/\\u043c3",field:"pm25"}',
            'Unrecognized PM2.5 unit mapping')
    stations = decode(files['stations.json'])
    require(isinstance(stations, list) and stations, 'Missing station list')
    station_map = {}
    for station in stations:
        key = (station['source'], station['station_id'])
        require(key not in station_map, 'Duplicate station identity')
        path = station['coordinate_source']
        require(path in json_files and path.startswith('raw/'), 'Unlisted coordinate source')
        project = envelope(json_files[path])
        require(project['id'] == 9, 'Wrong station project')
        require(any('raw/' + o['name'] == path for o in origins), 'Station origin missing')
        matches = [s for s in project['sites'] if s['id'] == station['coordinate_source_id']]
        require(len(matches) == 1 and encode(station) == encode(station_from_raw(matches[0], path)),
                'Station metadata differs from raw/unknown v1 contract')
        station_map[key] = station
    # Validate every raw record, not just normalized references; input cannot silently omit rows.
    expected = {}
    for path, rows in raw_series.items():
        for index, raw in enumerate(rows):
            row = observation_from_raw(raw, path, index)
            require((row['source'], row['station_id']) in station_map, 'Unknown raw station')
            require(begin <= hour(row['observed_at_raw']) < end, 'Raw row outside window')
            expected[(path, index)] = row
    seen, merged = set(), {}
    lines = files['observations.jsonl'].decode('utf-8').splitlines()
    for line in lines:
        row = decode(line)
        require(type(row['raw_index']) is int, 'Invalid raw index')
        ref = (row['raw_file'], row['raw_index'])
        require(ref in expected, 'Unknown raw observation reference')
        numeric(row['value'])
        require(row == expected[ref] and type(row['row_present']) is bool,
                'Normalized observation differs from raw/v1 contract')
        seen.add(ref)
        key = tuple(row[field] for field in KEY)
        semantic = {k: v for k, v in expected[ref].items() if k not in ('raw_file', 'raw_index')}
        reference = {'raw_file': ref[0], 'raw_index': ref[1],
                     'value_field_present': 'pm25' in raw_series[ref[0]][ref[1]]}
        if key not in merged:
            merged[key] = dict(semantic, raw_references=[])
        else:
            require(semantic == {k: v for k, v in merged[key].items() if k != 'raw_references'},
                    'Conflicting duplicate observation key')
        if reference not in merged[key]['raw_references']:
            merged[key]['raw_references'].append(reference)
    require(seen == set(expected), 'Normalized input omits raw observations')
    observations = [merged[key] for key in sorted(merged)]
    for row in observations:
        row['raw_references'].sort(key=lambda r: (r['raw_file'], r['raw_index']))
    coverage = []
    for key in sorted(station_map):
        rows = [r for r in observations if (r['source'], r['station_id']) == key]
        times = sorted(r['observed_at_raw'] for r in rows)
        coverage.append({
            'source': key[0], 'station_id': key[1], 'row_count': len(rows),
            'first_observed_at_raw': times[0] if times else None,
            'last_observed_at_raw': times[-1] if times else None,
            'bounds_reason': 'ACTUAL_INPUT_ROWS' if times else 'SOURCE_ROW_MISSING',
            'null_values': sum(r['value'] is None for r in rows),
            'zero_values': sum(r['value'] == 0 for r in rows),
            'missing_hour_bins': int((end - begin).total_seconds() // 3600) - len(rows),
            'missing_row_reason': 'SOURCE_ROW_MISSING',
        })
    return [station_map[k] for k in sorted(station_map)], observations, coverage, len(lines)


def import_snapshot(source, output):
    require(not output.exists() and not output.is_symlink(), 'Output already exists; never overwritten')
    source_path, output_path = source.resolve(), output.resolve()
    require(source_path != output_path and source_path not in output_path.parents
            and output_path not in source_path.parents, 'Input/output trees must be separate')
    manifest, files = load_input(source)
    stations, observations, coverage, input_rows = validate(manifest, files)
    products = {'input/' + name: body for name, body in files.items()}
    products['stations.json'] = encode(stations)
    products['observations.jsonl'] = b''.join(encode(row) for row in observations)
    products['coverage.json'] = encode(coverage)
    logical_rows = [{k: v for k, v in row.items() if k != 'raw_references'}
                    for row in observations]
    logical_hash = digest(encode({'stations': stations, 'observations': logical_rows, 'coverage': coverage}))
    ready = {
        'schema': 'placelens.air-snapshot.v1', 'state': 'ready', 'activated': False,
        'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'input_manifest_sha256': digest(files['manifest.json']),
        'input_manifest': 'input/manifest.json', 'raw_reference_root': 'input',
        'logical_sha256': logical_hash,
        'observation_key': list(KEY), 'duplicate_policy': POLICY,
        'input_rows': input_rows, 'observations': len(observations), 'stations': len(stations),
        'collapsed_duplicates': input_rows - len(observations),
        'window_raw': manifest['window_raw'], 'timezone': None, 'utc_offset': None,
        'limitations': ['SOURCE_TIMEZONE_UNCONFIRMED', 'SOURCE_DATUM_CRS_UNCONFIRMED',
                        'SOURCE_QC_NOT_PROVIDED', 'EQUIPMENT_AND_COORDINATE_HISTORY_UNKNOWN',
                        'SOURCE_DATES_ARE_NOT_CONFIRMED_STATION_HISTORY',
                        'INPUT_WINDOW_ONLY_NOT_CONTINUOUS_ARCHIVE',
                        'STATION_OBSERVATIONS_NOT_POINT_ESTIMATES', 'SOURCE_ACCURACY_UNCONFIRMED'],
        'files': [{'path': name, 'bytes': len(body), 'sha256': digest(body)}
                  for name, body in sorted(products.items())],
    }
    # All semantic validation precedes writes. Exclusive mkdir also arbitrates concurrent imports.
    # Failure retains an unready directory for diagnosis; existing results are never touched.
    output.mkdir(parents=True, exist_ok=False)
    for name, body in sorted(products.items()):
        path = output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as stream:
            stream.write(body)
    for item in ready['files']:
        body = (output / item['path']).read_bytes()
        require(len(body) == item['bytes'] and digest(body) == item['sha256'],
                'Written snapshot verification failed')
    # Only a complete manifest is a readiness marker; a failed write leaves .pending, never ready.
    pending = output / 'manifest.pending'
    with pending.open('xb') as stream:
        stream.write(encode(ready))
        stream.flush()
        os.fsync(stream.fileno())
    pending.rename(output / 'manifest.json')
    return ready


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        ready = import_snapshot(args.input, args.output)
    except (ValueError, KeyError, TypeError, OSError, OverflowError, AttributeError, IndexError) as error:
        # Do not expose raw bodies, origin URLs or station data in failures.
        print('Air import rejected: ' + type(error).__name__ +
              (': ' + str(error) if type(error) is ValueError else ''), file=sys.stderr)
        return 1
    print(json.dumps({'output': str(args.output), 'observations': ready['observations'],
                      'stations': ready['stations'], 'logical_sha256': ready['logical_sha256']}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
