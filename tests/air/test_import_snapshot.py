"""Offline synthetic contracts and a separate pinned-real-data smoke; stdlib only."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('air_import', ROOT / 'scripts/air/import-snapshot.py')
AIR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AIR)
REAL = ROOT / 'tests/Fixtures/air/a11-1-v1'


def read(path):
    return json.loads(path.read_bytes())


def observations(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


class SyntheticTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.source = self.base / 'input'
        self.output = self.base / 'snapshot'
        self.source.mkdir()
        # Fabricated stations with deliberately identical names and coordinates: IDs stay independent.
        self.raw_stations = [dict(id=i, name='Synthetic', geom_x=90.0, geom_y=50.0,
                                  begin_date='2000-01-01 00:00:00', end_date=None) for i in (1, 2, 3)]
        # Missing hour 01 for station 1, explicit null at 02; station 3 has no rows at all.
        self.rows = [dict(site=1, time='2026-01-01 00:00:00', pm25=0),
                     dict(site=1, time='2026-01-01 02:00:00', pm25=None),
                     dict(site=2, time='2026-01-01 00:00:00', pm25=12.5)]
        self.manifest = dict(schema='placelens.air-input.v1', purpose='synthetic test',
                             prepared_at='2026-11-13T00:00:00+00:00', timezone=None, utc_offset=None,
                             window_raw=dict(begin_inclusive='2026-01-01 00:00:00',
                                             end_exclusive='2026-01-01 03:00:00'))
        self.project = 'raw/stations.json'
        self.series = 'raw/series.json'
        self.write_package()

    def put(self, name, body):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)

    def inventory(self):
        self.manifest['files'] = [dict(path=p.relative_to(self.source).as_posix(),
                                      bytes=p.stat().st_size, sha256=AIR.digest(p.read_bytes()))
                                  for p in sorted(self.source.rglob('*'))
                                  if p.is_file() and p.name != 'manifest.json']
        self.put('manifest.json', AIR.encode(self.manifest))

    def write_package(self):
        self.put(self.project, AIR.encode(dict(status=dict(code=1), data=dict(id=9, sites=self.raw_stations))))
        self.put(self.series, AIR.encode(dict(status=dict(code=1), data=self.rows)))
        self.put('stations.json', AIR.encode([AIR.station_from_raw(s, self.project) for s in self.raw_stations]))
        self.put('observations.jsonl', b''.join(AIR.encode(AIR.observation_from_raw(r, self.series, i))
                                                for i, r in enumerate(self.rows)))
        marker = b'{id:_r.iPm25,name:"PM2.5",units:"\\u043c\\u043a\\u0433/\\u043c3",field:"pm25"}'
        self.put('raw/client-pm25-excerpt.js.txt', marker)
        self.put('client-excerpt.json', AIR.encode(dict(excerpt='raw/client-pm25-excerpt.js.txt',
                 length=len(marker), original_name='client.js', original_sha256='a' * 64, original_bytes=100)))
        origins = []
        for path in (self.project, self.series):
            body = (self.source / path).read_bytes()
            origins.append(dict(name=Path(path).name, status=200, url='https://example.invalid/synthetic',
                retrieved_at='2026-11-13T00:00:00+00:00', bytes=len(body), sha256=AIR.digest(body),
                params={} if path == self.project else dict(projects='9', time_interval='hour',
                    time_begin=self.manifest['window_raw']['begin_inclusive'],
                    time_end=self.manifest['window_raw']['end_exclusive'])))
        origins.append(dict(name='client.js', status=200, url='https://example.invalid/client.js',
                            retrieved_at='2026-11-13T00:00:00+00:00', bytes=100, sha256='a' * 64))
        self.put('origins.json', AIR.encode(origins))
        # Deliberately false claims; the importer must compute actual facts itself.
        self.put('checks.json', AIR.encode(dict(rows=9999, zero_values=0)))
        self.inventory()

    def refresh_origins(self):
        origins = read(self.source / 'origins.json')
        for origin in origins:
            path = self.source / 'raw' / origin['name']
            if path.is_file():
                body = path.read_bytes()
                origin.update(bytes=len(body), sha256=AIR.digest(body))
        self.put('origins.json', AIR.encode(origins))
        self.inventory()

    def update_json(self, name, mutate):
        value = read(self.source / name)
        mutate(value)
        self.put(name, AIR.encode(value))
        self.inventory()

    def update_normalized(self, mutate):
        rows = observations(self.source / 'observations.jsonl')
        mutate(rows)
        self.put('observations.jsonl', b''.join(AIR.encode(r) for r in rows))
        self.inventory()

    def reject(self):
        with self.assertRaises((ValueError, KeyError, TypeError, OSError)):
            AIR.import_snapshot(self.source, self.output)
        self.assertFalse((self.output / 'manifest.json').exists())

    def test_null_absent_zero_unknown_and_independence(self):
        result = AIR.import_snapshot(self.source, self.output)
        self.assertEqual(result['observations'], 3)
        rows = observations(self.output / 'observations.jsonl')
        self.assertEqual(rows[0]['value'], 0)
        self.assertTrue(rows[0]['row_present'])
        self.assertIsNone(rows[1]['value'])
        self.assertTrue(rows[1]['row_present'])
        self.assertEqual(rows[1]['missing_reason'], 'SOURCE_VALUE_NULL_OR_ABSENT')
        self.assertNotIn('2026-01-01 01:00:00', [r['observed_at_raw'] for r in rows])
        for row in rows:
            self.assertIsNone(row['observed_at_utc'])
            self.assertIsNone(row['timezone'])
            self.assertIsNone(row['utc_offset'])
            self.assertEqual(row['qc'], 'UNKNOWN')
            self.assertIsNone(row['qc_raw'])
        coverage = read(self.output / 'coverage.json')
        self.assertEqual([s['missing_hour_bins'] for s in coverage], [1, 2, 3])
        self.assertEqual(coverage[0]['first_observed_at_raw'], '2026-01-01 00:00:00')
        self.assertEqual(coverage[0]['last_observed_at_raw'], '2026-01-01 02:00:00')
        self.assertIsNone(coverage[2]['first_observed_at_raw'])
        for station in read(self.output / 'stations.json'):
            self.assertEqual(station['source'], AIR.SOURCE)
            self.assertEqual(station['status'], 'UNKNOWN')
            for field in ('crs', 'equipment_history', 'coordinate_history', 'coordinate_observed_at'):
                self.assertIsNone(station[field])
        for item in result['files']:
            data = (self.output / item['path']).read_bytes()
            self.assertEqual(AIR.digest(data), item['sha256'])
            self.assertEqual(len(data), item['bytes'])

    def test_absent_value_field_preserves_raw_distinction(self):
        del self.rows[1]['pm25']
        self.write_package()
        AIR.import_snapshot(self.source, self.output)
        row = observations(self.output / 'observations.jsonl')[1]
        self.assertIsNone(row['value'])
        self.assertFalse(row['raw_references'][0]['value_field_present'])

    def test_reimport_and_refuse_overwrite(self):
        first = AIR.import_snapshot(self.source, self.output)
        previous = (self.output / 'manifest.json').read_bytes()
        with self.assertRaises(ValueError):
            AIR.import_snapshot(self.source, self.output)
        self.assertEqual((self.output / 'manifest.json').read_bytes(), previous)
        second = AIR.import_snapshot(self.source, self.base / 'second')
        self.assertEqual(first['logical_sha256'], second['logical_sha256'])
        self.assertEqual(second['observations'], 3)
        self.assertEqual((self.output / 'observations.jsonl').read_bytes(),
                         (self.base / 'second/observations.jsonl').read_bytes())

    def test_row_permutation_and_identical_duplicates(self):
        first = AIR.import_snapshot(self.source, self.output)
        self.update_normalized(lambda rows: rows.extend([copy.deepcopy(rows[0]), copy.deepcopy(rows[0])]))
        self.update_normalized(lambda rows: rows.reverse())
        second = AIR.import_snapshot(self.source, self.base / 'duplicates')
        self.assertEqual(second['observations'], 3)
        self.assertEqual(second['collapsed_duplicates'], 2)
        self.assertEqual(first['logical_sha256'], second['logical_sha256'])
        self.assertEqual((self.output / 'observations.jsonl').read_bytes(),
                         (self.base / 'duplicates/observations.jsonl').read_bytes())

    def test_raw_permutation_preserves_logical_hash(self):
        first = AIR.import_snapshot(self.source, self.output)
        self.rows.reverse()
        self.write_package()
        second = AIR.import_snapshot(self.source, self.base / 'permuted')
        self.assertEqual(first['logical_sha256'], second['logical_sha256'])

    def test_identical_raw_duplicates_union_references(self):
        self.rows.append(copy.deepcopy(self.rows[0]))
        self.write_package()
        result = AIR.import_snapshot(self.source, self.output)
        self.assertEqual(result['observations'], 3)
        refs = observations(self.output / 'observations.jsonl')[0]['raw_references']
        self.assertEqual([r['raw_index'] for r in refs], [0, 3])

    def test_conflicting_raw_duplicate_rejects_in_both_orders(self):
        self.rows.append(dict(self.rows[0], pm25=99))
        for reverse in (False, True):
            if reverse:
                self.rows.reverse()
            self.write_package()
            self.reject()

    def test_corruption_and_hash_mismatch(self):
        path = self.source / 'observations.jsonl'
        original = path.read_bytes()
        for data in (original + b'x', original.replace(b'12.5', b'13.5')):
            path.write_bytes(data)
            self.reject()
        path.write_bytes(original)
        self.manifest['files'][0]['sha256'] = '0' * 64
        self.put('manifest.json', AIR.encode(self.manifest))
        self.reject()

    def test_200_error_envelope(self):
        self.update_json(self.series, lambda value: value.update(status=dict(code=0), data=[]))
        self.reject()

    def test_unknown_station(self):
        self.rows[0]['site'] = 999
        self.write_package()
        self.reject()

    def test_nonnumeric_and_nonfinite(self):
        for value in ('0', True, {}, [], float('inf'), float('nan')):
            with self.subTest(value=value):
                # Mutate raw and normalized bytes directly for nonfinite JSON cases.
                self.write_package()
                raw = read(self.source / self.series)
                raw['data'][0]['pm25'] = value
                self.put(self.series, json.dumps(raw).encode())
                self.refresh_origins()
                self.reject()

    def test_numeric_representations_have_stable_logical_content(self):
        self.rows[2]['pm25'] = 12
        self.rows.append(dict(self.rows[2], pm25=12.0))
        self.write_package()
        first = AIR.import_snapshot(self.source, self.output)
        self.rows.reverse()
        self.write_package()
        second = AIR.import_snapshot(self.source, self.base / 'numeric-permutation')
        self.assertEqual(first['logical_sha256'], second['logical_sha256'])

    def test_normalized_forgery_and_missing_raw_reference(self):
        for mutate in (lambda r: r[0].update(value=1), lambda r: r[0].update(value=False),
                       lambda r: r[0].update(observed_at_raw='2026-01-01 01:00:00'),
                       lambda r: r[0].update(raw_index=-1), lambda r: r.pop(),
                       lambda r: r[0].update(timezone='Asia/Krasnoyarsk')):
            self.write_package()
            self.update_normalized(mutate)
            self.reject()

    def test_station_metadata_not_inferred(self):
        for mutate in (lambda s: s[0].update(status='ACTIVE'),
                       lambda s: s[0].update(crs='EPSG:4326'),
                       lambda s: s[0].update(lon=1), lambda s: s.append(copy.deepcopy(s[0]))):
            self.write_package()
            self.update_json('stations.json', mutate)
            self.reject()

    def test_unsafe_duplicate_missing_and_unlisted_inventory(self):
        original = copy.deepcopy(self.manifest)
        for path in ('../outside', '/etc/passwd', 'raw/../stations.json', 'raw\\stations.json',
                     './stations.json', 'raw//stations.json'):
            self.manifest = copy.deepcopy(original)
            self.manifest['files'][0]['path'] = path
            self.put('manifest.json', AIR.encode(self.manifest))
            self.reject()
        self.manifest = copy.deepcopy(original)
        self.manifest['files'].append(copy.deepcopy(self.manifest['files'][0]))
        self.put('manifest.json', AIR.encode(self.manifest))
        self.reject()
        self.put('manifest.json', AIR.encode(original))
        self.put('unlisted.txt', b'x')
        self.reject()

    def test_symlink_and_input_output_overlap(self):
        path = self.source / 'checks.json'
        path.unlink()
        path.symlink_to(self.source / 'stations.json')
        self.reject()
        self.write_package_without_symlink()
        with self.assertRaises(ValueError):
            AIR.import_snapshot(self.source, self.source / 'new-snapshot')
        self.assertFalse((self.source / 'new-snapshot').exists())

    def write_package_without_symlink(self):
        (self.source / 'checks.json').unlink()
        self.write_package()

    def test_late_failure_never_publishes_ready_and_preserves_previous(self):
        AIR.import_snapshot(self.source, self.base / 'previous')
        previous = (self.base / 'previous/manifest.json').read_bytes()
        original = Path.open

        def fail(path, *args, **kwargs):
            if path == self.output / 'manifest.pending':
                raise OSError('Synthetic late write failure')
            return original(path, *args, **kwargs)

        with patch.object(Path, 'open', fail):
            self.reject()
        self.assertTrue((self.output / 'observations.jsonl').exists())
        self.assertEqual((self.base / 'previous/manifest.json').read_bytes(), previous)

    def test_written_corruption_and_final_rename_failure(self):
        original = Path.open

        def corrupt(path, *args, **kwargs):
            if path == self.output / 'observations.jsonl' and args == ('xb',):
                stream = original(path, *args, **kwargs)
                class CorruptWriter:
                    def __enter__(self):
                        return self
                    def write(self, body):
                        stream.write(body[:-1])
                    def __exit__(self, *args):
                        stream.close()
                return CorruptWriter()
            return original(path, *args, **kwargs)

        with patch.object(Path, 'open', corrupt):
            self.reject()
        self.assertFalse((self.output / 'manifest.pending').exists())
        self.output = self.base / 'rename-failure'
        with patch.object(Path, 'rename', side_effect=OSError('Synthetic rename failure')):
            self.reject()
        self.assertTrue((self.output / 'manifest.pending').exists())

    def test_manifest_format_and_out_of_window(self):
        original = copy.deepcopy(self.manifest)
        for mutate in (lambda m: m.update(schema='unknown'),
                       lambda m: m.update(timezone='UTC'),
                       lambda m: m['window_raw'].update(end_exclusive='2026-01-01 00:00:00')):
            self.manifest = copy.deepcopy(original)
            mutate(self.manifest)
            self.put('manifest.json', AIR.encode(self.manifest))
            self.reject()
        self.manifest = original
        self.rows[0]['time'] = '2025-12-31 23:00:00'
        self.write_package()
        self.reject()

    def test_cli_invalid_input_nonzero_without_traceback(self):
        self.update_normalized(lambda rows: rows[0].update(value='broken'))
        result = subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/air/import-snapshot.py'),
                                 '--input', str(self.source), '--output', str(self.output)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Air import rejected:', result.stderr)
        self.assertNotIn('Traceback', result.stderr)


class RealSmokeTest(unittest.TestCase):
    def test_all_504_values_times_ten_zeros_three_stations(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'snapshot'
            ready = AIR.import_snapshot(REAL, output)
            self.assertEqual(ready['stations'], 3)
            self.assertEqual(ready['observations'], 504)
            self.assertEqual(ready['collapsed_duplicates'], 0)
            raw = read(REAL / 'raw/air-2026-week.json')['data']
            rows = observations(output / 'observations.jsonl')
            self.assertEqual(len(rows), len(raw))
            self.assertEqual(sum(r['value'] == 0 for r in rows), 10)
            self.assertEqual({r['station_id'] for r in rows}, {'4228', '3846', '3858'})
            for row in rows:
                self.assertEqual(len(row['raw_references']), 1)
                ref = row['raw_references'][0]
                source = raw[ref['raw_index']]
                self.assertEqual(row['value'], source['pm25'])
                self.assertEqual(row['observed_at_raw'], source['time'])
                self.assertEqual(row['station_id'], str(source['site']))
                self.assertIsNone(row['observed_at_utc'])
            for name in ('origins.json', 'manifest.json', 'raw/air-2026-week.json'):
                self.assertEqual((output / 'input' / name).read_bytes(), (REAL / name).read_bytes())
            self.assertEqual([s['missing_hour_bins'] for s in read(output / 'coverage.json')], [0, 0, 0])


if __name__ == '__main__':
    unittest.main()
