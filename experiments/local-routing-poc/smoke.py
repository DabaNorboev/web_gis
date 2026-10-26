"""Read existing public local app routes; never migrate or import."""
import json
import pathlib
import urllib.parse
import urllib.request

result = {}
for url in ['/', '/up', '/compare?left=osm:way:71888335&right=osm:way:177078022&radius_m=500',
            '/address/osm:way:71888335']:
    with urllib.request.urlopen('http://127.0.0.1' + url, timeout=10) as response:
        assert response.status == 200
        result[url] = response.status
for radius in [300, 500]:
    url = f'/api/v1/transport/analysis?lon=92.87&lat=56.01&radius_m={radius}'
    with urllib.request.urlopen('http://127.0.0.1' + url, timeout=10) as response:
        data = json.load(response)
    distances = [s['distance_m'] for s in data['stops_in_radius']]
    assert distances == sorted(distances) and all(x <= radius for x in distances)
    assert data['point'] == {'lon': 92.87, 'lat': 56.01}
    result[url] = {'count': len(distances), 'sorted': True, 'original_point_preserved': True}
url = '/api/v1/addresses/search?' + urllib.parse.urlencode({'q': 'Красноярск Ленина 102'})
with urllib.request.urlopen('http://127.0.0.1' + url, timeout=10) as response:
    data = json.load(response)
assert data['data']
result['address_search'] = {'groups_found': len(data['data'])}
out = pathlib.Path(__file__).resolve().parents[2] / 'data/reports/local-routing-2026-10-21/app-smoke.json'
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
