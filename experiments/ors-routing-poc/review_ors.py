"""Offline source-model review of local ORS responses. Never calls app or DB.

Uses the attributed historical pedestrian geometry checker (see PROVENANCE.md).
Passing means consistency with this incomplete source model, never physical access.
"""
import argparse
import csv
import math
from pathlib import Path

from historical_geometry import distance, polygons, project, utm
from historical_review import Network, Obstacles, Reviewer
from review_support import GUARDS, HERE, REPORT, digest, read, write

CAR_CLASSES = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary',
               'primary_link', 'secondary', 'secondary_link', 'tertiary',
               'tertiary_link', 'residential', 'unclassified', 'living_street',
               'service', 'track', 'road'}
CAR_KEYS = ('motorcar', 'motor_vehicle', 'vehicle', 'access')


def car_access(tags, policy, node=False):
    # Unknown conditions cannot establish permission in this experiment.
    if any('conditional' in key for key in tags):
        return False, 'CONDITIONAL_ACCESS_UNKNOWN'
    value = next((tags[key] for key in CAR_KEYS if key in tags), None)
    if value is not None and value not in policy['access_allow']:
        return False, 'ACCESS_DENIED_OR_UNKNOWN'
    if tags.get('locked') == 'yes':
        return False, 'LOCKED_GATE'
    if tags.get('indoor') == 'yes' or tags.get('conveying') not in (None, 'no'):
        return False, 'INDOOR_OR_CONVEYING_UNKNOWN'
    if node:
        if tags.get('barrier') in (None, 'no'):
            return True, None
        if tags.get('barrier') in ('gate', 'lift_gate', 'swing_gate', 'sliding_gate'):
            return (True, None) if value in policy['access_allow'] else (False, 'GATE_ACCESS_UNKNOWN')
        return False, 'BARRIER_NODE_UNKNOWN'
    if tags.get('highway') not in CAR_CLASSES or tags.get('area') == 'yes':
        return False, 'UNSUPPORTED_OR_FORBIDDEN_HIGHWAY'
    return True, None


def car_direction(tags, forward):
    value = next((tags[key] for key in ('oneway:motorcar', 'oneway:motor_vehicle',
                 'oneway:vehicle', 'oneway') if key in tags),
                 'yes' if tags.get('junction') == 'roundabout' else 'no')
    if value in ('no', '0', 'false'):
        return True
    if value in ('yes', '1', 'true'):
        return forward
    if value in ('-1', 'reverse'):
        return not forward
    return False


def ors_line(body):
    """Validate one full GeoJSON line and OsmId attribution for every segment."""
    if body.get('type') != 'FeatureCollection' or not isinstance(body.get('features'), list) or len(body['features']) != 1:
        raise ValueError('EXPECTED_SINGLE_GEOJSON_FEATURE')
    feature = body['features'][0]
    if not isinstance(feature, dict) or not isinstance(feature.get('geometry'), dict) or not isinstance(feature.get('properties'), dict):
        raise ValueError('INVALID_GEOJSON_FEATURE')
    geometry = feature['geometry']
    coordinates = geometry['coordinates']
    if geometry.get('type') != 'LineString' or not isinstance(coordinates, list) or not 2 <= len(coordinates) <= 10000:
        raise ValueError('INVALID_FULL_LINE')
    if not all(isinstance(p, list) and len(p) == 2 and all(
            isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)
            for x in p) for p in coordinates):
        raise ValueError('INVALID_COORDINATES')
    summary = feature['properties']['summary']
    if not isinstance(summary, dict):
        raise ValueError('INVALID_MEASURES')
    if not all(isinstance(summary[k], (int, float)) and not isinstance(summary[k], bool)
               and math.isfinite(summary[k]) and summary[k] >= 0 for k in ('distance', 'duration')):
        raise ValueError('INVALID_MEASURES')
    attribution = [set() for _ in range(len(coordinates) - 1)]
    extras = feature['properties'].get('extras')
    if not isinstance(extras, dict):
        raise ValueError('MISSING_OSMID_RANGES')
    # ORS 10.1 requests extra_info=osmid but serializes the response as osmId.
    osm_id = extras.get('osmId', extras.get('osmid'))
    if not isinstance(osm_id, dict) or not isinstance(osm_id.get('values'), list):
        raise ValueError('MISSING_OSMID_RANGES')
    for value in osm_id['values']:
        if not isinstance(value, list) or len(value) != 3:
            raise ValueError('INVALID_OSMID_RANGE')
        first, last, way = value
        if any(not isinstance(x, int) or isinstance(x, bool) for x in value) or not (
                0 <= first < last < len(coordinates) and way > 0):
            raise ValueError('INVALID_OSMID_RANGE')
        for i in range(first, last):
            attribution[i].add(way)
    if any(len(ids) != 1 for ids in attribution):
        raise ValueError('INCOMPLETE_OR_AMBIGUOUS_OSMID')
    return coordinates, summary, attribution


