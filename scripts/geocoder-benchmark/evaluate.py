"""Conservative textual checks against pre-frozen independent references.

Not a spatial accuracy estimator. Unknowns and low-confidence references stay visible.
"""
import re
import unicodedata


def normalized(value):
    text = unicodedata.normalize('NFC', str(value or '')).casefold().replace('ё', 'е')
    text = re.sub(r'\b(улица|ул|проспект|просп|пр-кт|пр-т|переулок|пер)\b\.?', '', text)
    return re.sub(r'\s+', ' ', text).strip(' ,.')


def number(value):
    return re.sub(r'\s+', '', normalized(value)).replace('корпус', 'к').replace('строение', 'с')


def evaluate(provider, rows, case):
    ref = case['reference']
    parts = ref['expected_address'].split(',')
    street = normalized(parts[0])
    wanted = number(','.join(parts[1:]).replace('участок', '').replace(',', ''))
    # SNT/parcel semantics require a separate independent identity review.
    unsupported = case['group'] in ('snt', 'private')
    found = []
    levels = []
    coordinates = []
    outside = 0
    for index, row in enumerate(rows):
        if provider == 'geoapify':
            road, house = row.get('street'), row.get('housenumber')
            city = row.get('city')
            level = row.get('result_type')
        else:
            address = row.get('address') or {}
            road, house = address.get('road'), address.get('house_number')
            city = address.get('city') or address.get('town') or address.get('village')
            level = row.get('type') or ('house_number_present' if house else 'unknown')
        city_known = normalized(city) in ('красноярск', 'krasnoyarsk', 'krasnojarsk')
        label = row.get('formatted', row.get('display_name', ''))
        if not city and re.search(r'(?:^|,\s*)Красноярск(?:,|$)', label, re.I):
            city_known = True
        levels.append(level)
        try:
            lon, lat = float(row['lon']), float(row['lat'])
            valid = -180 <= lon <= 180 and -90 <= lat <= 90
        except (KeyError, TypeError, ValueError):
            valid = False
        coordinates.append(valid)
        if city and not city_known:
            outside += 1
        if not unsupported and normalized(road) == street and number(house) == wanted and city_known:
            found.append(index + 1)
    return {'kind': 'text_evaluation', 'provider': provider, 'case': case['id'],
            'group': case['group'], 'reference_confidence': ref['confidence'],
            'text_match_rank': min(found) if found else None,
            'status': 'unreviewed_parcel_identity' if unsupported else 'text_match' if found else 'no_strict_text_match',
            'returned_count': len(rows), 'levels': levels, 'coordinate_present': coordinates,
            'explicit_other_city_count': outside, 'error_m': None,
            'error_reason': 'no_independent_geometry'}
