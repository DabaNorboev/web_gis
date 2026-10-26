"""Summarize measured artifacts; do not promote unreviewed results to success."""
import collections
import csv
import datetime
import hashlib
import json
import pathlib
import re

from run import CODE, OUT

rows = json.loads((OUT / 'geometry-review.json').read_text())['routes']
summary = {}
for engine in ['osrm', 'valhalla']:
    for mode in ['walking', 'driving']:
        chosen = [r for r in rows if r['engine'] == engine and r['mode'] == mode]
        primary = [r for r in chosen if r['kind'] != 'matrix']
        ordinary = [r for r in chosen if r['kind'] == 'positive_control']
        responses = json.loads((OUT / f'{engine}-{mode}-responses.json').read_text())
        cgroup = json.loads((OUT / f'{engine}-{mode}-runtime.json').read_text())['cgroup']
        summary[engine + '-' + mode] = {
            'primary_statuses': dict(collections.Counter(r['status'] for r in primary)),
            'ordinary_consistent': sum(r['status'] == 'MODEL_GEOMETRY_CONSISTENT' for r in ordinary),
            'ordinary_total': len(ordinary),
            'matrix_pair_statuses': dict(collections.Counter(r['status'] for r in chosen if r['kind'] == 'matrix')),
            'route_warm': responses['route_warm'], 'matrix_warm': responses['matrix_warm'],
            'server_peak_memory_bytes': int(cgroup.splitlines()[0]),
            'server_cpu_seconds': int(re.search(r'usage_usec (\d+)', cgroup)[1]) / 1000000,
            'cold_route_ms': responses['routes']['centre']['milliseconds'],
        }

builds = {}
for key in ['osrm-walking-extract', 'osrm-walking-partition', 'osrm-walking-customize',
            'osrm-driving-extract', 'osrm-driving-partition', 'osrm-driving-customize', 'valhalla-build']:
    item = json.loads((OUT / (key + '.json')).read_text())
    raw = (OUT / (key + '.log')).read_text()
    peak = re.search(r'\n(\d+)\nusage_usec (\d+)', raw)
    builds[key] = {'seconds': item['seconds'], 'peak_memory_bytes': int(peak[1]), 'cpu_seconds': int(peak[2]) / 1000000}

graphs = {}
for folder in ['osrm-walking', 'osrm-driving', 'valhalla']:
    files = {str(p.relative_to(OUT / folder)): {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
             for p in (OUT / folder).rglob('*') if p.is_file()}
    graphs[folder] = {'total_bytes': sum(f['bytes'] for f in files.values()), 'files': files}

with (OUT / 'comparison.csv').open('w') as stream:
    writer = csv.writer(stream)
    writer.writerow(['engine', 'mode', 'case', 'kind', 'review_status', 'start_gap_m', 'target_gap_m', 'raw_distance_m', 'raw_seconds', 'issues'])
    for row in rows:
        writer.writerow([row['engine'], row['mode'], row['id'], row['kind'], row['status'], row['gap_start_m'], row['gap_target_m'],
                         row.get('raw_distance_m'), row.get('raw_seconds'), ';'.join((row.get('geometry_review', {}).get('issues') or {}).keys())])

result = {'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'summary': summary, 'builds': builds, 'graphs': graphs,
          'code_hashes': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in CODE.iterdir() if p.is_file()},
          'decision': {'walking': 'NO_GO', 'driving': 'GO_LIMITED_OSRM_CAR_PILOT', 'search_area': 'NO_GO',
                       'integration_started': False, 'next_stage': 5},
          'scope': 'MODEL_GEOMETRY_CONSISTENT means source-model checks, not observed entrance, parking, field access or real travel time.'}
(OUT / 'summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({k: {'ordinary': f"{v['ordinary_consistent']}/{v['ordinary_total']}", 'route_p95_ms': v['route_warm']['p95_ms'],
                       'matrix_p95_ms': v['matrix_warm']['p95_ms'], 'server_peak_mib': v['server_peak_memory_bytes'] / 1048576}
                  for k, v in summary.items()}, indent=2))
print('graph bytes', {k: v['total_bytes'] for k, v in graphs.items()})
