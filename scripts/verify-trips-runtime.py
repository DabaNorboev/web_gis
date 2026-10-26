"""Bounded localhost acceptance checks. Public control coordinates only."""
import argparse
import json
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data/reports/local-routing-integration-2026-10-21'
START = {'lon': 92.8580863, 'lat': 56.0139165}
TARGET = {'lon': 92.8712982, 'lat': 56.0120993, 'label': 'Контроль 1'}


def request(name, data, expected_http=200):
    began = time.monotonic()
    req = urllib.request.Request('http://127.0.0.1/api/v1/trips/analyze', json.dumps(data).encode(),
                                 {'Accept': 'application/json', 'Content-Type': 'application/json'})
    try:
        response = urllib.request.urlopen(req, timeout=12)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        body = json.load(response)
        status, headers = response.status, dict(response.headers)
    record = {'request': data, 'response': body, 'http_status': status, 'headers': headers,
              'milliseconds': (time.monotonic() - began) * 1000}
    (OUT / ('http-' + name + '.json')).write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    assert status == expected_http, (name, status)
    if status == 200:
        assert 'no-store' in headers.get('Cache-Control', '')
        assert body['start'] == data['start']
        for row, place in zip(body['results'], data['places'], strict=True):
            assert row['start'] == data['start']
            assert row['target'] == {'lon': place['lon'], 'lat': place['lat']}
            if row['status'] != 'AVAILABLE':
                assert row['route'] is None
                assert row['metrics']['distance']['value'] is None and row['metrics']['duration']['value'] is None
                assert row['metrics']['distance']['quality']['method'] is None
    print(name, status, [r['status'] for r in body.get('results', [])], flush=True)
    return body


def smoke():
    results = {}
    for radius, expected in [(300, 5), (500, 8)]:
        with urllib.request.urlopen(f'http://127.0.0.1/api/v1/transport/analysis?lon=92.87&lat=56.01&radius_m={radius}', timeout=10) as response:
            data = json.load(response)
        distances = [r['distance_m'] for r in data['stops_in_radius']]
        assert data['point'] == {'lon': 92.87, 'lat': 56.01}
        assert len(distances) == expected and distances == sorted(distances) and all(d <= radius for d in distances)
        results[str(radius)] = {'count': len(distances), 'point_retained': True, 'sorted': True}
    for path in ['/', '/up', '/compare?left=osm:way:71888335&right=osm:way:177078022&radius_m=500', '/address/osm:way:71888335', '/trips']:
        with urllib.request.urlopen('http://127.0.0.1' + path, timeout=10) as response:
            assert response.status == 200
        results[path] = 200
    with urllib.request.urlopen('http://127.0.0.1/api/v1/addresses/search?' + urllib.parse.urlencode({'q': 'Красноярск Ленина 102'}), timeout=10) as response:
        data = json.load(response)
        assert data['data']
    results['search_groups'] = len(data['data'])
    return results


def main(unavailable=False):
    if unavailable:
        data = {'mode': 'driving', 'start': START, 'places': [TARGET, {'lon': 92.860414, 'lat': 56.015472, 'label': 'Контроль 2'}]}
        result = request('container-unavailable', data)
        assert [r['status'] for r in result['results']] == ['UNAVAILABLE', 'UNAVAILABLE']
        (OUT / 'legacy-while-router-down.json').write_text(json.dumps(smoke(), ensure_ascii=False, indent=2) + '\n')
        return
    base = {'mode': 'driving', 'start': START, 'places': [TARGET]}
    normal = request('ordinary', base)
    assert normal['results'][0]['status'] == 'AVAILABLE'
    row = normal['results'][0]
    assert row['snaps']['start']['original'] == START and row['snaps']['target']['original'] == {'lon': TARGET['lon'], 'lat': TARGET['lat']}
    assert max(row['snaps']['start']['distance_m'], row['snaps']['target']['distance_m']) < .1
    assert normal['source']['dataset_version'] == 'osrm-car-20261021-v1' and normal['source']['observed_at'] is None
    cases = {c['id']: c for c in json.loads((ROOT / 'experiments/local-routing-poc/controls.json').read_text())['cases']}
    c = cases['stadium']
    dubious = request('wall-snap', {'mode': 'driving', 'start': dict(zip(['lon', 'lat'], c['start']['coordinate'])),
                                  'places': [{**dict(zip(['lon', 'lat'], c['target']['coordinate'])), 'label': 'Стадион'}]})
    assert dubious['results'][0]['status'] == 'NEEDS_REFINEMENT'
    assert 'SNAP_THROUGH_BARRIER' in dubious['results'][0]['checks']
    island = json.loads((OUT / 'no-path-candidates.json').read_text())[0]['coordinate']
    no_path_place = {'lon': island[0], 'lat': island[1], 'label': 'Изолированная дорога'}
    isolated = request('no-path', {**base, 'places': [no_path_place]})
    assert isolated['results'][0]['status'] == 'NO_PATH'
    mixed = request('partial-matrix', {**base, 'places': [TARGET, no_path_place, {'lon': 91, 'lat': 56, 'label': 'Вне пилота'}]})
    assert [r['status'] for r in mixed['results']] == ['AVAILABLE', 'NO_PATH', 'OUTSIDE_PILOT']
    edge = request('pilot-edge', {**base, 'places': [{'lon': 92.701, 'lat': 56.01}]})
    assert edge['results'][0]['status'] == 'OUTSIDE_PILOT'
    c = cases['railway']
    private = request('vehicle-private', {'mode': 'driving', 'start': dict(zip(['lon', 'lat'], c['start']['coordinate'])),
                                         'places': [dict(zip(['lon', 'lat'], c['target']['coordinate']))]})
    assert private['results'][0]['status'] == 'UNKNOWN' and 'ACCESS_REVIEW' in private['results'][0]['checks']
    request('unsupported-mode', {**base, 'mode': 'walking'}, 422)
    request('oversized-body', {'padding': 'x' * 9000}, 413)
    (OUT / 'legacy-after-integration.json').write_text(json.dumps(smoke(), ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--unavailable', action='store_true')
    main(parser.parse_args().unavailable)
