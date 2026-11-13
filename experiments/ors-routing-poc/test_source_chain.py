"""Synthetic original-node regressions; no live routing, database, or evidence IO."""
import unittest
from unittest.mock import patch

from source_chain import SourceChainMatcher


def way(identifier, nodes, points, tags=None):
    return {'id': identifier, 'nodes': nodes, 'coordinates': points,
            'tags': tags or {'highway': 'service'}}


class SourceChains(unittest.TestCase):
    def setUp(self):
        # Metre coordinates make the precision boundary tests exact. Production
        # uses the retained historical UTM projection; no GIS stack is involved.
        self.projection = patch('source_chain.utm', side_effect=lambda p: tuple(p))
        self.projection.start()
        self.addCleanup(self.projection.stop)

    def match(self, ways, coordinates, ids=None):
        return SourceChainMatcher(ways).match(coordinates, ids or [{10}] * (len(coordinates) - 1))

    def test_skipped_collinear_source_node_is_retained(self):
        result = self.match([way(10, [1, 2, 3], [(0, 0), (5, 0), (10, 0)])],
                            [(0, 0), (10, 0)])
        self.assertEqual(result['status'], 'MATCHED')
        self.assertEqual([(p['u'], p['v']) for p in result['segments']], [(1, 2), (2, 3)])
        self.assertEqual(result['segments'][0]['end_node'], 2)

    def test_import_simplification_preserves_actual_bend_for_obstacles(self):
        result = self.match([way(10, [1, 2, 3], [(0, 0), (5, .8), (10, 0)],
                                      {'access': 'no'})], [(0, 0), (10, 0)])
        self.assertEqual(result['status'], 'MATCHED')
        self.assertAlmostEqual(result['max_deviation_m'], .8)
        self.assertEqual(result['segments'][0]['b'], (5, .8))
        self.assertEqual(result['segments'][1]['a'], (5, .8))
        self.assertEqual(result['segments'][0]['tags']['access'], 'no')

    def test_excessive_bend_is_not_representation_error(self):
        result = self.match([way(10, [1, 2, 3], [(0, 0), (5, 1.251), (10, 0)])],
                            [(0, 0), (10, 0)])
        self.assertEqual(result['status'], 'UNMATCHED')
        self.assertIn('SOURCE_CHAIN_REPRESENTATION_MISMATCH', result['reasons'])

    def test_wrong_declared_way_and_parallel_geometry_cannot_be_mixed(self):
        ways = [way(10, [1, 2], [(0, 0), (10, 0)]),
                way(20, [3, 4], [(0, .3), (10, .3)])]
        result = self.match(ways, [(0, 0), (10, 0)], [{20}])
        self.assertEqual(result['status'], 'UNMATCHED')
        self.assertEqual(result['segments'], [])
        result = self.match(ways, [(0, 0), (10, 0)], [{999}])
        self.assertIn('DECLARED_OSM_WAY_NOT_IN_SOURCE', result['reasons'])

    def test_declared_close_parallel_way_is_used_exclusively(self):
        ways = [way(10, [1, 2], [(0, 0), (10, 0)]),
                way(20, [3, 4], [(0, .2), (10, .2)])]
        result = self.match(ways, [(0, 0), (10, 0)], [{20}])
        self.assertEqual(result['status'], 'MATCHED')
        self.assertEqual([p['way'] for p in result['segments']], [20])
        self.assertEqual(result['segments'][0]['a'], (0, .2))

    def test_same_coordinate_different_nodes_does_not_connect(self):
        ways = [way(10, [1, 2], [(0, 0), (5, 0)]),
                way(20, [3, 4], [(5, 0), (10, 0)])]
        result = self.match(ways, [(0, 0), (5, 0), (10, 0)], [{10}, {20}])
        self.assertEqual(result['status'], 'UNMATCHED')
        self.assertIn('SOURCE_NODE_CONTINUITY_MISMATCH', result['reasons'])
        self.assertEqual(len(result['segments']), 2)  # diagnostic pieces survive
        ways[1]['nodes'][0] = 2
        self.assertEqual(self.match(ways, [(0, 0), (5, 0), (10, 0)],
                                    [{10}, {20}])['status'], 'MATCHED')

    def test_mid_edge_clipping_and_consecutive_positions(self):
        result = self.match([way(10, [1, 2, 3], [(0, 0), (5, 0), (10, 0)])],
                            [(2, 0), (4, 0), (8, 0)])
        self.assertEqual(result['status'], 'MATCHED')
        first, second, third = result['segments']
        self.assertEqual((first['a'], first['b']), ((2, 0), (4, 0)))
        self.assertIsNone(first['start_node'])
        self.assertIsNone(first['end_node'])
        self.assertIsNone(second['start_node'])
        self.assertEqual(second['end_node'], 2)
        self.assertIsNone(third['end_node'])

    def test_reverse_direction_retains_source_ids_and_fractions(self):
        result = self.match([way(10, [1, 2, 3], [(0, 0), (5, .8), (10, 0)])],
                            [(9, .16), (1, .16)])
        self.assertEqual(result['status'], 'MATCHED')
        self.assertEqual([p['edge_index'] for p in result['segments']], [1, 0])
        self.assertTrue(all(not p['forward'] and p['t0'] > p['t1'] for p in result['segments']))
        self.assertEqual(result['segments'][0]['end_node'], 2)
        self.assertEqual(result['segments'][1]['start_node'], 2)

    def test_repeated_source_geometry_is_ambiguous(self):
        result = self.match([way(10, [1, 2, 3, 4], [(0, 0), (10, 0), (0, 0), (10, 0)])],
                            [(2, 0), (8, 0)])
        self.assertEqual(result['status'], 'AMBIGUOUS')
        self.assertIn('AMBIGUOUS_SOURCE_CHAIN', result['reasons'])

    def test_following_original_node_can_resolve_local_ambiguity(self):
        ways = [way(10, [1, 2, 3, 4], [(0, 0), (10, 0), (0, 0), (10, 0)]),
                way(20, [4, 5], [(10, 0), (20, 0)])]
        result = self.match(ways, [(2, 0), (10, 0), (20, 0)], [{10}, {20}])
        self.assertEqual(result['status'], 'MATCHED')
        self.assertGreater(result['shape_segments'][0]['candidate_count'], 1)
        self.assertEqual(result['segments'][0]['edge_index'], 2)
        self.assertEqual(result['segments'][0]['end_node'], 4)

    def test_disconnected_parallel_transition_fails_even_inside_precision(self):
        ways = [way(10, [1, 2], [(0, 0), (10, 0)]),
                way(20, [3, 4], [(10, .2), (20, .2)])]
        result = self.match(ways, [(0, 0), (10, 0), (20, .2)], [{10}, {20}])
        self.assertEqual(result['status'], 'UNMATCHED')
        self.assertIn('SOURCE_NODE_CONTINUITY_MISMATCH', result['reasons'])

    def test_closed_way_can_cross_its_original_endpoint(self):
        points = [(0, 0), (5, 0), (5, 5), (0, 5), (0, 0)]
        result = self.match([way(10, [1, 2, 3, 4, 1], points)],
                            [(0, 1), (1, 0)])
        self.assertEqual(result['status'], 'MATCHED')
        self.assertEqual([p['edge_index'] for p in result['segments']], [3, 0])
        self.assertEqual(result['segments'][0]['end_node'], 1)
        self.assertEqual(result['segments'][1]['start_node'], 1)

    def test_endpoint_precision_canonicalization_is_recorded(self):
        ways = [way(10, [1, 2], [(0, 0), (10, 0)])]
        result = self.match(ways, [(.2, 0), (9.8, 0)])
        self.assertEqual(result['status'], 'MATCHED')
        self.assertEqual(result['segments'][0]['start_node'], 1)
        self.assertTrue(result['endpoint_matches'][0]['start']['canonicalized'])
        result = self.match(ways, [(0, .251), (10, .251)])
        self.assertEqual(result['status'], 'UNMATCHED')
        self.assertIn('SOURCE_CHAIN_ENDPOINT_MISMATCH', result['reasons'])

    def test_unmatched_piece_does_not_hide_other_diagnostic_source_geometry(self):
        result = self.match([way(10, [1, 2], [(0, 0), (10, 0)])],
                            [(0, 0), (10, 0), (20, 0)])
        self.assertEqual(result['status'], 'UNMATCHED')
        self.assertEqual(len(result['segments']), 1)
        self.assertEqual(result['segments'][0]['raw_segment_index'], 0)

    def test_same_node_id_with_different_source_coordinates_is_rejected(self):
        ways = [way(10, [1, 2], [(0, 0), (10, 0)]),
                way(20, [2, 3], [(10, .2), (20, .2)])]
        with self.assertRaisesRegex(ValueError, 'same OSM node ID'):
            SourceChainMatcher(ways)
        with self.assertRaisesRegex(ValueError, 'same OSM node ID'):
            SourceChainMatcher([way(10, [1, 2, 1], [(0, 0), (10, 0), (0, .2)])])

    def test_thresholds_cannot_be_relaxed_accidentally(self):
        for kwargs in ({'endpoint_tolerance_m': .251}, {'representation_tolerance_m': 1.251}):
            with self.assertRaises(ValueError):
                SourceChainMatcher([], **kwargs)


if __name__ == '__main__':
    unittest.main()
