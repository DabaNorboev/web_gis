"""Contract checks: diagnostics must never become accepted user minutes."""
import unittest

from audit import decode_polyline6, distance, normalize


class ResultContractTest(unittest.TestCase):
    def test_no_path_and_unknown_are_distinct_and_null(self):
        for body, expected in [({'code': 'NoRoute'}, 'NO_PATH'), ({'code': 'NoSegment'}, 'NEEDS_REFINEMENT'), ({}, 'UNKNOWN')]:
            result = normalize('osrm', {'status': 400, 'body': body}, [92, 56], [93, 56], 'walking')
            self.assertEqual(expected, result['status'])
            self.assertIsNone(result['value_distance_m'])
            self.assertIsNone(result['value_seconds'])
            self.assertIsNone(result['line'])

    def test_valhalla_echoed_input_cannot_hide_wrong_actual_endpoint(self):
        body = {'trip': {'status': 0, 'locations': [{'lon': 92, 'lat': 56}, {'lon': 93, 'lat': 56}],
                         'legs': [{'shape': {'type': 'LineString', 'coordinates': [[92.01, 56], [93, 56]]}}],
                         'summary': {'length': 70, 'time': 1000}}}
        result = normalize('valhalla', {'status': 200, 'body': body}, [92, 56], [93, 56], 'walking')
        self.assertGreater(result['gap_start_m'], 600)
        self.assertEqual('NEEDS_REFINEMENT', result['status'])
        self.assertIsNone(result['value_seconds'])

    def test_short_shape_remains_unaccepted_pending_barrier_checks(self):
        body = {'code': 'Ok', 'routes': [{'geometry': {'type': 'LineString', 'coordinates': [[92, 56], [92.001, 56]]}, 'distance': 63, 'duration': 45}]}
        result = normalize('osrm', {'status': 200, 'body': body}, [92, 56], [92.001, 56], 'walking')
        self.assertEqual('REVIEW_REQUIRED', result['status'])
        self.assertEqual(0, result['gap_start_m'])
        self.assertIsNone(result['value_distance_m'])
        self.assertIsNone(result['value_seconds'])

    def test_distance_against_equatorial_arc(self):
        self.assertAlmostEqual(111195.0802335329, distance([0, 0], [1, 0]), places=5)

    def test_polyline6_delta_axes_and_truncated_input(self):
        self.assertEqual([[0, 0], [0, .000001]], decode_polyline6('??A?'))
        with self.assertRaises(ValueError):
            decode_polyline6('??A')


if __name__ == '__main__':
    unittest.main()
