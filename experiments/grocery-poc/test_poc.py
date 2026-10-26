"""Safe stdlib checks; synthetic files only, plus the isolated snapshot if present."""
import json
import math
import pathlib
import tempfile
import unittest

from geo import R, circle, covers, distance, intersects_rect, project
from server import ROOT, Snapshot


def feature(source_id, geometry, name='Одинаковое имя'):
    return {'type':'Feature','geometry':geometry,'properties':{
        'id':source_id,'version':1,'edited_at':'2026-01-01T00:00:00Z',
        'point':geometry.get('coordinates',[0,0]),'tags':{'shop':'convenience','name':name}}}


class GeometryChecks(unittest.TestCase):
    def test_spherical_projection_independent_equator_reference(self):
        expected = R*math.pi/180
        self.assertAlmostEqual(math.hypot(*project([1,0],[0,0])),expected,places=6)
        self.assertAlmostEqual(math.hypot(*project([0,1],[0,0])),expected,places=6)

    def test_circle_both_radii_in_krasnoyarsk(self):
        for radius in [300,500]:
            points = circle([92.87,56.01],radius)['coordinates'][0]
            for point in points:
                self.assertAlmostEqual(math.hypot(*project(point,[92.87,56.01])),radius,places=5)

    def test_polygon_containment_hole_and_nearest_edge(self):
        poly = {'type':'Polygon','coordinates':[
            [[-.01,-.01],[.01,-.01],[.01,.01],[-.01,.01],[-.01,-.01]],
            [[-.001,-.001],[.001,-.001],[.001,.001],[-.001,.001],[-.001,-.001]]]}
        self.assertFalse(covers([0,0],poly))
        self.assertTrue(covers([.005,0],poly))
        self.assertEqual(distance([.005,0],poly),0)
        self.assertGreater(distance([0,0],poly),100)
        self.assertLess(distance([0,0],poly),112)

    def test_geometry_enclosing_window_without_inside_vertices(self):
        poly = {'type':'Polygon','coordinates':[[[-2,-2],[2,-2],[2,2],[-2,2],[-2,-2]]]}
        self.assertTrue(intersects_rect(poly,[-1,-1,1,1]))
        line = {'type':'LineString','coordinates':[[-2,0],[2,0]]}
        self.assertTrue(intersects_rect(line,[-1,-1,1,1]))


class SelectionChecks(unittest.TestCase):
    def test_radius_does_not_round_or_merge_source_elements(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Equatorial angular offset has an independent closed-form distance.
            def point(metres):
                return {'type':'Point','coordinates':[math.degrees(metres/R),0]}
            food = [feature('node/1',point(299.999)),feature('node/2',point(299.999)),
                    feature('node/3',point(300.001)),feature('node/4',point(501))]
            p = pathlib.Path(tmp)/'data.json'
            p.write_text(json.dumps({'addresses':[{'id':'node/100','point':[0,0],'label':'Тест, 1'}],
                                     'food':food,'metadata':{'osm_base_timestamp':'test'}}))
            s = Snapshot(p)
            a = s.analyze('node/100',300)['collection']['features']
            b = s.analyze('node/100',500)['collection']['features']
            self.assertEqual({f['id'] for f in a},{'node/1','node/2'})
            self.assertEqual({f['id'] for f in b},{'node/1','node/2','node/3'})
            with self.assertRaises(ValueError):s.compare('node/100','node/100',400)
            with self.assertRaises(ValueError):s.compare('node/404','node/100',500)

    def test_polygon_near_edge_is_included_when_centroid_is_outside(self):
        with tempfile.TemporaryDirectory() as tmp:
            polygon = {'type':'Polygon','coordinates':[[[.001,-.001],[.01,-.001],
                        [.01,.001],[.001,.001],[.001,-.001]]]}
            row = feature('way/10',polygon)
            row['properties']['point'] = [.0055,0]  # ~612 m, outside either circle
            p = pathlib.Path(tmp)/'data.json'
            p.write_text(json.dumps({'addresses':[{'id':'node/100','point':[0,0],'label':'Тест, 1'}],
                                     'food':[row],'metadata':{}}))
            result = Snapshot(p).analyze('node/100',300)['collection']['features']
            self.assertEqual([f['id'] for f in result],['way/10'])
            self.assertLess(result[0]['properties']['distance_m'],112)

    def test_empty_is_an_explicit_snapshot_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = pathlib.Path(tmp)/'data.json'
            p.write_text(json.dumps({'addresses':[{'id':'node/100','point':[0,0],'label':'Тест, 1'}],
                                     'food':[],'metadata':{}}))
            result = Snapshot(p).analyze('node/100',500)
            self.assertEqual(result['collection']['features'],[])
            self.assertIn('не означает',result['notice'])


@unittest.skipUnless((ROOT/'.runtime/data/dataset.json').is_file(),'isolated snapshot not prepared')
class PreparedSnapshotChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = Snapshot(ROOT/'.runtime/data/dataset.json')

    def test_all_11_audit_ways_resolved_and_classified(self):
        rows = self.snapshot.data['metadata']['audit_ways']
        self.assertEqual(len(rows),11)
        for row in rows.values():
            self.assertEqual(row['vertices'],row['resolved_vertices'])
            self.assertGreater(row['vertices'],1)
            self.assertEqual(row['selected_food'],row['tags'].get('shop') in {'supermarket','convenience','grocery'})

    def test_source_ids_and_categories_are_preserved(self):
        rows = self.snapshot.data['food']
        self.assertEqual(len(rows),len({f['properties']['id'] for f in rows}))
        self.assertTrue(all(f['properties']['tags']['shop'] in {'supermarket','convenience','grocery'} for f in rows))

    def test_300_is_subset_of_500_for_addresses_across_city(self):
        for query in ['Ленина 102','Молокова 28','Славы 12','Шинная 36','Борисевича 22']:
            candidates = self.snapshot.search(query)
            self.assertTrue(candidates,query)
            address = candidates[0]
            a = self.snapshot.analyze(address['id'],300)['collection']['features']
            b = self.snapshot.analyze(address['id'],500)['collection']['features']
            self.assertLessEqual({f['id'] for f in a},{f['id'] for f in b})
            self.assertTrue(all(f['properties']['distance_m']<=300 for f in a))
            self.assertTrue(all(f['properties']['distance_m']<=500 for f in b))


if __name__=='__main__':
    unittest.main(verbosity=2)
