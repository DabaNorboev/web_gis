#!/usr/bin/env python3
"""Fetch one bounded air window and publish a verified local A11 snapshot."""
import argparse
import datetime as dt
import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import stat
import sys
import tempfile
import urllib.parse
import urllib.request

SPEC = importlib.util.spec_from_file_location('air_snapshot', Path(__file__).with_name('import-snapshot.py'))
snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot)
HISTORY_SPEC = importlib.util.spec_from_file_location('annual_history', Path(__file__).with_name('annual_history.py'))
history = importlib.util.module_from_spec(HISTORY_SPEC)
HISTORY_SPEC.loader.exec_module(history)
BASE_URL = 'https://air.krasn.ru/api/2.0'
EVIDENCE = Path(__file__).parents[2] / 'tests/Fixtures/air/a11-1-v1'
MAX_HOURS = 168
MAX_STATIONS = 20
MAX_RESPONSE = 2 * 1024 * 1024
NETWORK_SECONDS = 15


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url, params):
    target = url + ('?' + urllib.parse.urlencode(params) if params else '')
    request = urllib.request.Request(target, headers={'Accept': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=5) as response:
        snapshot.require(response.status == 200 and response.headers.get_content_type() == 'application/json',
                         'Unexpected HTTP response')
        body = response.read(MAX_RESPONSE + 1)
        return body, response.headers.get('Date')


def deadline(_signum, _frame):
    raise TimeoutError('Air network budget exhausted')


def acquire(station_ids, window, transport):
    params = {'projects': '9', 'sites': ','.join(str(s) for s in station_ids),
              'time_interval': 'hour', 'time_begin': window['begin_inclusive'],
              'time_end': window['end_exclusive']}
    requests = [('project.json', BASE_URL + '/projects/9', {}), ('hourly.json', BASE_URL + '/data', params)]
    origins, products = [], {}
    previous = signal.signal(signal.SIGALRM, deadline)
    signal.setitimer(signal.ITIMER_REAL, NETWORK_SECONDS)
    try:
        for name, url, query in requests:
            body, date = transport(url, query)
            snapshot.require(len(body) <= MAX_RESPONSE, 'Response exceeds byte budget')
            origins.append({'name': name, 'url': url, 'params': query, 'retrieved_at': now().replace('Z', '+00:00'),
                            'status': 200, 'date': date, 'bytes': len(body), 'sha256': snapshot.digest(body)})
            products['raw/' + name] = body
            snapshot.envelope(snapshot.decode(body))
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    return origins, products


def prepare_input(target, station_ids, window, origins, products):
    project_path, hourly_path = 'raw/project.json', 'raw/hourly.json'
    project = snapshot.envelope(snapshot.decode(products[project_path]))
    sites = [s for s in project['sites'] if s['id'] in station_ids]
    snapshot.require(sorted(s['id'] for s in sites) == sorted(station_ids), 'Selected station missing or duplicated')
    stations = [snapshot.station_from_raw(s, project_path) for s in sites]
    rows = snapshot.envelope(snapshot.decode(products[hourly_path]))
    snapshot.require(isinstance(rows, list) and rows, 'Hourly response contains no observation rows')
    observations = (snapshot.observation_from_raw(row, hourly_path, i) for i, row in enumerate(rows))

    # Reuse the pinned A11 evidence for the unit mapping. Its acquisition dates
    # describe that evidence only. The two new origins describe this run.
    excerpt_bytes = (EVIDENCE / 'client-excerpt.json').read_bytes()
    excerpt = snapshot.decode(excerpt_bytes)
    evidence = snapshot.decode((EVIDENCE / 'origins.json').read_bytes())
    products.update({
        excerpt['excerpt']: (EVIDENCE / excerpt['excerpt']).read_bytes(),
        'client-excerpt.json': excerpt_bytes,
        'origins.json': snapshot.encode(origins + [o for o in evidence if o['name'] == excerpt['original_name']]),
        'stations.json': snapshot.encode(stations),
        'observations.jsonl': b''.join(snapshot.encode(row) for row in observations),
        'checks.json': snapshot.encode({'scope': 'bounded refresh; observation checks performed by A11 importer'}),
    })
    for name, body in products.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    (target / 'manifest.json').write_bytes(snapshot.encode({
        'schema': 'placelens.air-input.v1', 'purpose': 'scheduled air window',
        'prepared_at': now().replace('Z', '+00:00'), 'window_raw': window, 'timezone': None, 'utc_offset': None,
        'files': [{'path': name, 'bytes': len(body), 'sha256': snapshot.digest(body)}
                  for name, body in sorted(products.items())],
    }))
    return snapshot.digest(snapshot.encode({
        'window': window, 'stations': sorted(station_ids), 'responses': [o['sha256'] for o in origins],
    }))


def verify_release(root, pin):
    snapshot.require(root.is_dir() and not root.is_symlink(), 'Invalid release directory')
    manifest_path = root / 'manifest.json'
    snapshot.require(not manifest_path.is_symlink() and manifest_path.is_file(), 'Invalid release manifest')
    with manifest_path.open('rb') as stream:
        body = stream.read(65537)
    snapshot.require(len(body) <= 65536 and snapshot.digest(body) == pin, 'Manifest pin or size mismatch')
    manifest = snapshot.decode(body)
    snapshot.require(manifest['schema'] == 'placelens.air-snapshot.v1' and manifest['state'] == 'ready',
                     'Release is not ready')
    inventory = {entry['path']: entry for entry in manifest['files']}
    snapshot.require(len(inventory) == len(manifest['files']), 'Duplicate snapshot inventory entry')
    for name, limit in {'stations.json': 65536, 'coverage.json': 65536,
                        'observations.jsonl': 8 * 1024 * 1024}.items():
        snapshot.require(0 <= inventory[name]['bytes'] <= limit, 'Product exceeds reader budget')
    for path in root.rglob('*'):
        snapshot.require(not path.is_symlink(), 'Unexpected snapshot symlink')
        if path.is_dir() or path == manifest_path:
            continue
        item = inventory.pop(path.relative_to(root).as_posix(), None)
        info = path.stat()
        snapshot.require(item is not None and stat.S_ISREG(info.st_mode) and info.st_size == item['bytes'],
                         'Snapshot inventory mismatch')
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(65536), b''):
                digest.update(chunk)
        snapshot.require(digest.hexdigest() == item['sha256'], 'Snapshot hash mismatch')
    snapshot.require(not inventory, 'Incomplete snapshot inventory')
    return manifest


