"""Compare the two original JP2 products to existing A2 COGs on their native grid."""
import argparse
import csv
import datetime as dt
import hashlib
import json
from pathlib import Path
import sys
import time
import xml.etree.ElementTree as ET


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()


def text(root, tag):
    return next(el.text for el in root.iter() if el.tag.split('}')[-1] == tag)


def metadata(run, scene, year):
    product = ET.parse(run/'raw'/f'{year}-original-product.xml').getroot()
    granule = ET.parse(run/'raw'/f'{year}-granule_metadata.xml').getroot()
    p = scene['properties']
    uri, baseline = text(product, 'PRODUCT_URI'), text(product, 'PROCESSING_BASELINE')
    sensing = text(granule, 'SENSING_TIME')
    assert uri == p['s2:product_uri']
    assert baseline == p['s2:processing_baseline']
    time_difference = abs((dt.datetime.fromisoformat(sensing.replace('Z', '+00:00'))
                           - dt.datetime.fromisoformat(p['datetime'].replace('Z', '+00:00'))).total_seconds())
    # Catalog values have millisecond precision; XML preserves microseconds.
    assert time_difference < .001
    assert '_T46VDH_' in uri
    satellite = text(product, 'SPACECRAFT_NAME')
    assert satellite.replace('Sentinel-', 'S') == uri[:3]
    offsets = {el.attrib['band_id']: int(el.text) for el in product.iter() if el.tag.split('}')[-1] == 'BOA_ADD_OFFSET'}
    q = int(text(product, 'BOA_QUANTIFICATION_VALUE'))
    return {'product_uri': uri, 'baseline': baseline, 'spacecraft': satellite, 'tile': '46VDH',
            'granule_sensing_time': sensing, 'catalog_time_truncation_seconds': time_difference,
            'product_start_time': text(product, 'PRODUCT_START_TIME'),
            'quantification': q, 'offsets_by_band_id': offsets,
            'product_xml_sha256': sha256(run/'raw'/f'{year}-original-product.xml'),
            'c1_xml_identical': sha256(run/'raw'/f'{year}-original-product.xml') == sha256(run/'raw'/f'{year}-c1-product.xml')}


