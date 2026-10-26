"""Synthetic offline fixtures; no Docker, database, or real source mutation."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / 'scripts/prepare-walking-runtime.py'
spec = importlib.util.spec_from_file_location('walking_prepare', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WalkingPrepareTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.report, self.source, self.guards = [self.root / n for n in ['report', 'source', 'guards']]
        self.graph = self.report / 'walking/home/graphs/foot-walking'
        for folder in [self.graph, self.source, self.guards]:
            folder.mkdir(parents=True)
        self.node = {'id': 1, 'coordinate': [92.8601, 56.0101], 'tags': {'access': 'private'}}
        self.context = {'ways': [{'id': 7, 'nodes': [1, 2], 'coordinates': [[92.8601, 56.0101], [92.8602, 56.0102]],
                                 'tags': {'highway': 'footway', 'foot': 'yes'}}], 'barrier_nodes': []}
        (self.source / 'context.json').write_text(json.dumps(self.context))
        (self.source / 'pilot.osm.pbf').write_bytes(b'synthetic source')
        (self.report / 'nodes.jsonl').write_text(json.dumps(self.node) + '\n')
        (self.graph / 'nodes').write_bytes(b'synthetic graph')
        (self.guards / 'obstacles.jsonl').write_text('')
        (self.guards / 'guard-sources.json').write_text(json.dumps({'export_sha256': module.digest(self.guards / 'obstacles.jsonl'),
                                                                 'imports': [], 'service_geometry': {'type': 'Polygon', 'coordinates': []}}))
        self.pins = {key: module.digest(path) for key, path in {
            'context': self.source / 'context.json', 'extract': self.source / 'pilot.osm.pbf',
            'nodes': self.report / 'nodes.jsonl', 'sources': self.guards / 'guard-sources.json',
            'obstacles': self.guards / 'obstacles.jsonl'}.items()}
        self.graphpins = {'foot-walking/nodes': module.digest(self.graph / 'nodes')}
        self.output = self.root / 'release'

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, output=None):
        with patch.object(module, 'SOURCE_HASHES', self.pins), patch.object(module, 'GRAPH_HASHES', self.graphpins):
            return module.prepare(self.report, self.source, self.guards, output or self.output, '2026-10-26T00:00:00Z')

    def test_deterministic_source_identity_and_all_tagged_nodes_are_preserved(self):
        self.prepare()
        other = self.root / 'replay'
        self.prepare(other)
        names = [p.relative_to(self.output) for p in self.output.rglob('*') if p.is_file()]
        self.assertTrue(all((self.output / name).read_bytes() == (other / name).read_bytes() for name in names))
        manifest = json.loads((self.output / 'manifest.json').read_text())
        self.assertEqual(manifest['observed_at'], None)
        self.assertEqual(manifest['snap_limit_m'], 20)
        self.assertEqual(json.loads((self.output / 'ways/7.json').read_text()), self.context['ways'][0])
        features = json.loads((self.output / 'guards/18572-11202.json').read_text())
        self.assertEqual([r for r in features if r['kind'] == 'node'][0]['tags'], {'access': 'private'})
        self.assertEqual(manifest['graph_hashes']['graph/foot-walking/nodes'], self.graphpins['foot-walking/nodes'])

    def test_standalone_context_barriers_are_preserved_without_adding_network_nodes(self):
        barrier = {'id': 99, 'coordinate': [92.86015, 56.01015], 'tags': {'barrier': 'fence', 'access': 'private'}}
        self.context['barrier_nodes'] = [barrier]
        (self.source / 'context.json').write_text(json.dumps(self.context))
        self.pins['context'] = module.digest(self.source / 'context.json')
        self.prepare()
        features = json.loads((self.output / 'guards/18572-11202.json').read_text())
        node_rows = {r['id']: r for r in features if r['kind'] == 'node'}
        self.assertEqual(set(node_rows), {'node/1', 'node/99'})
        self.assertEqual(node_rows['node/99']['tags'], barrier['tags'])
        way = json.loads((self.output / 'ways/7.json').read_text())
        self.assertEqual(way['nodes'], [1, 2])
        self.assertNotIn(99, way['nodes'])
        manifest = json.loads((self.output / 'manifest.json').read_text())
        self.assertEqual(manifest['source_hashes']['context'], self.pins['context'])
        self.assertEqual(manifest['source_hashes']['nodes'], self.pins['nodes'])

    def test_context_barrier_tags_must_match_a_retained_node_with_the_same_id(self):
        self.context['barrier_nodes'] = [{**self.node, 'tags': {'barrier': 'gate'}}]
        (self.source / 'context.json').write_text(json.dumps(self.context))
        self.pins['context'] = module.digest(self.source / 'context.json')
        with self.assertRaisesRegex(ValueError, 'Tagged node provenance'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_existing_output_is_never_overwritten(self):
        self.output.mkdir()
        sentinel = self.output / 'unfinished'
        sentinel.write_text('preserve')
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(sentinel.read_text(), 'preserve')

    def test_corrupted_sources_fail_before_creating_output(self):
        (self.source / 'context.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Frozen source'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_missing_or_changed_graph_files_are_rejected(self):
        (self.graph / 'nodes').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'Frozen graph'):
            self.prepare()
        (self.graph / 'nodes').unlink()
        with self.assertRaisesRegex(ValueError, 'graph file set'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_same_node_id_with_conflicting_coordinates_is_rejected(self):
        self.node['coordinate'][0] += .001
        (self.report / 'nodes.jsonl').write_text(json.dumps(self.node) + '\n')
        self.pins['nodes'] = module.digest(self.report / 'nodes.jsonl')
        with self.assertRaisesRegex(ValueError, 'Conflicting node'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_mutable_provenance_cannot_replace_frozen_obstacle_pin(self):
        (self.guards / 'obstacles.jsonl').write_text('{}')
        source = self.guards / 'guard-sources.json'
        source.write_text(json.dumps({'export_sha256': module.digest(self.guards / 'obstacles.jsonl')}))
        with self.assertRaisesRegex(ValueError, 'Frozen source'):
            self.prepare()
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
