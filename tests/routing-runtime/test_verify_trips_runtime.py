"""Filesystem safety with synthetic inputs and fully replaced HTTP."""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / 'scripts/verify-trips-runtime.py'
spec = importlib.util.spec_from_file_location('verify_trips_runtime', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VerifyTripsRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.output = self.root / 'new-results'
        self.input = self.root / module.DEFAULT_NO_PATH_CANDIDATES.relative_to(module.ROOT)
        self.input.parent.mkdir(parents=True)
        self.input.write_bytes(b'[{"coordinate": [92.8, 56.1]}]\n')
        controls = self.root / 'experiments/local-routing-poc/controls.json'
        controls.parent.mkdir(parents=True)
        controls.write_text(json.dumps({'cases': [
            {'id': name, 'start': {'coordinate': [92.8, 56]},
             'target': {'coordinate': [92.9, 56]}} for name in ['stadium', 'railway']]}))
        self.addCleanup(patch.stopall)
        patch.object(module, 'ROOT', self.root).start()
        self.http = patch.object(module.urllib.request, 'urlopen',
                                 side_effect=AssertionError('Real HTTP forbidden')).start()
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()
        streams = contextlib.ExitStack()
        self.addCleanup(streams.close)
        streams.enter_context(contextlib.redirect_stdout(self.stdout))
        streams.enter_context(contextlib.redirect_stderr(self.stderr))

    def cli(self, *args):
        module.cli(['--output-dir', str(self.output), *args])

    def test_existing_paths_rejected_before_http(self):
        sentinel = self.root / 'sentinel'
        sentinel.write_bytes(b'historical\x00bytes')
        directory = self.root / 'old-results'
        directory.mkdir()
        control = directory / 'control.json'
        control.write_bytes(b'keep me\n')
        empty = self.root / 'empty'
        empty.mkdir()
        links = []
        for name, target in [('dir-link', directory), ('file-link', sentinel),
                             ('dangling-link', self.root / 'missing')]:
            link = self.root / name
            link.symlink_to(target)
            links.append(link)
        for path in [directory, empty, sentinel, *links]:
            for flags in [[], ['--unavailable']]:
                with self.subTest(path=path, flags=flags), self.assertRaises(SystemExit) as exc:
                    module.cli(['--output-dir', str(path), *flags])
                self.assertEqual(exc.exception.code, 2)
                self.assertIn('Output path already exists', self.stderr.getvalue())
        self.assertEqual(control.read_bytes(), b'keep me\n')
        self.assertEqual(sentinel.read_bytes(), b'historical\x00bytes')
        self.assertEqual(list(empty.iterdir()), [])
        self.assertTrue(all(link.is_symlink() for link in links))
        self.http.assert_not_called()

    def test_output_argument_required_before_http(self):
        for flags in [[], ['--unavailable']]:
            with self.assertRaises(SystemExit) as exc:
                module.cli(flags)
            self.assertEqual(exc.exception.code, 2)
        self.assertIn('--output-dir', self.stderr.getvalue())
        self.http.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_missing_input_fails_before_http(self):
        missing = self.root / 'missing.json'
        with self.assertRaises(SystemExit) as exc:
            self.cli('--no-path-candidates', str(missing))
        self.assertEqual(exc.exception.code, 2)
        self.assertIn('Cannot read no-path candidates input', self.stderr.getvalue())
        self.assertIn(str(missing), self.stderr.getvalue())
        self.assertEqual(list(self.output.iterdir()), [])
        self.http.assert_not_called()

    def test_exclusive_report_creation(self):
        self.output.mkdir()
        report = self.output / 'http-ordinary.json'
        report.write_bytes(b'original report\n')
        with self.assertRaises(FileExistsError):
            module.write_report(self.output, report.name, {'changed': True})
        self.assertEqual(report.read_bytes(), b'original report\n')
        link = self.output / 'legacy-after-integration.json'
        link.symlink_to(report)
        with self.assertRaises(FileExistsError):
            module.write_report(self.output, link.name, {})
        self.assertTrue(link.is_symlink())
        self.assertEqual(report.read_bytes(), b'original report\n')
        self.http.assert_not_called()

    def synthetic_http(self, statuses):
        statuses = iter(statuses)

        def respond(req, timeout):
            status = 200
            if isinstance(req, module.urllib.request.Request):
                data = json.loads(req.data)
                expected = next(statuses)
                if isinstance(expected, int):
                    status, body = expected, {'message': 'synthetic validation error'}
                else:
                    rows = []
                    for state, place in zip(expected, data['places'], strict=True):
                        target = {key: place[key] for key in ['lon', 'lat']}
                        rows.append({'status': state, 'start': data['start'], 'target': target,
                                     'route': None, 'checks': ['SNAP_THROUGH_BARRIER', 'ACCESS_REVIEW'],
                                     'metrics': {'distance': {'value': None, 'quality': {'method': None}},
                                                 'duration': {'value': None}},
                                     'snaps': {'start': {'original': data['start'], 'distance_m': 0},
                                               'target': {'original': target, 'distance_m': 0}}})
                    body = {'start': data['start'], 'results': rows,
                            'source': {'dataset_version': 'osrm-car-20261021-v1', 'observed_at': None}}
            elif '/transport/analysis?' in req:
                radius = int(module.urllib.parse.parse_qs(module.urllib.parse.urlparse(req).query)['radius_m'][0])
                body = {'point': {'lon': 92.87, 'lat': 56.01},
                        'stops_in_radius': [{'distance_m': i} for i in range(5 if radius == 300 else 8)]}
            elif '/addresses/search?' in req:
                body = {'data': ['synthetic group']}
            else:
                body = {}
            response = io.StringIO(json.dumps(body))
            response.status = status
            response.headers = {'Cache-Control': 'no-store'}
            return response
        return respond

    def test_normal_mode_writes_only_new_directory_and_preserves_input(self):
        original = self.input.read_bytes()
        self.http.side_effect = self.synthetic_http([
            ['AVAILABLE'], ['NEEDS_REFINEMENT'], ['NO_PATH'],
            ['AVAILABLE', 'NO_PATH', 'OUTSIDE_PILOT'], ['OUTSIDE_PILOT'], ['UNKNOWN'], 422, 413])
        self.cli('--no-path-candidates', str(self.input))
        expected = {'http-' + name + '.json' for name in [
            'ordinary', 'wall-snap', 'no-path', 'partial-matrix', 'pilot-edge',
            'vehicle-private', 'unsupported-mode', 'oversized-body']}
        self.assertEqual({p.name for p in self.output.iterdir()}, expected | {'legacy-after-integration.json'})
        for name in expected:
            record = json.loads((self.output / name).read_text())
            self.assertEqual(set(record), {'request', 'response', 'http_status', 'headers', 'milliseconds'})
        no_path = json.loads((self.output / 'http-no-path.json').read_text())
        self.assertEqual(no_path['request']['places'][0]['lon'], 92.8)
        self.assertEqual(no_path['request']['places'][0]['lat'], 56.1)
        self.assertEqual(self.input.read_bytes(), original)
        self.assertEqual(list(self.input.parent.iterdir()), [self.input])
        self.assertEqual(self.http.call_count, 16)

    def test_unavailable_without_input_and_reuse_rejected(self):
        self.http.side_effect = self.synthetic_http([['UNAVAILABLE', 'UNAVAILABLE']])
        self.cli('--unavailable', '--no-path-candidates', str(self.root / 'absent.json'))
        self.assertEqual({p.name for p in self.output.iterdir()},
                         {'http-container-unavailable.json', 'legacy-while-router-down.json'})
        before = {p.name: p.read_bytes() for p in self.output.iterdir()}
        self.http.reset_mock()
        with self.assertRaises(SystemExit):
            self.cli('--unavailable')
        self.http.assert_not_called()
        self.assertEqual({p.name: p.read_bytes() for p in self.output.iterdir()}, before)

    def test_default_input_remains_historical_path(self):
        self.assertEqual(module.main.__defaults__[0], module.DEFAULT_NO_PATH_CANDIDATES)
        self.assertEqual(module.DEFAULT_NO_PATH_CANDIDATES,
                         SCRIPT.parents[1] / 'data/reports/local-routing-integration-2026-10-21/no-path-candidates.json')


if __name__ == '__main__':
    unittest.main()
