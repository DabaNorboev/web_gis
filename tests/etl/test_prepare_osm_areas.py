import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_areas', pathlib.Path(__file__).resolve().parents[2] / 'scripts/prepare-osm-areas.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AreaPreparationTest(unittest.TestCase):
    def fixture(self, root, missing=False):
        source = root / 'source.osm'
        nodes = [(1, 91, 54), (2, 95, 54), (3, 95, 58), (4, 91, 58),
                 (5, 92.5, 55.5), (6, 93.5, 55.5), (7, 93.5, 56.5), (8, 92.5, 56.5)]
        xml = '<osm version="0.6">' + ''.join(f'<node id="{i}" lon="{x}" lat="{y}" version="1"/>' for i,x,y in nodes)
        xml += '<way id="10" version="1">' + ''.join(f'<nd ref="{n}"/>' for n in [1,2,3,4,1]) + '</way>'
        xml += '<way id="11" version="1">' + ''.join(f'<nd ref="{n}"/>' for n in [5,6,7,8,5]) + '<tag k="natural" v="wood"/></way>'
        xml += '<relation id="20" version="2"><member type="way" ref="10" role="outer"/>'
        xml += f'<member type="way" ref="{99 if missing else 11}" role="inner"/><tag k="type" v="multipolygon"/><tag k="natural" v="water"/></relation></osm>'
        source.write_text(xml)
        boundary = root / 'boundary.json'
        boundary.write_text(json.dumps({'type':'Polygon','coordinates':[[[92,55],[94,55],[94,57],[92,57],[92,55]]]}))
        return source, boundary

    def test_complete_relation_and_hole_kept_even_when_no_outer_node_inside_bbox(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source, boundary = self.fixture(root)
            out = root / 'out'
            result = module.prepare(source, boundary, out, module.sha256(source))
            elements = json.loads((out/'areas.json').read_text())['elements']
            self.assertEqual({'way':1,'relation':1}, result['counts'])
            relation = elements[1]
            self.assertEqual(['outer','inner'], [m['role'] for m in relation['members']])
            self.assertEqual(91, relation['members'][0]['geometry'][0]['lon'])
            self.assertEqual(5, len(relation['members'][0]['geometry']))
            self.assertEqual(2, relation['version'])
            self.assertIsNone(result['osm_base_timestamp'])
            self.assertFalse((out/'nodes.index').exists())
            self.assertFalse((out/'members.sqlite').exists())
            with self.assertRaises(FileExistsError):
                module.prepare(source, boundary, out)

    def test_missing_member_refuses_preparation_without_partial_success(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source, boundary = self.fixture(root, missing=True)
            out = root / 'out'
            with self.assertRaisesRegex(ValueError, 'members absent'):
                module.prepare(source, boundary, out)
            self.assertFalse((out/'areas.json').exists())
            self.assertFalse((out/'manifest.json').exists())
            self.assertFalse((out/'members.sqlite').exists())

    def test_rules_and_checksum(self):
        self.assertTrue(module.selected({'leisure':'park'}))
        self.assertTrue(module.selected({'natural':'water'}))
        self.assertFalse(module.selected({'waterway':'stream'}))
        self.assertFalse(module.selected({'landuse':'farmland'}))
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source,boundary = self.fixture(root)
            with self.assertRaisesRegex(ValueError,'checksum'):
                module.prepare(source,boundary,root/'out','0'*64)
            self.assertFalse((root/'out').exists())
