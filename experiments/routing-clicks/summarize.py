"""Summarize the frozen public sample; never estimates citywide or field accuracy."""
import collections
import hashlib
import json
import pathlib
import statistics
import sys

root = pathlib.Path(sys.argv[1])
before = json.loads((root / 'baseline.json').read_text())
after = json.loads((root / 'after-final.json').read_text())
assert before['sample_sha256'] == after['sample_sha256']
assert before['sample_sha256'] == hashlib.sha256(pathlib.Path('experiments/routing-clicks/controls.json').read_bytes()).hexdigest()
old = {r['id']: r for r in before['results']}
new = {r['id']: r for r in after['results']}
assert old.keys() == new.keys()


def summarize(rows):
    distances = [r['choice']['candidates'][0]['distance_m'] for r in rows if r['choice']['status'] == 'SELECTED']
    return {
        'point_count': len(rows),
        'choices': dict(collections.Counter(r['choice']['status'] for r in rows)),
        'directed_routes': dict(collections.Counter(r[end]['status'] for r in rows for end in ['start', 'target'])),
        'selected_displacement_m': {'minimum': min(distances), 'median': statistics.median(distances), 'maximum': max(distances)},
        'median_two_directions_and_resolution_ms': statistics.median(r['milliseconds'] for r in rows),
    }


changes = []
old_successes_preserved = 0
old_snaps_preserved = 0
for key in old:
    a, b = old[key], new[key]
    if a['choice']['status'] == 'SELECTED':
        assert a['choice']['point'] == b['choice']['point']
        old_snaps_preserved += 1
    for end in ['start', 'target']:
        x, y = a[end], b[end]
        if x['status'] == 'AVAILABLE':
            assert x['route'] == y['route']
            assert x['snaps'] == y['snaps']
            old_successes_preserved += 1
        elif y['status'] == 'AVAILABLE':
            changes.append({'id': key, 'direction': end, 'before': x['status'], 'after': y['status']})
        if y['status'] != 'AVAILABLE':
            assert y['route'] is None
            for m in ['distance', 'duration']:
                assert y['metrics'][m]['value'] is None
                assert y['metrics'][m]['quality']['method'] is None

audit = json.loads((root / 'admissions-audit.json').read_text())
assert {(x['id'], x['direction']) for x in changes} == {(x['id'], x['direction']) for x in audit}
historic_old = json.loads((root / 'historical-before.json').read_text())
historic_new = json.loads((root / 'historical-after.json').read_text())
assert {k: v['status'] for k, v in historic_old.items()} == {k: v['status'] for k, v in historic_new.items()}
assert historic_new['railway']['route'] is None and historic_new['stadium']['route'] is None
result = {
    'sample_sha256': before['sample_sha256'], 'before': summarize(before['results']), 'after': summarize(after['results']),
    'new_admissions': changes, 'new_admissions_audited': len(audit), 'old_successes_preserved': old_successes_preserved,
    'old_selected_snaps_preserved': old_snaps_preserved,
    'known_dangerous_public_controls': {'count': 2, 'erroneous_admissions_before': 0, 'erroneous_admissions_after': 0},
    'outside_pilot_control_preserved': historic_new['outside_pilot']['status'] == 'OUTSIDE_PILOT',
    'historical_statuses_unchanged': len(historic_new),
    'field_false_admission_rate': None,
    'limitation': 'No field validation of entrances or access. Targeted sample, not citywide coverage. CLI timings include diagnostic calls, not HTTP latency.'
}
unique_ids = []
seen = set()
for key, row in old.items():
    point = tuple(row['point'][k] for k in ['lon', 'lat'])
    if point not in seen:
        seen.add(point)
        unique_ids.append(key)
result['unique_coordinates'] = {
    'count': len(unique_ids),
    'before': summarize([old[k] for k in unique_ids]),
    'after': summarize([new[k] for k in unique_ids]),
    'duplicate': ['kapitanskaya_edge', 'kapitanskaya_corner'],
    'note': 'The frozen edge and corner coincide once; original case denominators are preserved.'
}
path = root / 'comparison-final.json'
with path.open('x') as handle:
    json.dump(result, handle, ensure_ascii=False, indent=2)
print(json.dumps(result, ensure_ascii=False, indent=2))
