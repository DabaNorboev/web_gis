"""Attribute an ORS line to original OSM source chains, without access inference.

``SourceChainMatcher(ways).match(lonlat, per_segment_way_ids)`` accepts singleton
sets (the ors_line contract) or integer way IDs. MATCHED means exactly one
continuous source interpretation. Coordinates in returned ``segments`` are UTM
46N metres and retain every traversed original edge, including simplified-away
nodes. ``t0``/``t1`` are fractions along that original edge. Node IDs are exposed
only at exact/canonical source endpoints; endpoint canonicalization is recorded.

The 0.25 m endpoint tolerance is independent of the 1.25 m representation
allowance (pinned 1 m import simplification plus coordinate precision). Neither
allowance grants access, changes snapping, nor replaces obstacle checks against
the returned original pieces. Ambiguity and broken node identity fail closed.
"""
import math

from historical_geometry import distance, project, utm


FRACTION_EPSILON = 1e-7


def _point(a, b, fraction):
    return (a[0] + fraction * (b[0] - a[0]),
            a[1] + fraction * (b[1] - a[1]))


def _fraction(p, a, b):
    length2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
    if length2 == 0:
        return 0.0
    return max(0.0, min(1.0, ((p[0] - a[0]) * (b[0] - a[0]) +
                            (p[1] - a[1]) * (b[1] - a[1])) / length2))


