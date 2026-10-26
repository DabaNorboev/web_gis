"""Probe only the frozen public walking scenarios in an isolated ORS namespace."""
import argparse
import json
import math
from pathlib import Path
import re

from probe import request


def validate_scenarios(value):
    if not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1:
        raise ValueError('Expected walking scenario schema version 1')
    cases = value.get('cases')
    if not isinstance(cases, list) or not 1 <= len(cases) <= 5:
        raise ValueError('Expected one to five frozen public scenarios')
    ids = set()
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError('Invalid scenario record')
        identifier = case.get('id')
        if not isinstance(identifier, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', identifier) or identifier in ids:
            raise ValueError('Expected unique stable scenario IDs')
        ids.add(identifier)
        for variant in ('original', 'selected'):
            locations = case.get(variant)
            if not isinstance(locations, dict):
                raise ValueError('Missing original or selected endpoints')
            for end in ('start', 'target'):
                record = locations.get(end)
                coordinate = record.get('coordinate') if isinstance(record, dict) else None
                if not isinstance(coordinate, list) or len(coordinate) != 2 or not all(
                        isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)
                        for x in coordinate) or not (-180 <= coordinate[0] <= 180 and -90 <= coordinate[1] <= 90):
                    raise ValueError('Expected finite lon, lat coordinate pair')
    return cases


def probe_scenarios(value):
    rows = []
    for case in validate_scenarios(value):
        for variant in ('original', 'selected'):
            endpoints = case[variant]
            body = {'coordinates': [endpoints[end]['coordinate'] for end in ('start', 'target')],
                    'radiuses': [20, 20], 'geometry_simplify': False, 'instructions': False,
                    'extra_info': ['osmid', 'waytype']}
            result = request('/directions/foot-walking/geojson', body)
            rows.append({'id': case['id'] + '-' + variant, 'case_id': case['id'],
                         'variant': variant} | result)
    return {'mode': 'walking', 'profile': 'foot-walking', 'snap_radius_m': 20,
            'rows': rows, 'user_eta': None, 'field_access_verified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenarios', type=Path, default=Path('/scenarios.json'))
    args = parser.parse_args()
    print(json.dumps(probe_scenarios(json.loads(args.scenarios.read_text())),
                     ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
