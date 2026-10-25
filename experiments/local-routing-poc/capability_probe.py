"""One isochrone capability request per Valhalla mode; no product acceptance."""
import json
import sys
import urllib.error
import urllib.request

mode = sys.argv[2]
payload = {'locations': [{'lon': 92.8580863, 'lat': 56.0139165}],
           'costing': 'pedestrian' if mode == 'walking' else 'auto',
           'contours': [{'time': 5}], 'polygons': True, 'denoise': 0, 'generalize': 0}
request = urllib.request.Request('http://127.0.0.1:8002/isochrone', json.dumps(payload).encode(), {'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(request, timeout=3) as response:
        result = {'status': response.status, 'request': payload, 'body': json.load(response)}
except urllib.error.HTTPError as error:
    result = {'status': error.code, 'body': json.loads(error.read())}
except OSError as error:
    result = {'status': None, 'error': str(error)}
print(json.dumps({'isochrone': result}))