class SourceChainMatcher:
    def __init__(self, ways, endpoint_tolerance_m=.25, representation_tolerance_m=1.25):
        if not (0 <= endpoint_tolerance_m <= .25 and
                0 <= representation_tolerance_m <= 1.25):
            raise ValueError('Source matching tolerances exceed the pinned contract')
        self.endpoint_tolerance_m = endpoint_tolerance_m
        self.representation_tolerance_m = representation_tolerance_m
        self.ways = {}
        node_points = {}
        for original in ways:
            way = dict(original)
            if way['id'] in self.ways:
                raise ValueError('Duplicate source way ID')
            if len(way['nodes']) != len(way['coordinates']) or len(way['nodes']) < 2:
                raise ValueError('Invalid source way geometry')
            way['points'] = [utm(p) for p in way['coordinates']]
            if any(not all(math.isfinite(x) for x in p) for p in way['points']):
                raise ValueError('Invalid source coordinate')
            for node, point in zip(way['nodes'], way['points']):
                if node in node_points and distance(node_points[node], point) > 1e-7:
                    raise ValueError('Conflicting source geometry for the same OSM node ID')
                node_points[node] = point
            way['tags'] = dict(way.get('tags', {}))
            self.ways[way['id']] = way

    def _positions(self, raw, way):
        """All source positions inside endpoint precision, deduplicated by index."""
        positions = {}
        for edge, (a, b) in enumerate(zip(way['points'], way['points'][1:])):
            error, projected = project(raw, a, b)
            if error > self.endpoint_tolerance_m + 1e-9:
                continue
            fraction = _fraction(projected, a, b)
            # Canonicalize only to an original node that is itself within the
            # endpoint allowance. Never use the representation allowance here.
            nodes = [(edge, a), (edge + 1, b)]
            close = [(index, p) for index, p in nodes
                     if distance(raw, p) <= self.endpoint_tolerance_m + 1e-9]
            if close:
                for index, p in close:
                    positions[float(index)] = {
                        'position': float(index), 'point': p,
                        'node': way['nodes'][index],
                        'canonicalized': distance(raw, p) > 1e-9,
                        'endpoint_error_m': distance(raw, p),
                    }
            else:
                station = edge + fraction
                node = None
                if fraction <= FRACTION_EPSILON:
                    station, node = float(edge), way['nodes'][edge]
                elif 1 - fraction <= FRACTION_EPSILON:
                    station, node = float(edge + 1), way['nodes'][edge + 1]
                positions[station] = {
                    'position': station, 'point': projected, 'node': node,
                    'canonicalized': False, 'endpoint_error_m': error,
                }
        return list(positions.values())

    def _pieces(self, way, start, end, raw_index, a, b):
        s, e = start['position'], end['position']
        if abs(s - e) <= FRACTION_EPSILON:
            return None
        forward = e > s
        lo, hi = sorted((s, e))
        pieces = []
        for index in range(math.floor(lo), min(math.ceil(hi), len(way['nodes']) - 1)):
            t0, t1 = max(0.0, lo - index), min(1.0, hi - index)
            if t1 - t0 <= FRACTION_EPSILON:
                continue
            if not forward:
                t0, t1 = t1, t0
            p, q = way['points'][index:index + 2]
            pieces.append({
                'way': way['id'], 'edge_index': index,
                'u': way['nodes'][index], 'v': way['nodes'][index + 1],
                'a': _point(p, q, t0), 'b': _point(p, q, t1),
                't0': t0, 't1': t1, 'tags': way['tags'], 'forward': forward,
                'start_node': way['nodes'][index] if t0 <= FRACTION_EPSILON else (
                    way['nodes'][index + 1] if 1 - t0 <= FRACTION_EPSILON else None),
                'end_node': way['nodes'][index] if t1 <= FRACTION_EPSILON else (
                    way['nodes'][index + 1] if 1 - t1 <= FRACTION_EPSILON else None),
                'raw_segment_index': raw_index,
            })
        if not forward:
            pieces.reverse()
        if not pieces:
            return None
        maximum = max(project(p, a, b)[0]
                      for piece in pieces for p in (piece['a'], piece['b']))
        if maximum > self.representation_tolerance_m + 1e-9:
            return None
        for piece in pieces:
            piece['max_deviation_m'] = maximum
        return {'pieces': pieces, 'start': start, 'end': end,
                'max_deviation_m': maximum, 'way': way['id']}

    def _chains(self, way, start, end, index, a, b):
        direct = self._pieces(way, start, end, index, a, b)
        result = [direct] if direct is not None else []
        # A closed OSM way has two possible source arcs. Test both; never pick
        # an arbitrary direction around a loop from proximity alone.
        if way['nodes'][0] != way['nodes'][-1]:
            return result
        s, e = start['position'], end['position']
        if abs(s - e) <= FRACTION_EPSILON:
            return result
        last = float(len(way['nodes']) - 1)
        first_end = last if s > e else 0.0
        second_start = 0.0 if s > e else last
        endpoint = lambda pos: {'position': pos, 'point': way['points'][int(pos)],
                                'node': way['nodes'][int(pos)], 'canonicalized': False,
                                'endpoint_error_m': 0.0}
        portions = []
        for left, right in ((start, endpoint(first_end)), (endpoint(second_start), end)):
            if abs(left['position'] - right['position']) <= FRACTION_EPSILON:
                continue
            portion = self._pieces(way, left, right, index, a, b)
            if portion is None:
                return result
            portions.append(portion)
        pieces = [piece for portion in portions for piece in portion['pieces']]
        if pieces:
            maximum = max(portion['max_deviation_m'] for portion in portions)
            for piece in pieces:
                piece['max_deviation_m'] = maximum
            result.append({'pieces': pieces, 'start': start, 'end': end,
                           'max_deviation_m': maximum, 'way': way['id']})
        return result

    @staticmethod
    def _continuous(left, right):
        end, start = left['end'], right['start']
        if end['node'] is not None and start['node'] is not None:
            return end['node'] == start['node']
        return (left['way'] == right['way'] and
                abs(end['position'] - start['position']) <= FRACTION_EPSILON)

    def match(self, coordinates, attribution):
        if len(coordinates) < 2 or len(attribution) != len(coordinates) - 1:
            raise ValueError('Expected one declared way per shape segment')
        points = [utm(p) for p in coordinates]
        candidates, diagnostics, reasons = [], [], []
        for index, (a, b, declared) in enumerate(zip(points, points[1:], attribution)):
            ids = {declared} if isinstance(declared, int) and not isinstance(declared, bool) else set(declared)
            issue = None
            matches = []
            if len(ids) != 1:
                issue = 'INCOMPLETE_OR_AMBIGUOUS_OSMID'
            elif next(iter(ids)) not in self.ways:
                issue = 'DECLARED_OSM_WAY_NOT_IN_SOURCE'
            elif distance(a, b) < 1e-7:
                issue = 'ZERO_LENGTH_SHAPE_SEGMENT'
            else:
                way = self.ways[next(iter(ids))]
                starts, ends = self._positions(a, way), self._positions(b, way)
                if not starts or not ends:
                    issue = 'SOURCE_CHAIN_ENDPOINT_MISMATCH'
                else:
                    for start in starts:
                        for end in ends:
                            matches.extend(self._chains(way, start, end, index, a, b))
                    unique = {}
                    for chain in matches:
                        key = tuple((p['edge_index'], round(p['t0'], 10), round(p['t1'], 10))
                                    for p in chain['pieces'])
                        unique.setdefault(key, chain)
                    matches = list(unique.values())
                    if not matches:
                        issue = 'SOURCE_CHAIN_REPRESENTATION_MISMATCH'
            candidates.append(matches)
            diagnostics.append({'raw_segment_index': index, 'candidate_count': len(matches),
                                'reason': issue})
            if issue:
                reasons.append(issue)

        # Count complete interpretations up to two, retaining predecessor links
        # only for uniqueness. Shared coordinates alone never connect ways.
        counts, predecessors = [], []
        for index, matches in enumerate(candidates):
            row, links = [], []
            for chain in matches:
                previous = [j for j, left in enumerate(candidates[index - 1])
                            if counts[index - 1][j] and self._continuous(left, chain)] if index else []
                row.append(min(2, sum(counts[index - 1][j] for j in previous)) if index else 1)
                links.append(previous)
            counts.append(row)
            predecessors.append(links)
        total = min(2, sum(counts[-1]))
        selected = {}
        if total:
            # Recover all reachable alternatives, so diagnostic geometry includes
            # only pieces whose interpretation is common to every valid path.
            reachable = {j for j, count in enumerate(counts[-1]) if count}
            for index in range(len(candidates) - 1, -1, -1):
                if len(reachable) == 1:
                    selected[index] = candidates[index][next(iter(reachable))]
                reachable = {previous for j in reachable for previous in predecessors[index][j]}
        else:
            selected = {i: matches[0] for i, matches in enumerate(candidates) if len(matches) == 1}
            for left, right in zip(candidates, candidates[1:]):
                if left and right and not any(self._continuous(a, b) for a in left for b in right):
                    reasons.append('SOURCE_NODE_CONTINUITY_MISMATCH')
            if not reasons:
                reasons.append('SOURCE_NODE_CONTINUITY_MISMATCH')
        if total > 1:
            reasons.append('AMBIGUOUS_SOURCE_CHAIN')
        segments = [piece for index in sorted(selected) for piece in selected[index]['pieces']]
        endpoints = [{'raw_segment_index': index,
                      'start': chain['start'], 'end': chain['end']}
                     for index, chain in sorted(selected.items())]
        return {'status': 'MATCHED' if total == 1 else ('AMBIGUOUS' if total > 1 else 'UNMATCHED'),
                'reasons': sorted(set(reasons)), 'segments': segments,
                'shape_segments': diagnostics, 'endpoint_matches': endpoints,
                'max_deviation_m': max((piece['max_deviation_m'] for piece in segments), default=None)}
