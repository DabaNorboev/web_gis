"""Normalize raw shapes and prepare bounded read-only PostGIS geometry reviews."""
import hashlib
import json
import math
import pathlib

from run import ROOT, OUT


def decode_polyline6(encoded):
    current, points, index = [0, 0], [], 0
    while index < len(encoded):
        for axis in range(2):
            value, shift = 0, 0
            while True:
                if index >= len(encoded):
                    raise ValueError('Truncated polyline6')
                byte = ord(encoded[index]) - 63
                index += 1
                value |= (byte & 31) << shift
                shift += 5
                if byte < 32:
                    break
            current[axis] += ~(value >> 1) if value & 1 else value >> 1
        points.append([current[1] / 1000000, current[0] / 1000000])
    return points


def distance(a, b):
    lat1, lat2 = map(math.radians, [a[1], b[1]])
    dlat, dlon = lat2 - lat1, math.radians(b[0] - a[0])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 12742017.6 * math.asin(min(1, math.sqrt(h)))


def normalize(engine, response, a, b, mode):
    result = {'status': 'UNKNOWN', 'value_distance_m': None, 'value_seconds': None, 'line': None,
              'start': a, 'target': b, 'gap_start_m': None, 'gap_target_m': None}
    if response['status'] == 'OUTSIDE_PILOT':
        return {**result, 'status': 'OUTSIDE_PILOT', 'reason': 'Outside declared pilot'}
    body = response.get('body') or {}
    if engine == 'osrm':
        if body.get('code') != 'Ok' or not body.get('routes'):
            return {**result, 'status': {'NoRoute': 'NO_PATH', 'NoSegment': 'NEEDS_REFINEMENT'}.get(body.get('code'), 'UNKNOWN'), 'reason': body.get('message', response.get('error'))}
        route = body['routes'][0]
        line, length, seconds = route['geometry'], route['distance'], route['duration']
    else:
        trip = body.get('trip', {})
        if not trip.get('legs') or trip.get('status') != 0:
            return {**result, 'status': 'NO_PATH' if body.get('error_code') == 442 else 'NEEDS_REFINEMENT' if body.get('error_code') in [170, 171] else 'UNKNOWN', 'reason': body.get('error', response.get('error'))}
        points = []
        for leg in trip['legs']:
            shape = leg['shape']
            if isinstance(shape, str):
                try:
                    coordinates = decode_polyline6(shape)
                except ValueError:
                    return {**result, 'reason': 'Malformed polyline6 shape'}
            elif isinstance(shape, dict) and shape.get('type') == 'LineString':
                coordinates = shape['coordinates']
            else:
                return {**result, 'reason': 'Unsupported shape encoding'}
            points.extend(coordinates if not points else coordinates[1:])
        line = {'type': 'LineString', 'coordinates': points}
        length, seconds = trip['summary']['length'] * 1000, trip['summary']['time']
    coords = line['coordinates']
    if len(coords) < 2 or not all(math.isfinite(v) for p in coords for v in p) or not math.isfinite(length) or not math.isfinite(seconds):
        return {**result, 'reason': 'Malformed route'}
    gaps = [distance(a, coords[0]), distance(b, coords[-1])]
    return {**result, 'status': 'REVIEW_REQUIRED' if max(gaps) <= (20 if mode == 'walking' else 35) else 'NEEDS_REFINEMENT',
            'line': line, 'gap_start_m': gaps[0], 'gap_target_m': gaps[1],
            'raw_distance_m': length, 'raw_seconds': seconds,
            'straight_distance_m': distance(a, b), 'milliseconds': response.get('milliseconds')}


def main():
    controls = json.loads((ROOT / 'experiments/local-routing-poc/controls.json').read_text())['cases']
    context = json.loads((OUT / 'prepared/context.json').read_text())
    ways = []
    for way in context['ways']:
        if not ('highway' in way['tags'] or 'barrier' in way['tags'] or 'railway' in way['tags']):
            continue
        xy = way['coordinates']
        ways.append((min(p[0] for p in xy), min(p[1] for p in xy), max(p[0] for p in xy), max(p[1] for p in xy),
                     {'id': way['id'], 'tags': way['tags'], 'geometry': {'type': 'LineString', 'coordinates': xy}}))
    results = []
    for engine in ['osrm', 'valhalla']:
        for mode in ['walking', 'driving']:
            data = json.loads((OUT / f'{engine}-{mode}-responses.json').read_text())
            for case in controls:
                result = normalize(engine, data['routes'][case['id']], case['start']['coordinate'], case['target']['coordinate'], mode)
                result.update({'engine': engine, 'mode': mode, 'id': case['id'], 'kind': case['kind']})
                results.append(result)
            for pair in data['matrix_pairs']:
                source = next(c for c in controls if c['id'] == ['centre', 'solnechny', 'hotel'][pair['source']])
                target = next(c for c in controls if c['id'] == ['centre', 'right_bank', 'stadium'][pair['target']])
                result = normalize(engine, pair['response'], source['start']['coordinate'], target['target']['coordinate'], mode)
                result.update({'engine': engine, 'mode': mode, 'id': f"matrix-{pair['source']}-{pair['target']}", 'kind': 'matrix'})
                results.append(result)
    for result in results:
        if not result['line']:
            continue
        xy = result['line']['coordinates'] + [result['start'], result['target']]
        bbox = [min(p[0] for p in xy) - .001, min(p[1] for p in xy) - .001, max(p[0] for p in xy) + .001, max(p[1] for p in xy) + .001]
        result['source_lines'] = [w[4] for w in ways if not (w[2] < bbox[0] or w[0] > bbox[2] or w[3] < bbox[1] or w[1] > bbox[3])]
        result['barrier_nodes'] = [n for n in context['barrier_nodes'] if bbox[0] <= n['coordinate'][0] <= bbox[2] and bbox[1] <= n['coordinate'][1] <= bbox[3]]
    with (OUT / 'review-input.jsonl').open('w') as stream:
        for result in results:
            stream.write(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    print('Normalized', len(results), 'route and matrix geometries; values remain null pending review')


if __name__ == '__main__':
    main()