class OrsReviewer(Reviewer):
    def __init__(self, source, out, mode):
        self.mode = mode
        self.policy = read(HERE / 'walking-policy.json') | {'mode': mode}
        self.policy['snap_limit_m'] = 20 if mode == 'walking' else 35
        self.network = Network(source, out, self.policy)
        self.obstacles = Obstacles(source)
        self.service = polygons(read(source / GUARDS / 'guard-sources.json')['service_geometry'])
        self.bbox = read(source / 'experiments/local-routing-poc/controls.json')['pilot_bbox']
        w, s, e, n = self.bbox
        self.box_ring = [utm(p) for p in [(w, s), (e, s), (e, n), (w, n), (w, s)]]

    def source_attribution(self, coordinates, attribution):
        issues = []
        points = [utm(p) for p in coordinates]
        for index, (a, b) in enumerate(zip(points, points[1:])):
            if distance(a, b) < 1e-7:
                continue
            matches = [edge for edge in self.network.matching(a, b)
                       if edge['way'] in attribution[index]]
            if not matches:
                issues.append('OSMID_DOES_NOT_MATCH_COMPLETE_SOURCE_SEGMENT')
                continue
            # A way ID alone does not prove the traversed source segment/direction.
            for edge in matches:
                if not edge['allowed']:
                    issues.append(edge['reason'])
                if self.mode == 'driving':
                    along = ((b[0] - a[0]) * (edge['b'][0] - edge['a'][0]) +
                             (b[1] - a[1]) * (edge['b'][1] - edge['a'][1])) > 0
                    if not car_direction(edge['tags'], along):
                        issues.append('CAR_ONEWAY_VIOLATION_OR_UNKNOWN')
        return sorted(set(issues))

    def ors_row(self, row, case):
        body = row.get('body') or {}
        if not isinstance(body, dict):
            body = {}
        error = body.get('error') or {}
        if not isinstance(error, dict):
            error = {}
        osrm = {'code': {2009: 'NoRoute', 2010: 'NoSegment'}.get(error.get('code'), 'Unknown')}
        parsing_issue = None
        parsed = None
        if body.get('type') == 'FeatureCollection' and row.get('http_status') == 200:
            try:
                parsed = ors_line(body)
                coordinates, summary, _ = parsed
                osrm = {'code': 'Ok', 'routes': [{'geometry': {'type': 'LineString', 'coordinates': coordinates},
                         'distance': summary['distance'], 'duration': summary['duration']}]}
            except (KeyError, TypeError, ValueError, IndexError) as exc:
                parsing_issue = str(exc) if isinstance(exc, ValueError) else 'MALFORMED_ORS_GEOJSON'
        http_status = row.get('http_status')
        normalized = dict(row, body=osrm, diagnostic=bool(row.get('diagnostic', False)),
                          http_status=http_status if isinstance(http_status, int) else 0)
        if row.get('status') == 'OUTSIDE_PILOT':
            normalized['status'] = 'OUTSIDE_PILOT'
        result = self.row('osrm', normalized, case)
        if parsing_issue:
            result.update(status='INSUFFICIENT_DATA', reasons=[parsing_issue])
        if parsed:
            issues = self.source_attribution(parsed[0], parsed[2])
            result['ors_osmid_issues'] = issues
            if issues and result['status'] == 'MODEL_GEOMETRY_CONSISTENT':
                result.update(status='INSUFFICIENT_DATA', reasons=issues)
        # Historical unresolved crossings cannot be cleared by changing engine.
        if self.mode == 'walking' and row['id'] in ('bridge', 'railway'):
            result['historical_unresolved'] = ['CROSSING_LEVEL_OR_ACCESS_NOT_INDEPENDENTLY_RESOLVED']
            if result['status'] == 'MODEL_GEOMETRY_CONSISTENT':
                result.update(status='INSUFFICIENT_DATA', reasons=result['historical_unresolved'])
        # Research output never carries a displayable ETA or accepted product metric.
        measured = result.pop('distance_m', None)
        result['model_consistent_distance_m'] = measured if result['status'] == 'MODEL_GEOMETRY_CONSISTENT' else None
        result['distance_m'] = None
        result['duration_s'] = None
        result['mode'] = self.mode
        result['http_status'] = row.get('http_status')
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--mode', choices=('walking', 'driving'), required=True)
    args = parser.parse_args()
    source, out = args.source.resolve(), args.output.resolve()
    target = out / args.mode / 'review.json'
    if target.exists() or target.with_suffix('.csv').exists():
        raise FileExistsError('Review output already exists; use a new evidence directory')
    controls_path = source / 'experiments/local-routing-poc/controls.json'
    cases = {c['id']: {'start': c['start']['coordinate'], 'target': c['target']['coordinate']}
             for c in read(controls_path)['cases']}
    diagnostics = read(source / 'experiments/local-routing-poc/diagnostic-controls.json')
    for name in ('isolated_stairs', 'isolated_service'):
        cases[name] = {key: diagnostics[name][key] for key in ('start', 'target')}
    cases['disconnected'] = {'start': diagnostics['isolated_stairs']['start'],
                             'target': diagnostics['isolated_service']['target']}
    rows = read(out / args.mode / 'responses.json')['rows']
    if len({r['id'] for r in rows}) != len(rows) or any(r['id'] not in cases for r in rows):
        raise ValueError('Duplicate or unknown fixed case IDs')
    reviewer = OrsReviewer(source, out, args.mode)
    reviewed = [reviewer.ors_row(row, cases[row['id']]) for row in rows]
    result = {'mode': args.mode, 'rows': reviewed, 'controls_sha256': digest(controls_path),
              'response_sha256': digest(out / args.mode / 'responses.json'),
              'checker_sha256': digest(Path(__file__)), 'nodes_sha256': digest(out / 'nodes.jsonl'),
              'source_pbf_sha256': digest(source / REPORT / 'prepared/pilot.osm.pbf'),
              'observed_at': None, 'freshness': 'UNKNOWN', 'product_integration': 'NOT_PERFORMED',
              'limitations': ['Incomplete retained OSM nodes and obstacles; no field or ETA validation.',
                              'Conservative complete-segment attribution can reject otherwise valid geometry.',
                              'Building origins are rejected for both modes in this isolated comparison.']}
    write(target, result)
    with target.with_suffix('.csv').open('x') as stream:
        writer = csv.writer(stream)
        writer.writerow(['mode', 'id', 'status', 'model_consistent_distance_m', 'raw_distance_m',
                         'raw_model_seconds', 'distance_m', 'duration_s', 'reasons'])
        for row in reviewed:
            writer.writerow([row[key] for key in ('mode', 'id', 'status', 'model_consistent_distance_m',
                             'raw_distance_m', 'raw_model_seconds', 'distance_m', 'duration_s')] +
                            [';'.join(row['reasons'])])
    print('Reviewed', len(reviewed), args.mode, 'rows:', target)


if __name__ == '__main__':
    main()
