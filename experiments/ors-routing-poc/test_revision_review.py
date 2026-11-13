"""Semantic regressions on original geometry, independent of actual ORS output."""
from contextlib import ExitStack
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from historical_geometry import distance
from revision_review import RevisionReviewer
from review_support import HERE, read
from source_chain import SourceChainMatcher


def way(identifier, ids, points, tags=None):
    return {'id': identifier, 'nodes': ids, 'coordinates': points,
            'tags': tags or {'highway': 'service'}}


def response(points, ranges, case_id='synthetic', length=None):
    length = length if length is not None else sum(distance(a, b) for a, b in zip(points, points[1:]))
    return {'id': case_id, 'http_status': 200, 'body': {'type': 'FeatureCollection', 'features': [{
        'geometry': {'type': 'LineString', 'coordinates': [list(p) for p in points]},
        'properties': {'summary': {'distance': length, 'duration': length},
                       'extras': {'osmId': {'values': ranges}}}}]}}


class RevisedSemantics(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        for target in ['source_chain.utm', 'revision_review.utm']:
            stack.enter_context(patch(target, side_effect=lambda p: tuple(p)))

    def reviewer(self, ways, mode='walking', obstacles=(), nodes=None):
        obj = RevisionReviewer.__new__(RevisionReviewer)
        obj.mode = mode
        obj.policy = read(HERE / 'walking-policy.json') | {'mode': mode, 'snap_limit_m': 20 if mode == 'walking' else 35}
        obj.bbox = [-100, -100, 100, 100]
        segments = []
        obj.node_points = {}
        for w in ways:
            obj.node_points.update(zip(w['nodes'], map(tuple, w['coordinates'])))
            for i, (a, b) in enumerate(zip(w['coordinates'], w['coordinates'][1:])):
                segments.append({'way': w['id'], 'u': w['nodes'][i], 'v': w['nodes'][i + 1],
                                 'a': a, 'b': b, 'tags': w['tags']})
        nodes = nodes or {}
        for node_id, node in nodes.items():
            node['point'] = obj.node_points[node_id]
        obj.network = SimpleNamespace(ways=ways, nodes=nodes,
            near_segments=lambda *args, **kwargs: segments,
            node_index=SimpleNamespace(query=lambda box: list(nodes)))
        obj.matcher = SourceChainMatcher([w for w in ways if 'highway' in w['tags']])
        obj.obstacles = SimpleNamespace(query=lambda a, b: list(obstacles))
        obj.in_scope = lambda points: True
        return obj

    def evaluate(self, obj, row, start=None, target=None):
        points = row['body']['features'][0]['geometry']['coordinates']
        return obj.row_v2(row, {'start': start or points[0], 'target': target or points[-1]})

    def test_simplified_bend_matches_and_keeps_original_source_geometry(self):
        obj = self.reviewer([way(10, [1, 2, 3], [(0, 0), (5, .8), (10, 0)])])
        r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]], case_id='bridge'))
        self.assertEqual(r['status'], 'MODEL_GEOMETRY_CONSISTENT')
        self.assertEqual(len(r['checks']['source_chain']['segments']), 2)
        self.assertIsNone(r['distance_m'])
        self.assertIsNone(r['duration_s'])

    def test_nearby_forbidden_way_cannot_contaminate_declared_allowed_way(self):
        obj = self.reviewer([way(10, [1, 2], [(0, 0), (10, 0)]),
                             way(20, [3, 4], [(0, 0), (10, 0)], {'highway': 'service', 'access': 'private'})])
        self.assertEqual(self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]))['status'],
                         'MODEL_GEOMETRY_CONSISTENT')
        r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 20]]))
        self.assertNotEqual(r['status'], 'MODEL_GEOMETRY_CONSISTENT')
        self.assertTrue(r['checks']['access'])

    def test_short_forbidden_way_and_reverse_oneway_still_reject(self):
        ways = [way(10, [1, 2], [(0, 0), (5, 0)]),
                way(20, [2, 3], [(5, 0), (5.4, 0)], {'highway': 'service', 'motorcar': 'no'}),
                way(30, [3, 4], [(5.4, 0), (10, 0)])]
        obj = self.reviewer(ways, mode='driving')
        r = self.evaluate(obj, response([(0, 0), (5, 0), (5.4, 0), (10, 0)],
                                      [[0, 1, 10], [1, 2, 20], [2, 3, 30]]))
        self.assertTrue(r['checks']['access'])
        self.assertNotEqual(r['status'], 'MODEL_GEOMETRY_CONSISTENT')
        obj = self.reviewer([way(10, [1, 2, 3], [(0, 0), (5, .8), (10, 0)],
                                  {'highway': 'service', 'oneway': '-1'})], mode='driving')
        r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]))
        self.assertTrue(any('ONEWAY' in reason for reason in r['checks']['access']))

    def test_removed_source_node_with_closed_gate_still_rejects(self):
        obj = self.reviewer([way(10, [1, 2, 3], [(0, 0), (5, .8), (10, 0)])],
                            nodes={2: {'tags': {'barrier': 'gate', 'foot': 'no'}}})
        r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]))
        self.assertTrue(any('node/2' in reason for reason in r['checks']['access']))
        self.assertNotEqual(r['status'], 'MODEL_GEOMETRY_CONSISTENT')

    def test_obstacles_follow_source_bend_not_simplified_chord(self):
        ways = [way(10, [1, 2, 3], [(0, 0), (5, .8), (10, 0)])]
        # This polygon crosses the response chord but not the original source chain.
        polygon = [[(4.8, -.15), (5.2, -.15), (5.2, .15), (4.8, .15), (4.8, -.15)]]
        obj = self.reviewer(ways, obstacles=[('building/1', 'building', [polygon])])
        self.assertEqual(self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]))['status'],
                         'MODEL_GEOMETRY_CONSISTENT')
        # This polygon touches the original bend; the simplified response misses it.
        polygon = [[(4.8, .65), (5.2, .65), (5.2, .95), (4.8, .95), (4.8, .65)]]
        obj = self.reviewer(ways, obstacles=[('building/2', 'building', [polygon])])
        r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]))
        self.assertNotEqual(r['status'], 'MODEL_GEOMETRY_CONSISTENT')
        self.assertIn('ROUTE_BUILDING:building/2', r['checks']['obstacles'])

    def test_original_in_building_or_connector_through_wall_requires_refinement(self):
        roads = [way(10, [1, 2], [(0, 0), (10, 0)])]
        polygon = [[(-.1, 1), (.1, 1), (.1, 3), (-.1, 3), (-.1, 1)]]
        obj = self.reviewer(roads, obstacles=[('building/1', 'building', [polygon])])
        r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]), start=[0, 2])
        self.assertEqual(r['status'], 'NEEDS_REFINEMENT')
        obj = self.reviewer(roads + [way(20, [3, 4], [(-1, 1), (1, 1)], {'barrier': 'wall'})])
        r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]), start=[0, 2])
        self.assertEqual(r['status'], 'NEEDS_REFINEMENT')

    def test_bridge_without_rail_layer_evidence_stays_unknown(self):
        obj = self.reviewer([way(10, [1, 2], [(0, 0), (10, 0)],
                                  {'highway': 'footway', 'bridge': 'yes', 'layer': '1'}),
                             way(20, [3, 4], [(5, -5), (5, 5)], {'railway': 'rail'})])
        r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]))
        self.assertNotEqual(r['status'], 'MODEL_GEOMETRY_CONSISTENT')
        self.assertTrue(any('RAILWAY' in reason for reason in r['checks']['obstacles']))

    def test_coincident_different_node_ids_never_establish_connectivity(self):
        obj = self.reviewer([way(10, [1, 2], [(0, 0), (5, 0)]),
                             way(20, [3, 4], [(5, 0), (10, 0)])])
        r = self.evaluate(obj, response([(0, 0), (5, 0), (10, 0)], [[0, 1, 10], [1, 2, 20]]))
        self.assertNotEqual(r['status'], 'MODEL_GEOMETRY_CONSISTENT')
        self.assertIn('SOURCE_NODE_CONTINUITY_MISMATCH', r['reasons'])

    def test_car_model_consistency_keeps_turn_restrictions_unvalidated(self):
        obj = self.reviewer([way(10, [1, 2], [(0, 0), (10, 0)])], mode='driving')
        r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]))
        self.assertEqual(r['status'], 'MODEL_GEOMETRY_CONSISTENT')
        self.assertEqual(r['turn_restrictions'], 'NOT_VALIDATED')

    def test_shared_gate_or_crossing_does_not_clear_collinear_obstacle_overlap(self):
        for hazard, node_tags in [({'barrier': 'wall'}, {'barrier': 'gate', 'foot': 'yes'}),
                                  ({'railway': 'rail'}, {'railway': 'level_crossing', 'foot': 'yes'})]:
            with self.subTest(hazard=hazard):
                obj = self.reviewer([way(10, [1, 2], [(0, 0), (10, 0)]),
                                     way(20, [1, 3], [(0, 0), (5, 0)], hazard)],
                                    nodes={1: {'tags': node_tags}})
                r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]))
                self.assertNotEqual(r['status'], 'MODEL_GEOMETRY_CONSISTENT')
                self.assertTrue(r['checks']['obstacles'])

    def test_gate_and_rail_crossing_evidence_are_independent(self):
        obj = self.reviewer([way(10, [1, 2], [(0, 0), (10, 0)]),
                             way(20, [3, 1], [(0, -5), (0, 0)], {'railway': 'rail', 'barrier': 'fence'})],
                            nodes={1: {'tags': {'railway': 'level_crossing', 'foot': 'yes'}}})
        r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]))
        self.assertNotEqual(r['status'], 'MODEL_GEOMETRY_CONSISTENT')
        self.assertIn('BARRIER_REVIEW:way/20', r['checks']['obstacles'])

    def test_valid_shared_gate_or_crossing_can_clear_only_the_point_intersection(self):
        for hazard, node_tags in [({'barrier': 'wall'}, {'barrier': 'gate', 'foot': 'yes'}),
                                  ({'railway': 'rail'}, {'railway': 'level_crossing', 'foot': 'yes'})]:
            obj = self.reviewer([way(10, [1, 2, 3], [(0, 0), (5, 0), (10, 0)]),
                                 way(20, [4, 2, 5], [(5, -5), (5, 0), (5, 5)], hazard)],
                                nodes={2: {'tags': node_tags}})
            r = self.evaluate(obj, response([(0, 0), (10, 0)], [[0, 1, 10]]))
            self.assertEqual(r['status'], 'MODEL_GEOMETRY_CONSISTENT')

    def test_unmatched_middle_preserves_known_wall_at_source_end(self):
        obj = self.reviewer([way(10, [1, 2, 3, 4], [(0, 0), (3, 0), (7, 2), (10, 2)]),
                             way(20, [5, 6], [(-1, 1), (1, 1)], {'barrier': 'wall'})])
        row = response([(0, 0), (3, 0), (7, 0), (10, 2)], [[0, 3, 10]])
        r = self.evaluate(obj, row, start=[0, 2])
        self.assertEqual(r['status'], 'NEEDS_REFINEMENT')
        self.assertTrue(any('BARRIER' in reason for reason in r['reasons']))

    def test_invalid_native_body_does_not_crash_or_produce_a_route(self):
        obj = self.reviewer([way(10, [1, 2], [(0, 0), (10, 0)])])
        for body in [None, [], True]:
            r = obj.row_v2({'id': 'invalid', 'http_status': 200, 'body': body},
                           {'start': [0, 0], 'target': [10, 0]})
            self.assertEqual(r['status'], 'INSUFFICIENT_DATA')


if __name__ == '__main__':
    unittest.main()
