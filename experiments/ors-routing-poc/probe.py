"""Public frozen controls only; run in the isolated ORS network namespace."""
import argparse
import json
import math
from pathlib import Path
import statistics
import time
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:8082/ors/v2'


def request(path, body=None, timeout=3):
    started = time.monotonic()
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read(4_000_001)
            if len(raw) > 4_000_000:
                raise ValueError('Response too large')
            result = {'http_status': response.status, 'body': json.loads(raw)}
    except urllib.error.HTTPError as error:
        result = {'http_status': error.code, 'body': json.loads(error.read(100_000))}
    except (OSError, ValueError) as error:
        result = {'http_status': None, 'error_class': type(error).__name__}
    return result | {'milliseconds': (time.monotonic() - started) * 1000}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['walking', 'driving'])
    args = parser.parse_args()
    profile = {'walking': 'foot-walking', 'driving': 'driving-car'}[args.mode]
    radius = 20 if args.mode == 'walking' else 35
    controls = json.loads(Path('/controls.json').read_text())
    rows, snaps = [], []
    extras = ['osmid', 'waytype'] + (['roadaccessrestrictions'] if args.mode == 'driving' else [])

    def route(a, b):
        return request('/directions/' + profile + '/geojson', {
            'coordinates': [a, b], 'radiuses': [radius, radius],
            'geometry_simplify': False, 'instructions': False, 'extra_info': extras})

    for case in controls['cases']:
        if case['kind'] == 'outside':
            rows.append({'id': case['id'], 'diagnostic': False, 'status': 'OUTSIDE_PILOT',
                         'http_status': None, 'body': None, 'request_sent': False})
            continue
        a, b = case['start']['coordinate'], case['target']['coordinate']
        rows.append({'id': case['id'], 'diagnostic': False, 'request_sent': True} | route(a, b))
        snaps.append({'id': case['id']} | request('/snap/' + profile + '/json',
                                                {'locations': [a, b], 'radius': radius}))
    by_id = {c['id']: c for c in controls['cases']}
    starts = [by_id[k]['start']['coordinate'] for k in controls['matrix']['sources']]
    ends = [by_id[k]['target']['coordinate'] for k in controls['matrix']['targets']]
    matrix = request('/matrix/' + profile, {'locations': starts + ends, 'sources': [0, 1, 2],
                    'destinations': [3, 4, 5], 'metrics': ['distance', 'duration']})
    matrix_pairs = [{'source': i, 'target': j} | route(a, b)
                    for i, a in enumerate(starts) for j, b in enumerate(ends)]
    # Separate native isochrone capability probe; polygons are never accepted as verified access.
    isochrone = request('/isochrones/' + profile, {'locations': [starts[0]],
                        'range': [600], 'range_type': 'time'}, timeout=10)
    for _ in range(3):
        route(starts[0], ends[0])
    warm = [route(starts[0], ends[0]) for _ in range(20)]
    times = sorted(r['milliseconds'] for r in warm)
    print(json.dumps({'mode': args.mode, 'profile': profile, 'snap_radius_m': radius,
                      'rows': rows, 'snaps': snaps, 'matrix': matrix, 'matrix_pairs': matrix_pairs,
                      'isochrone_capability_only': isochrone, 'warm_routes': warm,
                      'latency': {'n': len(times), 'median_ms': statistics.median(times),
                                  'p95_ms': times[math.ceil(.95 * len(times)) - 1]},
                      'user_eta': None, 'field_access_verified': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
