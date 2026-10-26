"""Synthetic endpoint grouping checks in projected metres; no source/evidence IO."""
import unittest

from endpoint_groups import group_candidates


def candidate(way, u, v, point):
    return {'gap': 0, 'point': point, 'way': way, 'u': u, 'v': v}


class EndpointGroups(unittest.TestCase):
    def test_adjacent_same_way_projections_share_the_actual_junction(self):
        values = [candidate(10, 1, 2, (-.14, 0)), candidate(10, 2, 3, (.15, 0))]
        self.assertEqual(group_candidates(values, {2: (0, 0)}), [values])

    def test_crossing_different_ways_share_one_original_node(self):
        values = [candidate(10, 1, 2, (-.5, 0)), candidate(20, 2, 3, (0, .5))]
        self.assertEqual(group_candidates(values, {2: (0, 0)}), [values])

    def test_close_parallel_disconnected_ways_stay_distinct(self):
        values = [candidate(10, 1, 2, (0, 0)), candidate(20, 3, 4, (0, .2))]
        groups = group_candidates(values, {1: (0, 0), 3: (0, .2)})
        self.assertEqual(groups, [[values[0]], [values[1]]])

    def test_same_way_does_not_equate_distant_positions(self):
        values = [candidate(10, 1, 2, (3, 0)), candidate(10, 1, 2, (7, 0)),
                  candidate(10, 2, 3, (10, 5))]
        groups = group_candidates(values, {1: (0, 0), 2: (10, 0), 3: (10, 10)})
        self.assertEqual(groups, [[value] for value in values])

    def test_same_edge_reverse_order_and_precision_agree(self):
        values = [candidate(10, 1, 2, (5, 0)), candidate(10, 2, 1, (5.2, 0))]
        self.assertEqual(group_candidates(values, {}), [values])
        values[1]['way'] = 20
        self.assertEqual(group_candidates(values, {}), [[values[0]], [values[1]]])

    def test_multiple_junction_anchors_do_not_merge_transitively(self):
        values = [candidate(10, 0, 1, (-.1, 0)), candidate(20, 1, 2, (.5, 0)),
                  candidate(30, 2, 3, (1.1, 0))]
        groups = group_candidates(values, {1: (0, 0), 2: (1, 0)})
        self.assertEqual(groups, [values[:2], values[1:]])
        self.assertTrue(all(len(group) < 3 for group in groups))

    def test_same_edge_precision_does_not_chain_transitively(self):
        values = [candidate(10, 1, 2, (x, 0)) for x in (4, 4.2, 4.4)]
        self.assertEqual(group_candidates(values, {}), [values[:2], values[1:]])

    def test_missing_source_node_position_cannot_establish_a_junction(self):
        values = [candidate(10, 1, 2, (0, 0)), candidate(20, 2, 3, (0, 0))]
        self.assertEqual(group_candidates(values, {}), [[values[0]], [values[1]]])

    def test_junction_band_does_not_expand_snap_or_connect_distant_points(self):
        values = [candidate(10, 1, 2, (-1.001, 0)), candidate(20, 2, 3, (0, 0))]
        self.assertEqual(group_candidates(values, {2: (0, 0)}), [[values[0]], [values[1]]])
        with self.assertRaises(ValueError):
            group_candidates(values, {}, junction_band_m=1.001)
        with self.assertRaises(ValueError):
            group_candidates(values, {}, precision_m=.251)

    def test_empty_candidates_and_input_records_are_preserved(self):
        self.assertEqual(group_candidates([], {}), [])
        value = candidate(10, 1, 2, (3, 0))
        result = group_candidates([value], {})
        self.assertIs(result[0][0], value)


if __name__ == '__main__':
    unittest.main()
