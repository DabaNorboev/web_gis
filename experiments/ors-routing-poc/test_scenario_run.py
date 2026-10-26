"""Frozen scenario contract and preparation refusals; no network or Docker."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import scenario_run as runner
from scenario_probe import probe_scenarios


def scenarios():
    endpoints = {'start': {'coordinate': [92.8, 56]}, 'target': {'coordinate': [92.8001, 56]}}
    return {'version': 1, 'cases': [{'id': 'synthetic', 'original': endpoints, 'selected': endpoints}]}


class ScenarioPreparation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.out = self.root / 'evidence'
        self.out.mkdir()
        self.scenarios = self.root / 'scenarios.json'
        self.scenarios.write_text(json.dumps(scenarios()))
        self.pbf, self.policy = self.root / 'input.pbf', self.root / 'policy.json'
        self.pbf.write_bytes(b'synthetic PBF placeholder, never parsed')
        self.policy.write_text('{}')
        self.source = self.root / 'old-walking'
        self.graphs = self.source / 'home/graphs'
        profile = self.graphs / 'foot-walking'
        profile.mkdir(parents=True)
        for name in ('edges', 'nodes', 'geometry', 'properties', 'graph_build_info.yml'):
            (profile / name).write_bytes(('synthetic-' + name).encode())
        self.freeze = {'scenarios_sha256': runner.digest(self.scenarios),
                       'pbf_sha256': runner.digest(self.pbf), 'policy_sha256': runner.digest(self.policy),
                       'graph_hashes': runner.graph_hashes(self.graphs)}
        self.freeze_path = self.out / 'scenario-freeze.json'
        self.freeze_path.write_text(json.dumps(self.freeze))
        self.patches = [patch.object(runner.original, 'PBF', self.pbf), patch.object(runner, 'POLICY', self.policy)]
        for patched in self.patches:
            patched.start()
            self.addCleanup(patched.stop)

    def prepare(self):
        return runner.prepare(self.out, self.scenarios, self.source)

    def test_copy_is_private_and_source_manifest_is_preserved(self):
        runtime, frozen, ids = self.prepare()
        self.assertEqual(ids, {'synthetic-original', 'synthetic-selected'})
        copied = runtime / 'home/graphs'
        self.assertEqual(runner.graph_hashes(copied), frozen)
        (copied / 'foot-walking/edges').write_bytes(b'new writable copy')
        self.assertEqual(runner.graph_hashes(self.graphs), frozen)
        self.assertEqual(runner.digest(runtime / 'scenarios.json'), self.freeze['scenarios_sha256'])
        self.assertFalse(runner.verify_stopped_graphs(self.graphs, copied, frozen)['copy_verified'])
        (copied / 'foot-walking/edges').write_bytes((self.graphs / 'foot-walking/edges').read_bytes())
        (copied / 'foot-walking/gh.lock').write_bytes(b'')
        self.assertTrue(runner.verify_stopped_graphs(self.graphs, copied, frozen)['copy_verified'])
        (copied / 'foot-walking/unexpected-new-graph').write_bytes(b'')
        self.assertFalse(runner.verify_stopped_graphs(self.graphs, copied, frozen)['copy_verified'])

    def test_changed_frozen_inputs_refuse_before_runtime_creation(self):
        for key in ('scenarios_sha256', 'pbf_sha256', 'policy_sha256', 'graph_hashes'):
            with self.subTest(key=key):
                changed = dict(self.freeze)
                changed[key] = {} if key == 'graph_hashes' else '0' * 64
                self.freeze_path.write_text(json.dumps(changed))
                with patch.object(sys, 'argv', ['scenario_run.py', '--output', str(self.out),
                                              '--scenarios', str(self.scenarios),
                                              '--source-walking', str(self.source)]), \
                        patch.object(runner.original, 'docker') as docker, \
                        self.assertRaisesRegex(ValueError, '[Hh]ash mismatch'):
                    runner.main()
                docker.assert_not_called()
                self.assertFalse((self.out / 'runtime').exists())

    def test_existing_runtime_is_never_overwritten(self):
        runtime = self.out / 'runtime'
        runtime.mkdir()
        sentinel = runtime / 'runtime.json'
        sentinel.write_text('existing result')
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(sentinel.read_text(), 'existing result')

    def test_missing_core_graph_file_is_not_a_build_request(self):
        (self.graphs / 'foot-walking/edges').unlink()
        self.freeze['graph_hashes'] = runner.graph_hashes(self.graphs)
        self.freeze_path.write_text(json.dumps(self.freeze))
        with self.assertRaisesRegex(ValueError, 'complete existing'):
            self.prepare()
        self.assertFalse((self.out / 'runtime').exists())


class ScenarioProbe(unittest.TestCase):
    def test_only_original_and_selected_directions_use_fixed_twenty_metre_radii(self):
        with patch('scenario_probe.request', return_value={'http_status': 200, 'body': {}, 'milliseconds': 1}) as request:
            result = probe_scenarios(scenarios())
        self.assertEqual(request.call_count, 2)
        for call in request.call_args_list:
            self.assertEqual(call.args[0], '/directions/foot-walking/geojson')
            self.assertEqual(call.args[1]['radiuses'], [20, 20])
            self.assertIs(call.args[1]['geometry_simplify'], False)
            self.assertEqual(call.args[1]['extra_info'], ['osmid', 'waytype'])
        self.assertEqual([row['id'] for row in result['rows']], ['synthetic-original', 'synthetic-selected'])
        self.assertIsNone(result['user_eta'])

    def test_invalid_and_nonfinite_inputs_never_send_requests(self):
        invalid = []
        for coordinate in ([float('nan'), 56], [True, 56], [92.8, 91], [92.8], '92.8,56'):
            value = scenarios()
            value['cases'][0]['original']['start']['coordinate'] = coordinate
            invalid.append(value)
        value = scenarios()
        value['cases'] *= 2
        invalid.append(value)
        invalid.extend([{'version': 1, 'cases': []}, {'version': True, 'cases': scenarios()['cases']}])
        with patch('scenario_probe.request') as request:
            for value in invalid:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    probe_scenarios(value)
        request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
