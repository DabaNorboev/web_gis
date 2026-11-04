"""Verify corrected CSV against an independent integer-DN formula from original JP2."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import sys


def verify(run):
    import numpy as np
    from analyze import write_json
    from check_radiometry import sha256

    reference = run/'derived/native-comparison-v2'
    evidence = json.loads((reference/'evidence.json').read_text())
    corrected = run/'derived/corrected-diagnostics-v1'
    arrays = np.load(reference/'aligned-native-crops.npz')
    with (corrected/'satellite-pixels.csv').open() as source:
        rows = list(csv.DictReader(source))
    checks = {}
    for year in [2024, 2026]:
        red = arrays[f'{year}_red_jp2'].astype(np.int64)
        nir = arrays[f'{year}_nir_jp2'].astype(np.int64)
        # Direct integer DN ratio: XML offset -1000 applies to both original bands.
        expected = (nir-red)/(nir+red-2000)
        actual = np.array([float(row[f'ndvi_{year}']) if row[f'ndvi_{year}'] else np.nan for row in rows]).reshape(expected.shape)
        mask = np.isfinite(actual)
        max_error = float(np.abs(actual[mask]-expected[mask]).max())
        assert max_error < 1e-12
        band_checks = [b for b in evidence['bands'] if b['year'] == year]
        for band in band_checks:
            assert band['full_tile_counts']['positive_shift_mismatches'] == 0
            assert band['full_tile_counts']['nodata_to_nonzero'] == 0
        checks[str(year)] = {'native_grid_shape': expected.shape, 'corrected_valid_pixels': int(mask.sum()),
                             'max_ndvi_error_vs_original_integer_formula': max_error,
                             'pillow_equals_gdal_in_native_crop': all(b['library']['pillow_raw_equals_rasterio'] for b in band_checks)}
    raw = []
    requests = [json.loads(line) for line in (run/'requests.jsonl').read_text().splitlines()]
    for row in requests:
        path = run/'raw'/row['name']
        assert path.stat().st_size == row['bytes']
        assert sha256(path) == row['sha256']
        raw.append({'name': row['name'], 'status': row['status'], 'hash_ok': True})
    config = json.loads((run/'config.json').read_text())
    storage = sum(p.stat().st_size for p in run.rglob('*') if p.is_file())
    assert len(requests) <= config['budgets']['http_requests']
    assert sum(r['bytes'] for r in requests) <= config['budgets']['download_bytes']
    assert storage < config['budgets']['final_storage_bytes']
    checks['raw_responses'] = raw
    checks['native_pixels_compared'] = sum(b['full_tile_counts']['total'] for b in evidence['bands'])
    checks['storage_bytes_at_check'] = storage
    checks['limits_passed'] = True
    checks['scope'] = 'numeric radiometry of two exact products; no change-detection or seasonal-composition claim'
    write_json(run/'evidence/radiometry-verification.json', checks)
    print(json.dumps({k:v for k,v in checks.items() if k not in ['raw_responses']}, ensure_ascii=False))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run', required=True, type=Path)
    a = p.parse_args()
    sys.path.insert(0, str(a.run/'python-libs'))
    verify(a.run)
