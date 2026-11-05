import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('grocery', pathlib.Path(__file__).resolve().parents[2] / 'scripts/prepare-osm-grocery.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GroceryPreparationTest(unittest.TestCase):
    def test_nodes_complete_polygons_and_members_survive_bbox_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source, boundary = root/'source.osm', root/'boundary.json'
            source.write_text('''<osm version="0.6">
                <node id="1" lon="91" lat="54" version="1"/>
                <node id="2" lon="95" lat="54" version="1"/>
                <node id="3" lon="95" lat="58" version="1"/>
                <node id="4" lon="91" lat="58" version="1"/>
                <node id="5" lon="93" lat="56" version="1"><tag k="shop" v="convenience"/></node>
                <node id="6" lon="93" lat="56" version="1"><tag k="shop" v="grocery"/></node>
                <node id="7" lon="95" lat="58" version="1"><tag k="shop" v="supermarket"/></node>
                <way id="10" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/><tag k="shop" v="supermarket"/></way>
                <relation id="20" version="1"><member type="way" ref="10" role="outer"/><tag k="shop" v="supermarket"/><tag k="type" v="multipolygon"/></relation>
                </osm>''')
            boundary.write_text(json.dumps({'type':'Polygon','coordinates':[[[92,55],[94,55],[94,57],[92,57],[92,55]]]}))
            out = root/'out'
            manifest = module.prepare(source, boundary, out, module.sha256(source))
            self.assertEqual({'node':1,'way':1,'relation':1}, manifest['counts'])
            rows = json.loads((out/'grocery.json').read_text())['elements']
            self.assertEqual([5,10,20], [r['id'] for r in rows])
            self.assertEqual(91, rows[1]['geometry'][0]['lon'])
            self.assertEqual(5, len(rows[2]['members'][0]['geometry']))
            self.assertIsNone(manifest['observed_at'])
            self.assertEqual(2, manifest['preparation']['schema_version'])
            self.assertEqual(manifest['counts'], manifest['preparation']['emitted_counts'])
            self.assertEqual({'selected_count':1,'outcomes':[{'source_id':'osm:relation:20','status':'emitted'}]}, manifest['preparation']['relation_audit'])
            with self.assertRaises(FileExistsError):
                module.prepare(source, boundary, out)
            with self.assertRaisesRegex(ValueError, 'checksum'):
                module.prepare(source, boundary, root/'bad', '0'*64)
            self.assertFalse((root/'bad').exists())

    def test_node_only_and_nested_only_relations_block_publication_with_diagnostics(self):
        for kind, member in [('node', '<member type="node" ref="5" role="outer"/>'),
                             ('nested', '<member type="relation" ref="30" role="outer"/>')]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                source, boundary = root/'source.osm', root/'boundary.json'
                source.write_text('<osm version="0.6"><node id="5" lon="93" lat="56" version="1"><tag k="shop" v="supermarket"/></node>'
                                  '<relation id="20" version="1">'+member+'<tag k="shop" v="convenience"/><tag k="type" v="multipolygon"/></relation></osm>')
                boundary.write_text(json.dumps(module.envelope([92,55,94,57])))
                with self.assertRaisesRegex(ValueError, 'publication refused'):
                    module.prepare(source, boundary, root/'out')
                audit = json.loads((root/'out/diagnostics.json').read_text())
                self.assertEqual('rejected', audit['status'])
                self.assertEqual(1, audit['relation_audit']['selected_count'])
                self.assertEqual([{'source_id':'osm:relation:20','status':'rejected','reason':'unsupported_node_or_nested_member'}], audit['relation_audit']['outcomes'])
                self.assertFalse((root/'out/grocery.json').exists())
                self.assertFalse((root/'out/manifest.json').exists())

    def test_complete_relation_outside_extraction_is_explicit_and_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source, boundary = root/'source.osm', root/'boundary.json'
            source.write_text('<osm version="0.6"><node id="1" lon="95" lat="58" version="1"/><node id="2" lon="96" lat="58" version="1"/>'
                              '<node id="3" lon="96" lat="59" version="1"/><node id="4" lon="95" lat="59" version="1"/>'
                              '<node id="5" lon="93" lat="56" version="1"><tag k="shop" v="convenience"/></node>'
                              '<way id="10" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/></way>'
                              '<relation id="20" version="1"><member type="way" ref="10" role="outer"/><tag k="shop" v="supermarket"/><tag k="type" v="multipolygon"/></relation></osm>')
            boundary.write_text(json.dumps(module.envelope([92,55,94,57])))
            manifest = module.prepare(source, boundary, root/'out')
            self.assertEqual({'node':1,'way':0,'relation':0}, manifest['counts'])
            self.assertEqual([{'source_id':'osm:relation:20','status':'outside_extraction','reason':'complete_members_bbox_disjoint','bounds':[95,58,96,59]}], manifest['preparation']['relation_audit']['outcomes'])
            self.assertEqual('accounted', json.loads((root/'out/diagnostics.json').read_text())['status'])

    def test_missing_way_relation_never_produces_successful_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source, boundary = root/'source.osm', root/'boundary.json'
            source.write_text('<osm version="0.6"><node id="5" lon="93" lat="56" version="1"><tag k="shop" v="convenience"/></node>'
                              '<relation id="20" version="1"><member type="way" ref="99" role="outer"/><tag k="shop" v="supermarket"/><tag k="type" v="multipolygon"/></relation></osm>')
            boundary.write_text(json.dumps(module.envelope([92,55,94,57])))
            with self.assertRaisesRegex(ValueError, 'publication refused'):
                module.prepare(source, boundary, root/'out')
            audit = json.loads((root/'out/diagnostics.json').read_text())
            self.assertEqual('missing_way_member', audit['relation_audit']['outcomes'][0]['reason'])
            self.assertFalse((root/'out/grocery.json').exists())

    def test_specialized_and_ambiguous_tags_are_not_the_category(self):
        for shop in ['supermarket','convenience']:
            self.assertTrue(module.selected({'shop':shop}))
        for shop in ['grocery','bakery','alcohol','greengrocer','general','department_store']:
            self.assertFalse(module.selected({'shop':shop}))


if __name__ == '__main__':
    unittest.main()
