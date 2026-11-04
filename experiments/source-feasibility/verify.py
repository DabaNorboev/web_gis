"""Independent checks against saved real inputs; no network or application DB."""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import sqlite3

from PIL import Image
from analyze import write_json


def verify(run, satellite_attempt, air_attempt):
    checks = {}
    requests = [json.loads(line) for line in (run/'requests.jsonl').read_text().splitlines()]
    verified = 0
    for row in requests:
        if 'error' in row:
            continue
        path = run/'raw'/row['name']
        with path.open('rb') as source:
            digest = hashlib.sha256()
            for chunk in iter(lambda: source.read(1024*1024), b''):
                digest.update(chunk)
        assert digest.hexdigest() == row['sha256'], row['name']
        assert path.stat().st_size == row['bytes'], row['name']
        verified += 1
    checks['raw_responses_hashes_and_sizes'] = verified
    config = json.loads((run/'config.json').read_text())
    total_bytes = sum(x.get('bytes', 0) for x in requests)
    assert total_bytes <= config['budgets']['total_bytes']
    checks['download_bytes_within_budget'] = total_bytes
    for branch in ['air', 'satellite']:
        count = sum(x['branch'] == branch for x in requests)
        assert count <= config['budgets'][branch+'_requests']
        checks[branch+'_requests'] = count
    method = json.loads((run/'derived'/satellite_attempt/'frozen-method.json').read_text())
    result = json.loads((run/'derived'/satellite_attempt/'satellite-statistics.json').read_text())
    # Separate SQL aggregation of emitted pixel coordinates and values. No persistent DB.
    db = sqlite3.connect(':memory:')
    db.execute('CREATE TABLE pixels(x REAL, y REAL, a REAL, b REAL, d REAL)')
    with (run/'derived'/satellite_attempt/'satellite-pixels.csv').open() as source:
        rows = csv.DictReader(source)
        db.executemany('INSERT INTO pixels VALUES (?, ?, ?, ?, ?)',
                       ((float(r['easting']), float(r['northing']),
                         float(r['ndvi_2024']) if r['ndvi_2024'] else None,
                         float(r['ndvi_2026']) if r['ndvi_2026'] else None,
                         float(r['delta_2026_minus_2024']) if r['delta_2026_minus_2024'] else None) for r in rows))
    cx, cy = method['center_epsg32646']
    checked = []
    for radius in [200, 1000]:
        for key, column in [('2024', 'a'), ('2026', 'b'), ('difference', 'd')]:
            n, mean, maximum_error = db.execute(
                f'SELECT count({column}), avg({column}), max(abs(d-(b-a))) FROM pixels '
                'WHERE (x-?)*(x-?)+(y-?)*(y-?) <= ?', (cx, cx, cy, cy, radius*radius)).fetchone()
            expected = result[key]['circles'][str(radius)]
            assert n == expected['n']
            assert abs(mean-expected['mean']) < 1e-12
            assert maximum_error is None or maximum_error < 1e-12
            checked.append({'radius_m': radius, 'series': key, 'n': n, 'mean_matches': True})
    db.close()
    checks['independent_sql_circle_aggregations'] = checked
    records = json.loads((run/'raw/air-2026-week.json').read_text())['data']
    normalized = json.loads((run/'derived'/air_attempt/'air-normalized.json').read_text())
    originals = {(v['site'], v['time']): v for v in records}
    assert len(originals) == len(records) == len(normalized) == 504
    zeros = 0
    for row in normalized:
        original = originals[(row['station_id'], row['time_raw'])]
        assert original.get('pm25') == row['pm25_ug_m3']
        assert row['time_utc'] is None and row['timezone'] is None and row['quality_flag'] is None
        zeros += row['pm25_ug_m3'] == 0
    checks['air_actual_values_preserved'] = len(normalized)
    checks['actual_zero_values_preserved'] = zeros
    checks['timezone_and_qc_not_invented'] = True
    figures = []
    for folder in [run/'figures/diagnostics-v1', run/'figures'/air_attempt]:
        for path in sorted(folder.glob('*.png')):
            with Image.open(path) as im:
                im.load()
                assert im.width >= 1000 and len(im.getcolors(im.width*im.height)) > 10
                figures.append({'file': str(path.relative_to(run)), 'size': im.size})
    checks['real_derived_figures_decode'] = figures
    checks['scientific_validity'] = 'NOT established: numeric/identity checks are not independent vegetation controls or sensor calibration'
    write_json(run/'evidence/verification.json', checks)
    print(json.dumps({'responses_verified': verified, 'sql_checks': len(checked), 'air_values': len(normalized), 'figures': len(figures)}))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run', required=True, type=Path)
    p.add_argument('--satellite-attempt', default='analysis-v4')
    p.add_argument('--air-attempt', default='air-v2')
    a = p.parse_args()
    verify(a.run, a.satellite_attempt, a.air_attempt)
