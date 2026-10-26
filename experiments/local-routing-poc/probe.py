"""HTTP probes executed inside a router's network namespace; never public API."""
import argparse
import json
import math
import pathlib
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request


def run(engine, mode):
    cases = json.loads(pathlib.Path('/experiment/controls.json').read_text())['cases']
    url = 'http://127.0.0.1:' + ('8002' if engine == 'valhalla' else '5000')

    def location(p):
        limit = 20 if mode == 'walking' else 35
        return {'lon': p[0], 'lat': p[1], 'radius': limit, 'search_cutoff': limit}

    def call(action, sources, targets=None):
        began = time.perf_counter()
        limit = 20 if mode == 'walking' else 35
        if engine == 'valhalla':
            payload = {'costing': 'pedestrian' if mode == 'walking' else 'auto',
                       'units': 'kilometers', 'shape_format': 'geojson'}
            if mode == 'walking':
                payload['costing_options'] = {'pedestrian': {'walking_speed': 4.5, 'ignore_access': False, 'ignore_restrictions': False}}
            payload.update({'locations': [location(p) for p in sources]} if action == 'route' else
                           {'sources': [location(p) for p in sources], 'targets': [location(p) for p in targets]})
            endpoint = '/route' if action == 'route' else '/sources_to_targets'
            request = urllib.request.Request(url + endpoint, json.dumps(payload).encode(), {'Content-Type': 'application/json'})
            request_description = {'endpoint': endpoint, 'json': payload}
        else:
            points = sources if action == 'route' else sources + targets
            coords = ';'.join(','.join(map(str, p)) for p in points)
            params = {'radiuses': ';'.join(str(limit) for _ in points)}
            if action == 'route':
                params.update({'overview': 'full', 'geometries': 'geojson', 'steps': 'true', 'annotations': 'nodes'})
            else:
                params.update({'sources': ';'.join(map(str, range(len(sources)))),
                               'destinations': ';'.join(map(str, range(len(sources), len(points)))),
                               'annotations': 'distance,duration'})
            endpoint = ('/route' if action == 'route' else '/table') + '/v1/' + mode + '/' + coords + '?' + urllib.parse.urlencode(params)
            request = urllib.request.Request(url + endpoint)
            request_description = {'endpoint': endpoint}
        body, status, error = None, None, None
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                status, body = response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            status = exc.code
            try:
                body = json.loads(exc.read())
            except ValueError:
                error = str(exc)
        except (OSError, ValueError) as exc:
            error = str(exc)
        return {'request': request_description, 'status': status, 'body': body, 'error': error,
                'milliseconds': (time.perf_counter() - began) * 1000}

    # Readiness is diagnostic only and not used in route benchmarks.
    ready = False
    for _ in range(80):
        try:
            with urllib.request.urlopen(url + ('/status' if engine == 'valhalla' else '/nearest/v1/driving/92.86,56.01'), timeout=.5) as response:
                if response.status == 200:
                    ready = True
                    break
        except OSError:
            time.sleep(.1)
    if not ready:
        raise RuntimeError('Router failed to become ready')
    results = {}
    for case in cases:
        if case['kind'] == 'outside':
            results[case['id']] = {'status': 'OUTSIDE_PILOT', 'body': None, 'milliseconds': None, 'request': None}
        else:
            results[case['id']] = call('route', [case['start']['coordinate'], case['target']['coordinate']])
    by_id = {c['id']: c for c in cases}
    starts = [by_id[k]['start']['coordinate'] for k in ['centre', 'solnechny', 'hotel']]
    targets = [by_id[k]['target']['coordinate'] for k in ['centre', 'right_bank', 'stadium']]
    matrix = call('matrix', starts, targets)
    # Low-level robustness probe intentionally bypasses the product territory gate.
    partial = call('matrix', starts, targets + [[91.0, 56.0]])
    matrix_pairs = [dict(source=i, target=j, response=call('route', [a, b]))
                    for i, a in enumerate(starts) for j, b in enumerate(targets)]

    def benchmark(action, sources, dest=None):
        for _ in range(3):
            call(action, sources, dest)
        observations = [call(action, sources, dest) for _ in range(20)]
        values = sorted(r['milliseconds'] for r in observations)
        return {'n': 20, 'median_ms': statistics.median(values), 'p95_ms': values[math.ceil(.95 * len(values)) - 1],
                'statuses': [r['status'] for r in observations], 'errors': [r['error'] for r in observations]}

    output = {'engine': engine, 'mode': mode, 'routes': results, 'matrix': matrix,
              'partial_matrix_raw': partial, 'matrix_pairs': matrix_pairs,
              'route_warm': benchmark('route', [cases[0]['start']['coordinate'], cases[0]['target']['coordinate']]),
              'matrix_warm': benchmark('matrix', starts, targets), 'cold_note': 'First route after readiness retained in routes; OS filesystem cache not flushed.'}
    print(json.dumps(output, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('engine', choices=['osrm', 'valhalla'])
    parser.add_argument('mode', choices=['walking', 'driving'])
    args = parser.parse_args()
    run(args.engine, args.mode)
