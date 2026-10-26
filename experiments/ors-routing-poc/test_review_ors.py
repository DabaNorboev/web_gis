"""Synthetic regression cases for the new ORS adapter and car policy."""
import unittest
from types import SimpleNamespace

from historical_geometry import utm
from review_ors import OrsReviewer, car_access, car_direction, ors_line
from review_support import HERE, read


def feature(way=10):
    return {'type': 'FeatureCollection', 'features': [{'geometry': {
        'type': 'LineString', 'coordinates': [[92.8, 56], [92.8001, 56]]},
        'properties': {'summary': {'distance': 6.24, 'duration': 5},
                       'extras': {'osmid': {'values': [[0, 1, way]]}}}}]}


class CarPolicy(unittest.TestCase):
    def setUp(self):
        self.policy = read(HERE / 'walking-policy.json') | {'mode': 'driving'}

    def test_access_specific_mode_overrides_general(self):
        self.assertTrue(car_access({'highway': 'service', 'access': 'private',
                                    'motorcar': 'yes'}, self.policy)[0])
        self.assertFalse(car_access({'highway': 'service', 'motor_vehicle': 'no',
                                     'access': 'yes'}, self.policy)[0])

    def test_closed_unknown_and_foot_only_not_car(self):
        for tags in ({'barrier': 'gate'}, {'barrier': 'bollard', 'motorcar': 'yes'},
                     {'barrier': 'gate', 'motorcar': 'yes', 'locked': 'yes'}):
            self.assertFalse(car_access(tags, self.policy, node=True)[0])
        self.assertFalse(car_access({'highway': 'footway', 'foot': 'yes'}, self.policy)[0])
        self.assertFalse(car_access({'highway': 'service', 'motorcar:conditional': 'yes @ (Mo)'}, self.policy)[0])

    def test_car_direction_and_specific_override(self):
        self.assertFalse(car_direction({'oneway': 'yes'}, False))
        self.assertTrue(car_direction({'oneway': 'yes', 'oneway:motorcar': 'no'}, False))
        self.assertTrue(car_direction({'oneway': '-1'}, False))
        self.assertFalse(car_direction({'junction': 'roundabout'}, False))
        self.assertFalse(car_direction({'oneway': 'reversible'}, True))


class OrsShape(unittest.TestCase):
    def test_actual_ors_camel_case_osmid_response(self):
        body = feature()
        extras = body['features'][0]['properties']['extras']
        extras['osmId'] = extras.pop('osmid')
        self.assertEqual(ors_line(body)[2], [{10}])

    def test_osmid_must_cover_every_shape_segment(self):
        body = feature()
        body['features'][0]['geometry']['coordinates'].append([92.8002, 56])
        with self.assertRaisesRegex(ValueError, 'INCOMPLETE'):
            ors_line(body)

    def test_unknown_ambiguous_or_invalid_osmid_rejected(self):
        for ranges in ([[0, 1, 0]], [[0, 1, 10], [0, 1, 11]], [[0, 2, 10]], [[False, 1, 10]]):
            body = feature()
            body['features'][0]['properties']['extras']['osmid']['values'] = ranges
            with self.assertRaises(ValueError):
                ors_line(body)

    def test_boolean_or_altitude_coordinates_not_accepted(self):
        for coordinate in ([True, 56], [92.8, 56, 120]):
            body = feature()
            body['features'][0]['geometry']['coordinates'][0] = coordinate
            with self.assertRaises(ValueError):
                ors_line(body)

    def reviewer(self, mode='driving', tags=None):
        reviewer = OrsReviewer.__new__(OrsReviewer)
        reviewer.mode = mode
        reviewer.policy = read(HERE / 'walking-policy.json') | {'mode': mode}
        reviewer.bbox = [92.7, 55.9, 93.2, 56.2]
        edge = {'way': 10, 'a': utm([92.8, 56]), 'b': utm([92.8001, 56]),
                'allowed': True, 'tags': tags or {'highway': 'service'}}
        reviewer.network = SimpleNamespace(matching=lambda a, b: [edge])
        reviewer.in_scope = lambda points: True
        reviewer.endpoint = lambda p, actual, radius: (None, [])
        reviewer.conflicts = lambda a, b, mapped=(), connector=False: []
        return reviewer

    def run_row(self, reviewer, body=None, status=200, case_id='synthetic'):
        return reviewer.ors_row({'id': case_id, 'diagnostic': False,
            'http_status': status, 'body': body or feature()},
            {'start': [92.8, 56], 'target': [92.8001, 56]})

    def test_matching_shape_keeps_product_metrics_null(self):
        result = self.run_row(self.reviewer())
        self.assertEqual(result['status'], 'MODEL_GEOMETRY_CONSISTENT')
        self.assertGreater(result['model_consistent_distance_m'], 0)
        self.assertIsNone(result['distance_m'])
        self.assertIsNone(result['duration_s'])

    def test_osmid_mismatch_cannot_pass_by_geometry_alone(self):
        result = self.run_row(self.reviewer(), feature(way=999))
        self.assertEqual(result['status'], 'INSUFFICIENT_DATA')
        self.assertIsNone(result['model_consistent_distance_m'])

    def test_reverse_oneway_and_old_crossing_cannot_pass(self):
        result = self.run_row(self.reviewer(tags={'oneway': '-1'}))
        self.assertEqual(result['status'], 'INSUFFICIENT_DATA')
        self.assertIn('CAR_ONEWAY_VIOLATION_OR_UNKNOWN', result['reasons'])
        result = self.run_row(self.reviewer(mode='walking'), case_id='bridge')
        self.assertEqual(result['status'], 'INSUFFICIENT_DATA')

    def test_http_failure_never_accepted_with_feature_body(self):
        for status in (400, 503, None):
            result = self.run_row(self.reviewer(), status=status)
            self.assertNotEqual(result['status'], 'MODEL_GEOMETRY_CONSISTENT')

    def test_malformed_feature_shapes_are_unknown_instead_of_crashing(self):
        for value in (None, [], True):
            body = feature()
            body['features'][0]['geometry'] = value
            result = self.run_row(self.reviewer(), body=body)
            self.assertEqual(result['status'], 'INSUFFICIENT_DATA')


if __name__ == '__main__':
    unittest.main()
