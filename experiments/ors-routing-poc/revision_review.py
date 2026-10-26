"""Versioned offline ORS source review. Historical checker/evidence stay intact.

Representation matching uses declared ways and original-node identity. Semantic
checks use reconstructed original pieces, never a widened obstacle buffer.
This research result never carries a displayable product distance or ETA.
"""
import argparse
import csv
import json
from pathlib import Path

from endpoint_groups import group_candidates
from historical_geometry import bounds, distance, inside_polygon, intersects, polygons, project, touches_polygon, utm
from historical_review import Network, Obstacles, Reviewer, access
from review_ors import car_direction, ors_line
from review_support import GUARDS, HERE, REPORT, digest, read, write
from source_chain import SourceChainMatcher


def known_layer(tags):
    try:
        value = tags.get('layer')
        return int(value) if value is not None and str(value).lstrip('-').isdigit() else None
    except (TypeError, ValueError):
        return None


def selected_nodes(piece):
    return {node for node in (piece['start_node'], piece['end_node']) if node is not None}


def overlaps_as_line(a, b, c, d):
    """A gate/level-crossing node can justify a point, never a shared line."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = distance(a, b)
    if length < 1e-7:
        return False
    if any(abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / length > 1e-6 for p in (c, d)):
        return False
    positions = [((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length ** 2 for p in (c, d)]
    return (min(1, max(positions)) - max(0, min(positions))) * length > 1e-6


class RevisionReviewer(Reviewer):
    def __init__(self, source, evidence, mode):
        self.mode = mode
        self.policy = read(HERE / 'walking-policy.json') | {'mode': mode, 'snap_limit_m': 20 if mode == 'walking' else 35}
        self.network = Network(source, evidence, self.policy)
        self.obstacles = Obstacles(source)
        self.service = polygons(read(source / GUARDS / 'guard-sources.json')['service_geometry'])
        self.bbox = read(source / 'experiments/local-routing-poc/controls.json')['pilot_bbox']
        w, s, e, n = self.bbox
        self.box_ring = [utm(p) for p in [(w, s), (e, s), (e, n), (w, n), (w, s)]]
        for node_id, node in self.network.nodes.items():
            if any(key.startswith(('motorcar', 'motor_vehicle', 'vehicle')) for key in node['tags']):
                self.network.node_index.add(node_id, bounds([node['point']]))
        self.matcher = SourceChainMatcher([w for w in self.network.ways if 'highway' in w['tags']])
        self.node_points = {node: utm(point) for way in self.network.ways
                            for node, point in zip(way['nodes'], way['coordinates'])}

    def route_access(self, pieces):
        issues = []
        for piece in pieces:
            ok, reason = access(piece['tags'], self.policy)
            if not ok:
                issues.append(reason + ':way/' + str(piece['way']))
            if self.mode == 'driving' and not car_direction(piece['tags'], piece['forward']):
                issues.append('CAR_ONEWAY_VIOLATION_OR_UNKNOWN:way/' + str(piece['way']))
            for node_id in selected_nodes(piece):
                node = self.network.nodes.get(node_id)
                if node:
                    ok, reason = access(node['tags'], self.policy, node=True)
                    if not ok:
                        issues.append(reason + ':node/' + str(node_id))
        return sorted(set(issues))

    def source_conflicts(self, a, b, piece=None, connector=False):
        """Check exact source geometry, with level evidence from that edge only."""
        issues = []
        tags = piece['tags'] if piece else {}
        road_nodes = selected_nodes(piece) if piece else set()
        bridge = tags.get('bridge') in ('yes', 'viaduct', 'boardwalk')
        tunnel = tags.get('tunnel') in ('yes', 'building_passage')
        for obstacle_id, kind, parts in self.obstacles.query(a, b):
            if not any(touches_polygon(a, b, polygon) for polygon in parts):
                continue
            if not connector and ((kind == 'water' and bridge) or
                                  (kind == 'building' and (bridge or tunnel))):
                continue
            issues.append(('CONNECTOR_' if connector else 'ROUTE_') + kind.upper() + ':' + obstacle_id)
        for edge in self.network.near_segments(a, b):
            other = edge['tags']
            if not intersects(a, b, edge['a'], edge['b']):
                continue
            barrier = other.get('barrier') in ('wall', 'fence', 'retaining_wall')
            railway = other.get('railway') in ('rail', 'narrow_gauge')
            if barrier or railway:
                layer_a, layer_b = known_layer(tags), known_layer(other)
                separated = (not connector and (bridge or tunnel) and
                             layer_a is not None and layer_b is not None and layer_a != layer_b and
                             not (road_nodes & {edge['u'], edge['v']}))
                overlap = overlaps_as_line(a, b, edge['a'], edge['b'])
                for hazard, present in [('barrier', barrier), ('railway', railway)]:
                    if not present:
                        continue
                    crossing = False
                    for node_id in road_nodes & {edge['u'], edge['v']}:
                        node = self.network.nodes.get(node_id)
                        if not node or not access(node['tags'], self.policy, node=True)[0] or overlap:
                            continue
                        if hazard == 'railway' and node['tags'].get('railway') in ('crossing', 'level_crossing'):
                            crossing = True
                        if hazard == 'barrier' and node['tags'].get('barrier') in (
                                'gate', 'lift_gate', 'wicket_gate', 'entrance', 'door',
                                'kissing_gate', 'swing_gate', 'sliding_gate'):
                            crossing = True
                    if not (separated or crossing):
                        issues.append(('BARRIER_REVIEW' if hazard == 'barrier' else 'RAILWAY_LEVEL_OR_CROSSING_UNKNOWN') +
                                      ':way/' + str(edge['way']))
            if connector and 'highway' in other and other['highway'] not in ('footway', 'path', 'steps', 'pedestrian'):
                # Keep the historical road-side invariant: a connector ending
                # on the selected road does not establish crossing another road.
                if project(b, edge['a'], edge['b'])[0] > .25 or project(a, edge['a'], edge['b'])[0] > .25:
                    issues.append('CONNECTOR_ROAD_SIDE_UNKNOWN:way/' + str(edge['way']))
        if connector:
            for node_id in self.network.node_index.query(bounds([a, b], .25)):
                node = self.network.nodes[node_id]
                if project(node['point'], a, b)[0] <= .25:
                    ok, reason = access(node['tags'], self.policy, node=True)
                    if not ok:
                        issues.append(reason + ':node/' + str(node_id))
        return sorted(set(issues))

    def candidate_groups(self, original):
        candidates = []
        radius = self.policy['snap_limit_m']
        for edge in self.network.near_segments(original, original, radius):
            if 'highway' not in edge['tags'] or not access(edge['tags'], self.policy)[0]:
                continue
            gap, point = project(original, edge['a'], edge['b'])
            if gap <= radius:
                candidates.append({'gap': gap, 'point': point, 'way': edge['way'],
                                   'u': edge['u'], 'v': edge['v']})
        if not candidates:
            return []
        best = min(c['gap'] for c in candidates)
        near = [c for c in candidates if c['gap'] <= best + self.policy['ambiguity_band_m']]
        return group_candidates(near, self.node_points, self.policy['ambiguity_band_m'], .25)

    def endpoint_v2(self, original, actual):
        issues = []
        for obstacle_id, kind, parts in self.obstacles.query(original, original):
            if kind == 'building' and any(inside_polygon(original, polygon) for polygon in parts):
                return {'status': 'NEEDS_REFINEMENT', 'reasons': ['ORIGINAL_IN_BUILDING:' + obstacle_id]}
        groups = self.candidate_groups(original)
        if actual is not None:
            if distance(original, actual) > self.policy['snap_limit_m']:
                return {'status': 'NEEDS_REFINEMENT', 'reasons': ['SOURCE_ENDPOINT_OUTSIDE_RADIUS']}
            if distance(original, actual) > 1e-7:
                issues = self.source_conflicts(original, actual, connector=True)
                if issues:
                    return {'status': 'NEEDS_REFINEMENT', 'reasons': issues}
        if not groups:
            return {'status': 'INSUFFICIENT_DATA', 'reasons': ['NO_SOURCE_POLICY_SNAP']}
        if len(groups) > 1:
            return {'status': 'AMBIGUOUS_SNAP', 'reasons': ['DISTINCT_SOURCE_JUNCTION_OR_EDGE_CHOICES'],
                    'candidate_groups': len(groups)}
        if actual is not None and not any(distance(actual, c['point']) <= .25 for c in groups[0]):
            # One junction may have several projections. A source-node endpoint
            # on that SAME junction is equivalent only inside the fixed 1m band.
            shared = set.intersection(*({c['u'], c['v']} for c in groups[0]))
            equivalent = any(distance(actual, self.node_points[node]) <= .25 and all(
                distance(c['point'], self.node_points[node]) <= self.policy['ambiguity_band_m']
                for c in groups[0]) for node in shared if node in self.node_points)
            if not equivalent:
                return {'status': 'INSUFFICIENT_DATA', 'reasons': ['ENGINE_ENDPOINT_DIFFERS_FROM_SOURCE_CANDIDATE']}
        return {'status': 'SOURCE_CANDIDATE_CONSISTENT', 'reasons': [], 'candidate_groups': 1}

    def row_v2(self, row, case):
        original = [utm(case['start']), utm(case['target'])]
        result = {'id': row['id'], 'mode': self.mode, 'status': 'INSUFFICIENT_DATA',
                  'reasons': [], 'distance_m': None, 'duration_s': None,
                  'model_consistent_distance_m': None, 'raw_distance_m': None,
                  'raw_model_seconds': None, 'checks': {}, 'field_access_verified': False,
                  'turn_restrictions': 'NOT_VALIDATED' if self.mode == 'driving' else 'NOT_APPLICABLE'}
        if row.get('status') == 'OUTSIDE_PILOT' or not all(self.in_scope([p]) for p in original):
            return result | {'status': 'OUTSIDE_PILOT', 'reasons': ['OUTSIDE_CONFIRMED_SCOPE']}
        status = row.get('http_status')
        if row.get('error_class') or status is None or (isinstance(status, int) and status >= 500):
            return result | {'status': 'UNAVAILABLE', 'reasons': ['ROUTER_RESPONSE_UNAVAILABLE']}
        body = row.get('body')
        error = body.get('error') if isinstance(body, dict) else None
        code = error.get('code') if isinstance(error, dict) else None
        if code == 2010:
            return result | {'status': 'NEEDS_REFINEMENT', 'reasons': ['NATIVE_NO_SNAP']}
        if code == 2009:
            ends = [self.endpoint_v2(p, None) for p in original]
            result['checks']['endpoints'] = ends
            if all(e['status'] == 'SOURCE_CANDIDATE_CONSISTENT' for e in ends):
                return result | {'status': 'NO_PATH', 'reasons': ['NATIVE_GRAPH_NO_PATH_WITH_SOURCE_CANDIDATES']}
            return result | {'reasons': ['NATIVE_NO_PATH_WITH_UNCONFIRMED_END']}
        try:
            if status != 200 or not isinstance(body, dict):
                raise ValueError('NATIVE_RESPONSE_NOT_SUCCESS')
            coordinates, summary, attribution = ors_line(body)
            if not all(self.bbox[0] <= p[0] <= self.bbox[2] and self.bbox[1] <= p[1] <= self.bbox[3]
                       for p in coordinates):
                raise ValueError('INVALID_COORDINATE_RANGE')
        except (KeyError, TypeError, IndexError, ValueError) as exc:
            return result | {'reasons': [str(exc) if isinstance(exc, ValueError) else 'MALFORMED_ORS_GEOJSON']}
        raw_points = [utm(p) for p in coordinates]
        raw_length = sum(distance(a, b) for a, b in zip(raw_points, raw_points[1:]))
        result.update(raw_distance_m=summary['distance'], raw_model_seconds=summary['duration'])
        chain = self.matcher.match(coordinates, attribution)
        pieces = chain['segments']
        result['checks']['source_chain'] = chain
        # A failed middle segment does not erase a separately proved unsafe
        # connector at either end. Ambiguous/unmapped ends remain unknown.
        first = [p for p in pieces if p['raw_segment_index'] == 0]
        last = [p for p in pieces if p['raw_segment_index'] == len(coordinates) - 2]
        actual = [first[0]['a'] if first else None, last[-1]['b'] if last else None]
        ends = [self.endpoint_v2(p, q) for p, q in zip(original, actual)]
        result['checks']['endpoints'] = ends
        result['source_endpoint_gaps_m'] = [distance(p, q) if q is not None else None for p, q in zip(original, actual)]
        access_issues = self.route_access(pieces)
        obstacle_issues = sorted({issue for piece in pieces for issue in self.source_conflicts(
            piece['a'], piece['b'], piece=piece)})
        source_length = sum(distance(p['a'], p['b']) for p in pieces)
        result.update(raw_geometry_distance_m=raw_length, reconstructed_distance_m=source_length)
        length_ok = abs(summary['distance'] - raw_length) <= max(5, .02 * raw_length)
        source_length_ok = chain['status'] == 'MATCHED' and abs(summary['distance'] - source_length) <= max(5, .02 * source_length)
        result['checks'].update(access=access_issues, obstacles=obstacle_issues,
                                lengths={'raw_geometry_consistent': length_ok,
                                         'source_geometry_consistent': source_length_ok})
        scope_ok = self.in_scope(raw_points) and all(self.in_scope([p['a'], p['b']]) for p in pieces)
        result['checks']['coverage'] = scope_ok
        if not scope_ok:
            return result | {'status': 'OUTSIDE_PILOT', 'reasons': ['LINE_OUTSIDE_CONFIRMED_SCOPE']}
        reasons = chain['reasons'] + access_issues + obstacle_issues
        if not length_ok or (chain['status'] == 'MATCHED' and not source_length_ok):
            reasons.append('LENGTH_MISMATCH')
        reasons += [label + ':' + reason for label, end in zip(('start', 'target'), ends) for reason in end['reasons']]
        for endpoint_status in ('NEEDS_REFINEMENT', 'AMBIGUOUS_SNAP'):
            if any(end['status'] == endpoint_status for end in ends):
                return result | {'status': endpoint_status, 'reasons': sorted(set(reasons))}
        if chain['status'] != 'MATCHED' or reasons or any(e['status'] != 'SOURCE_CANDIDATE_CONSISTENT' for e in ends):
            return result | {'reasons': sorted(set(reasons)) or ['SOURCE_MODEL_NOT_CONFIRMED']}
        return result | {'status': 'MODEL_GEOMETRY_CONSISTENT',
                         'model_consistent_distance_m': source_length,
                         'reasons': ['SOURCE_MODEL_ONLY; NO_FIELD_OR_TIME_VALIDATION']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True, help='Original immutable ORS run directory')
    parser.add_argument('--output', type=Path, required=True, help='New revision output, no existing results')
    parser.add_argument('--mode', choices=['walking', 'driving'], required=True)
    args = parser.parse_args()
    source, evidence, out = args.source.resolve(), args.evidence.resolve(), args.output.resolve()
    freeze = read(out / 'freeze.json')
    for relative, expected in freeze['inputs'].items():
        if digest(source / relative) != expected:
            raise ValueError('Frozen review input changed: ' + relative)
    policy_path = HERE / 'walking-policy.json'
    policy_relative = str(policy_path.relative_to(source))
    if digest(policy_path) != freeze['prior_experiment'][policy_relative]:
        raise ValueError('Frozen mode access policy changed')
    controls = read(source / 'experiments/local-routing-poc/controls.json')
    response_path = evidence / args.mode / 'responses.json'
    if digest(response_path) != freeze['inputs'][str(response_path.relative_to(source))]:
        raise ValueError('Raw response is not one of the frozen inputs')
    if digest(evidence / 'nodes.jsonl') != freeze['inputs'][str((evidence / 'nodes.jsonl').relative_to(source))]:
        raise ValueError('Node extract is not the frozen review input')
    rows = read(response_path)['rows']
    cases = {case['id']: {'start': case['start']['coordinate'], 'target': case['target']['coordinate']}
             for case in controls['cases']}
    if len(rows) != len(cases) or {r['id'] for r in rows} != cases.keys():
        raise ValueError('Expected every frozen case exactly once')
    folder = out / args.mode
    folder.mkdir(exist_ok=False)
    reviewer = RevisionReviewer(source, evidence, args.mode)
    results = [reviewer.row_v2(row, cases[row['id']]) for row in rows]
    result = {'checker_version': 2, 'mode': args.mode, 'rows': results,
              'controls_sha256': digest(source / 'experiments/local-routing-poc/controls.json'),
              'raw_response_sha256': digest(evidence / args.mode / 'responses.json'),
              'policy_sha256': digest(policy_path),
              'checker_sources': {p.name: digest(p) for p in HERE.glob('*.py')},
              'policy': {'endpoint_precision_m': .25, 'shape_representation_m': 1.25,
                         'snap_limit_m': reviewer.policy['snap_limit_m'], 'junction_band_m': 1},
              'product_integration': 'NOT_PERFORMED', 'observed_at': None, 'freshness': 'UNKNOWN',
              'limitations': ['Retained OSM snapshot/obstacles only; no field access or time validation.',
                              'Car turn restriction relations not independently validated.',
                              'Mode-specific access policy unchanged from previous experiment.']}
    write(folder / 'review.json', result)
    with (folder / 'review.csv').open('x') as stream:
        writer = csv.writer(stream)
        writer.writerow(['mode', 'id', 'status', 'raw_distance_m', 'model_consistent_distance_m', 'reasons'])
        for row in results:
            writer.writerow([row[k] for k in ['mode', 'id', 'status', 'raw_distance_m', 'model_consistent_distance_m']] + [';'.join(row['reasons'])])
    print(json.dumps({'mode': args.mode, 'statuses': {r['id']: r['status'] for r in results}}, indent=2))


if __name__ == '__main__':
    main()