def compare(run, previous, attempt):
    import numpy as np
    import rasterio
    from rasterio.windows import Window
    from PIL import Image
    from analyze import write_json

    Image.MAX_IMAGE_PIXELS = 130_000_000
    output = run/'derived'/attempt
    output.mkdir(exist_ok=False)
    started = time.monotonic()
    scenes = json.loads((previous/'selected-scenes.json').read_text())
    method = json.loads((previous/'derived/analysis-v4/frozen-method.json').read_text())
    west, north, east, south = method['extent_epsg32646']
    rows, proof, crops, examples = [], [], {}, []
    for scene in scenes:
        year = int(scene['properties']['datetime'][:4])
        identity = metadata(run, scene, year)
        for band, key, band_id in [('B04', 'red', '3'), ('B08', 'nir', '7')]:
            original = run/'raw'/(f'2024-original-{band}.jp2' if year == 2024 else f'2026-{key}-jp2.jp2')
            legacy = previous/'raw'/f'satellite-{year}-{key}.tif'
            offset_dn, q = identity['offsets_by_band_id'][band_id], identity['quantification']
            assert offset_dn == -1000 and q == 10000
            with rasterio.open(original) as ref, rasterio.open(legacy) as cog:
                assert ref.crs == cog.crs == rasterio.crs.CRS.from_epsg(32646)
                assert ref.transform == cog.transform and ref.shape == cog.shape
                assert cog.dtypes == ref.dtypes == ('uint16',)
                assert ref.scales == cog.scales == (1.0,) and ref.offsets == cog.offsets == (0.0,)
                w = cog.window(west, south, east, north).round_offsets().round_lengths()
                a, b = ref.read(1, window=w, masked=False), cog.read(1, window=w, masked=False)
                with Image.open(legacy) as image:
                    p = np.asarray(image.crop((int(w.col_off), int(w.row_off), int(w.col_off+w.width), int(w.row_off+w.height))))
                assert np.array_equal(p, b), 'Pillow/Rasterio raw mismatch'
                counts = {'total': 0, 'original_nodata': 0, 'nodata_to_nonzero': 0,
                          'original_saturated': 0, 'positive_expected_shift': 0, 'positive_shift_mismatches': 0,
                          'original_1_to_1000': 0, 'low_to_zero': 0, 'low_to_one': 0, 'low_to_other': 0}
                cases = {}
                max_error = 0.0
                for r0 in range(0, ref.height, 1024):
                    for c0 in range(0, ref.width, 1024):
                        window = Window(c0, r0, min(1024, ref.width-c0), min(1024, ref.height-r0))
                        raw = ref.read(1, window=window, masked=False)
                        stored = cog.read(1, window=window, masked=False)
                        valid = (raw > 1000) & (raw != 65535)
                        nodata, low, saturated = raw == 0, (raw > 0) & (raw <= 1000), raw == 65535
                        predicted = raw.astype(np.int32) + offset_dn
                        counts['total'] += raw.size
                        counts['original_nodata'] += int(nodata.sum())
                        counts['nodata_to_nonzero'] += int((nodata & (stored != 0)).sum())
                        counts['original_saturated'] += int(saturated.sum())
                        counts['positive_expected_shift'] += int(valid.sum())
                        counts['positive_shift_mismatches'] += int((valid & (stored.astype(np.int32) != predicted)).sum())
                        counts['original_1_to_1000'] += int(low.sum())
                        counts['low_to_zero'] += int((low & (stored == 0)).sum())
                        counts['low_to_one'] += int((low & (stored == 1)).sum())
                        counts['low_to_other'] += int((low & (stored > 1)).sum())
                        if valid.any():
                            error = np.abs((raw[valid].astype(np.float64)+offset_dn)/q - stored[valid].astype(np.float64)/q)
                            max_error = max(max_error, float(error.max()))
                        for case, mask in [('nodata', nodata), ('low', low), ('positive', valid), ('saturated', saturated)]:
                            if case not in cases and mask.any():
                                rr, cc = np.argwhere(mask)[0]
                                cases[case] = {'row': r0+int(rr), 'col': c0+int(cc), 'jp2_dn': int(raw[rr, cc]), 'cog_dn': int(stored[rr, cc])}
                    print(f'{year} {band}: native rows {r0}..{min(r0+1024, ref.height)}', flush=True)
                assert counts['positive_shift_mismatches'] == counts['nodata_to_nonzero'] == 0
                assert max_error < 1e-12
                record = {'scene_id': scene['id'], 'year': year, 'band': band, 'key': key,
                          'identity': identity, 'native_grid': {'crs': str(ref.crs), 'shape': ref.shape,
                          'transform': list(ref.transform)[:6], 'resampling': 'none'},
                          'library': {'rasterio': rasterio.__version__, 'gdal': rasterio.__gdal_version__,
                          'jp2_driver': ref.driver, 'cog_driver': cog.driver, 'jp2_scales': ref.scales,
                          'jp2_offsets': ref.offsets, 'cog_scales': cog.scales, 'cog_offsets': cog.offsets,
                          'pillow_raw_equals_rasterio': True, 'read_masked': False},
                          'full_tile_counts': counts, 'cases': cases, 'max_reflectance_error_on_retained_dn': max_error,
                          'original_sha256': sha256(original), 'legacy_sha256': sha256(legacy),
                          'asset_href': scene['assets'][key]['href'], 'quantification': q,
                          'product_offset_dn': offset_dn, 'provider_shift_dn': 1000,
                          'validated': True, 'validation_scope': 'this exact file hash; retained nonzero, nonsaturated pixels'}
                proof.append(record)
                crops[f'{year}_{key}_jp2'] = a
                crops[f'{year}_{key}_cog'] = b
                for rr, cc in [(0, 0), (190, 190), (379, 379)]:
                    jd, cd = int(a[rr, cc]), int(b[rr, cc])
                    examples.append({'year': year, 'band': band, 'row': int(w.row_off)+rr, 'col': int(w.col_off)+cc,
                                     'jp2_dn': jd, 'cog_dn': cd, 'jp2_offset_dn': offset_dn,
                                     'quantification': q, 'jp2_reflectance': (jd+offset_dn)/q if jd else None,
                                     'cog_reflectance_correct': cd/q if cd else None,
                                     'cog_reflectance_double_offset': cd/q+offset_dn/q if cd else None})
                print(json.dumps({'year': year, 'band': band, 'counts': counts, 'cases': cases}), flush=True)
    np.savez_compressed(output/'aligned-native-crops.npz', **crops)
    write_json(output/'evidence.json', {'status': 'native_reference_checked', 'previous_run': str(previous),
               'bands': proof, 'scenes': scenes, 'extent_epsg32646': method['extent_epsg32646'],
               'center_epsg32646': method['center_epsg32646'], 'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
               'elapsed_seconds': time.monotonic()-started, 'limitations': 'two products only; clipped/nodata DN cannot be inverted; no vegetation-change validation'})
    write_json(output/'checked-values.json', examples)
    with (output/'checked-values.csv').open('x', newline='') as target:
        writer = csv.DictWriter(target, fieldnames=list(examples[0]))
        writer.writeheader(); writer.writerows(examples)
    print(output)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run', required=True, type=Path)
    p.add_argument('--previous', required=True, type=Path)
    p.add_argument('--attempt', default='native-comparison-v1')
    a = p.parse_args()
    sys.path.insert(0, str(a.run/'python-libs'))
    compare(a.run, a.previous, a.attempt)
