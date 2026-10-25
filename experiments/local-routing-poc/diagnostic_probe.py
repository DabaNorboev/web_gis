"""Additional frozen graph-disconnection controls, not scored primary cases."""
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

engine, mode = sys.argv[1:]
d = json.loads(pathlib.Path('/experiment/diagnostic-controls.json').read_text())
island = d['isolated_stairs' if mode == 'walking' else 'isolated_service']
ordinary = d['ordinary']


def call(action, sources, targets=None):
    if engine == 'osrm':
        points = sources if action == 'route' else sources + targets
        params = {'radiuses': ';'.join('1' for _ in points)}
        if action == 'route':
            params.update(overview='full', geometries='geojson')
        else:
            params.update(sources='0;1', destinations='2;3', annotations='distance,duration')
        url = 'http://127.0.0.1:5000/' + ('route' if action == 'route' else 'table') + '/v1/' + mode + '/' + ';'.join(','.join(map(str, p)) for p in points) + '?' + urllib.parse.urlencode(params)
        request = urllib.request.Request(url)
    else:
        def loc(p):
            return {'lon': p[0], 'lat': p[1], 'radius': 1, 'search_cutoff': 1}
        payload = {'costing': 'pedestrian' if mode == 'walking' else 'auto', 'units': 'kilometers'}
        payload.update({'locations': list(map(loc, sources))} if action == 'route' else {'sources': list(map(loc, sources)), 'targets': list(map(loc, targets))})
        request = urllib.request.Request('http://127.0.0.1:8002/' + ('route' if action == 'route' else 'sources_to_targets'), json.dumps(payload).encode(), {'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return {'status': response.status, 'body': json.load(response)}
    except urllib.error.HTTPError as error:
        return {'status': error.code, 'body': json.loads(error.read())}
    except OSError as error:
        return {'status': None, 'error': str(error)}


results = {'within_island': call('route', [island['start'], island['target']]),
           'between_components': call('route', [ordinary['start'], island['target']]),
           'mixed_matrix': call('matrix', [ordinary['start'], island['start']], [ordinary['target'], island['target']]),
           'pairs': [dict(source=i, target=j, result=call('route', [a, b]))
                     for i, a in enumerate([ordinary['start'], island['start']])
                     for j, b in enumerate([ordinary['target'], island['target']])]}
print(json.dumps(results))
