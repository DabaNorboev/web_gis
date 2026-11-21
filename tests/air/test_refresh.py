"""Isolated acquisition and publication checks with no source traffic."""
import datetime as dt
import importlib.util
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('air_refresh', ROOT / 'scripts/air/refresh.py')
REFRESH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REFRESH)
A11 = REFRESH.snapshot
END = '2026-08-09 04:00:00'
STATIONS = [1001, 1002]


def response(data, code=1):
    return A11.encode({'status': {'code': code}, 'data': data}), None


def source(url, params, value=0, *, end=END, hours=4):
    if url.endswith('/projects/9'):
        return response({'id': 9, 'sites': [
            {'id': s, 'name': f'Synthetic {s}', 'geom_x': 1, 'geom_y': 1} for s in STATIONS
        ]})
    assert url.endswith('/data')
    begin = A11.hour(end) - dt.timedelta(hours=hours)
    assert params == {'projects': '9', 'sites': '1001,1002', 'time_interval': 'hour',
                      'time_begin': begin.isoformat(sep=' '), 'time_end': end}
    return response([
        {'site': 1001, 'time': begin.isoformat(sep=' '), 'pm25': value},
        {'site': 1001, 'time': (begin + dt.timedelta(hours=1)).isoformat(sep=' '), 'pm25': None},
        {'site': 1001, 'time': (begin + dt.timedelta(hours=3)).isoformat(sep=' ')},
    ])


def broken_publication(path, state):
    if path.name == 'active.json':
        raise OSError('Synthetic failure before pointer replacement')
    write_atomic(path, state)


write_atomic = REFRESH.write_atomic


def refresh(root, transport=source):
    return REFRESH.refresh(root, STATIONS, END, 4, 1, transport)


def holding_refresh(root, entered, proceed, outcomes):
    def slow_source(url, params):
        if url.endswith('/projects/9'):
            entered.set()
            if not proceed.wait(10):
                raise TimeoutError
        return source(url, params)

    outcomes.put(refresh(root, slow_source))


class RefreshTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def active(self):
        return A11.decode((self.root / 'active.json').read_bytes())

    def test_older_window_preserves_active_history_and_skips_retention(self):
        self.assertEqual(refresh(self.root), 'ready')
        releases = self.root / 'releases'
        previous = releases / self.active()['snapshot_version']
        active_end = '2026-08-10 04:00:00'
        self.assertEqual(REFRESH.refresh(self.root, STATIONS, active_end, 28, 1,
                                        lambda u, p: source(u, p, 14, end=active_end, hours=28)), 'ready')
        active = self.active()
        # The old request ends after the active release's last observation.
        self.assertLess(active['last_observed_at_raw'], END)
        pin = active['snapshot_version']
        observations = releases / pin / 'observations.jsonl'
        prior_history = observations.read_bytes()
        expired = dt.datetime.now(dt.timezone.utc).timestamp() - 2 * 86400
        os.utime(previous, (expired, expired))

        old_source = Mock(wraps=source)
        self.assertEqual(refresh(self.root, old_source), 'older_window')
        old_source.assert_not_called()
        self.assertEqual(self.active(), active)
        self.assertEqual(observations.read_bytes(), prior_history)
        self.assertEqual(set(releases.iterdir()), {previous, releases / pin})
        REFRESH.verify_release(releases / pin, pin)

        newer_end = '2026-08-11 04:00:00'
        self.assertEqual(REFRESH.refresh(self.root, STATIONS, newer_end, 4, 1,
                                        lambda u, p: source(u, p, end=newer_end)), 'ready')
        newer_pin = self.active()['snapshot_version']
        self.assertNotEqual(newer_pin, pin)
        manifest = A11.decode((releases / newer_pin / 'manifest.json').read_bytes())
        self.assertEqual(manifest['window_raw']['end_exclusive'], newer_end)
        self.assertFalse(previous.exists())

    def test_repeated_window_reuses_version_and_changed_observation_has_raw_provenance(self):
        attempts = iter(f'2026-11-20T00:00:{i:02}Z' for i in range(30))
        with patch.object(REFRESH, 'now', side_effect=lambda: next(attempts)):
            self.assertEqual(refresh(self.root), 'ready')
            first = self.active()
            self.assertEqual(refresh(self.root), 'ready')
            replay = self.active()
            self.assertEqual(first['snapshot_version'], replay['snapshot_version'])
            self.assertEqual(len(list((self.root / 'releases').iterdir())), 1)
            self.assertNotEqual(replay['last_success_at'], first['last_success_at'])
            self.assertEqual(replay['last_observed_at_raw'], '2026-08-09 03:00:00')
            attempt = A11.decode((self.root / 'attempt.json').read_bytes())
            self.assertLess(attempt['last_attempt_at'], replay['last_success_at'])
            # Age the old release. Retention applies only after a successful switch.
            old = self.root / 'releases' / first['snapshot_version']
            expired = dt.datetime.now(dt.timezone.utc).timestamp() - 2 * 86400
            os.utime(old, (expired, expired))
            self.assertEqual(refresh(self.root, lambda u, p: source(u, p, 14)), 'ready')
            pin = self.active()['snapshot_version']
            self.assertNotEqual(pin, first['snapshot_version'])
            self.assertFalse(old.exists())
            corrected = self.root / 'releases' / pin
            self.assertEqual(A11.decode((corrected / 'input/raw/hourly.json').read_bytes())['data'][0]['pm25'], 14)
            REFRESH.verify_release(corrected, pin)

    def test_failed_source_inventory_or_publication_does_not_replace_active_release(self):
        refresh(self.root)
        prior = (self.root / 'active.json').read_bytes()
        attempt = (self.root / 'attempt.json').read_bytes()
        for failure in (
            lambda u, p: response([], code=0),
            lambda u, p: (b' ' * (REFRESH.MAX_RESPONSE + 1), None),
            lambda u, p: response([]) if u.endswith('/data') else source(u, p),
            lambda u, p: response([{'site': 1001, 'time': END, 'pm25': 9}]) if u.endswith('/data') else source(u, p),
            lambda u, p: response([{'site': 9999, 'time': '2026-08-09 01:00:00', 'pm25': 9}]) if u.endswith('/data') else source(u, p),
        ):
            with self.assertRaises(ValueError):
                refresh(self.root, failure)
            self.assertEqual((self.root / 'active.json').read_bytes(), prior)
        with patch.object(REFRESH, 'verify_release', side_effect=ValueError('Damaged candidate')):
            with self.assertRaises(ValueError):
                refresh(self.root)
        with patch.object(REFRESH, 'write_atomic', side_effect=broken_publication):
            with self.assertRaises(OSError):
                refresh(self.root, lambda u, p: source(u, p, 17))
        self.assertEqual((self.root / 'active.json').read_bytes(), prior)
        self.assertNotEqual((self.root / 'attempt.json').read_bytes(), attempt)
        pin = self.active()['snapshot_version']
        REFRESH.verify_release(self.root / 'releases' / pin, pin)

    def test_network_deadline_applies_to_the_entire_acquisition(self):
        def hanging_source(*_):
            import time
            time.sleep(10)

        with patch.object(REFRESH, 'NETWORK_SECONDS', .02):
            with self.assertRaises(TimeoutError):
                refresh(self.root, hanging_source)
        self.assertFalse((self.root / 'active.json').exists())

    def test_processes_cannot_fetch_the_same_window_concurrently(self):
        context = multiprocessing.get_context('fork')
        entered, proceed, outcomes = context.Event(), context.Event(), context.Queue()
        process = context.Process(target=holding_refresh, args=(self.root, entered, proceed, outcomes))
        process.start()
        try:
            self.assertTrue(entered.wait(5))
            attempt = (self.root / 'attempt.json').read_bytes()
            self.assertEqual(refresh(self.root, lambda *_: self.fail('Overlapping acquisition')), 'busy')
            self.assertEqual((self.root / 'attempt.json').read_bytes(), attempt)
        finally:
            proceed.set()
            process.join(5)
            if process.is_alive():
                process.kill()
                process.join()
        self.assertEqual(process.exitcode, 0)
        self.assertEqual(outcomes.get(timeout=2), 'ready')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] in ('publish-fixture', 'fail-publication'):
        root = Path(sys.argv[2])
        if sys.argv[1] == 'fail-publication':
            with patch.object(REFRESH, 'write_atomic', side_effect=broken_publication):
                try:
                    refresh(root, lambda u, p: source(u, p, 17))
                except OSError as error:
                    if str(error) == 'Synthetic failure before pointer replacement':
                        sys.exit(0)
            sys.exit(1)
        sys.exit(0 if refresh(root) == 'ready' else 1)
    unittest.main()