def write_atomic(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.air-', delete=False) as stream:
        pending = Path(stream.name)
        try:
            os.fchmod(stream.fileno(), 0o644)
            stream.write(snapshot.encode(data))
            stream.flush()
            os.fsync(stream.fileno())
            pending.replace(path)
        finally:
            pending.unlink(missing_ok=True)


def prune(releases, keep, retention_days):
    cutoff = dt.datetime.now(dt.timezone.utc).timestamp() - retention_days * 86400
    for entry in releases.iterdir():
        if (entry.name != keep and re.fullmatch('[a-f0-9]{64}', entry.name) and not entry.is_symlink()
                and entry.is_dir() and entry.stat().st_mtime < cutoff):
            shutil.rmtree(entry)


def configured_stations(root, fallback):
    profile = root / 'station-ids.json'
    if profile.is_symlink():
        raise ValueError('Station list cannot be a symlink')
    if profile.exists():
        snapshot.require(profile.is_file(), 'Invalid station list file')
        with profile.open('rb') as stream:
            body = stream.read(2049)
        snapshot.require(len(body) <= 2048, 'Station list exceeds byte budget')
        return snapshot.decode(body)
    return fallback


def refresh(root, station_ids, end_raw, hours, retention_days, transport=fetch):
    end = snapshot.hour(end_raw)
    snapshot.require(1 <= hours <= MAX_HOURS and 1 <= retention_days <= 3650, 'Invalid window or retention')
    window = {'begin_inclusive': (end - dt.timedelta(hours=hours)).isoformat(sep=' '), 'end_exclusive': end_raw}
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.update.lock').open('a') as update_lock:
        try:
            fcntl.flock(update_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 'busy'
        station_ids = configured_stations(root, station_ids)
        snapshot.require(isinstance(station_ids, list) and 1 <= len(station_ids) <= MAX_STATIONS
                         and all(type(s) is int and 1 <= s <= 2**53 - 1 for s in station_ids)
                         and len(station_ids) == len(set(station_ids)), 'Invalid station IDs')
        write_atomic(root / 'attempt.json', {'last_attempt_at': now()})
        releases = root / 'releases'
        releases.mkdir(exist_ok=True)
        active_path = root / 'active.json'
        active_pin = None
        active_manifest = None
        archive = root / 'hourly-history.sqlite3'
        try:
            active = snapshot.decode(active_path.read_bytes())
            existing = active.get('snapshot_version') if isinstance(active, dict) else None
            if isinstance(existing, str) and re.fullmatch('[a-f0-9]{64}', existing):
                manifest = verify_release(releases / existing, existing)
                active_end = snapshot.hour(manifest['window_raw']['end_exclusive'])
                if end < active_end:
                    return 'older_window'
                active_pin = existing
                active_manifest = manifest
        except (OSError, ValueError, KeyError, TypeError):
            pass  # A new verified release can repair damaged local state.

        with tempfile.TemporaryDirectory(dir=root, prefix='.refresh-') as staging:
            staging = Path(staging)
            origins, products = acquire(station_ids, window, transport)
            fingerprint = prepare_input(staging / 'input', station_ids, window, origins, products)
            candidate = staging / 'release'
            snapshot.import_snapshot(staging / 'input', candidate)
            pin = snapshot.digest((candidate / 'manifest.json').read_bytes())
            candidate_manifest = verify_release(candidate, pin)
            coverage = snapshot.decode((candidate / 'coverage.json').read_bytes())
            last_observed = max((s['last_observed_at_raw'] for s in coverage if s['last_observed_at_raw']), default=None)
            if active_pin is not None and active.get('fingerprint') == fingerprint:
                pin = active_pin
            else:
                destination = releases / pin
                if destination.exists():
                    verify_release(destination, pin)
                else:
                    candidate.rename(destination)
            if active_pin is not None and active_pin != pin:
                history.record(archive, releases / active_pin, active_pin, active_manifest, snapshot)
            with (root / '.publish.lock').open('a') as publish_lock:
                fcntl.flock(publish_lock, fcntl.LOCK_EX)
                write_atomic(active_path, {
                    'snapshot_version': pin, 'fingerprint': fingerprint,
                    'last_success_at': now(), 'last_observed_at_raw': last_observed,
                })
            # Recover an interrupted archive write from the current active release on the next run.
            history.record(archive, releases / pin, pin,
                           active_manifest if pin == active_pin else candidate_manifest, snapshot)
            try:
                prune(releases, pin, retention_days)
            except OSError:
                print('Air snapshot retention cleanup incomplete.', file=sys.stderr)
    return 'ready'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--stations', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--hours', required=True, type=int)
    parser.add_argument('--retention-days', required=True, type=int)
    args = parser.parse_args()
    try:
        print(refresh(args.root, list(map(int, args.stations.split(','))), args.end, args.hours, args.retention_days))
    except (ValueError, KeyError, TypeError, OSError, OverflowError, AttributeError, IndexError, sqlite3.Error) as error:
        print('Air refresh rejected: ' + type(error).__name__, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
