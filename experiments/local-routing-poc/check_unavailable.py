"""Executed in a fresh network=none helper with no router process."""
import json
import urllib.error
import urllib.request

try:
    urllib.request.urlopen('http://127.0.0.1:5000/route/v1/driving/92.86,56.01;92.87,56.01', timeout=.5)
    raise RuntimeError('Unexpected router on isolated loopback')
except OSError as error:
    print(json.dumps({'status': None, 'body': None, 'error': str(error), 'expected_result': 'UNKNOWN', 'value_distance_m': None, 'value_seconds': None}))
