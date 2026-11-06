#!/usr/bin/env python3
"""Offline, immutable single-date Sentinel release. No application or network IO."""
import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import re
import time
import xml.etree.ElementTree as ET

import numpy as np
import rasterio as rio
from rasterio.enums import ColorInterp, Resampling
from rasterio.features import shapes
from rasterio.warp import reproject, transform_bounds, transform_geom
from rasterio.windows import Window

METHOD = 'placelens-s2-date-v1'
MASK_VERSION = 'scl456-dn-v1'
NODATA = -9999.0
REASONS = {0: 'valid', 1: 'nodata', 2: 'ambiguous_COG_DN1', 3: 'saturated',
           4: 'cloud_shadow', 5: 'cloud_or_cirrus', 6: 'unclassified',
           7: 'SCL2_dark_or_shadow', 8: 'snow', 9: 'defective',
           10: 'numerical', 11: 'unsupported_SCL'}
EDGES = [-1, -.2, 0, .2, .4, .6, .8, 1]
COLORS = ['#234682', '#508cb9', '#b9af9b', '#cda55f', '#d7dc8c', '#73af5a', '#237337']


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, value):
    with path.open('x', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2, allow_nan=False)
        f.write('\n')


def pinned_inputs(config, root):
    paths = {}
    for key, item in config['inputs'].items():
        relative = Path(item['path'])
        require(not relative.is_absolute() and '..' not in relative.parts, 'Local relative input required')
        p = (root / relative).resolve()
        require(p.is_relative_to(root.resolve()) and p.is_file(), f'Missing local input: {key}')
        require(p.stat().st_size == item['bytes'] and sha256(p) == item['sha256'], f'Input checksum: {key}')
        paths[key] = p
    return paths


def xml_values(path, tag):
    return [e for e in ET.parse(path).iter() if e.tag.split('}')[-1] == tag]


def utc_time(value):
    # Legal XML fractional seconds may have five digits; preserve them on Python 3.10.
    value = re.sub(r'\.(\d+)(?=Z|[+-]\d\d:)', lambda m: '.' + m[1].ljust(6, '0'), value)
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def validate_identity(config, paths):
    scenes = json.loads(paths['scenes'].read_text())
    matches = [s for s in scenes if s['id'] == config['scene_id']]
    require(len(matches) == 1, 'Unique scene required')
    scene = matches[0]
    props = scene['properties']
    product = xml_values(paths['product_xml'], 'PRODUCT_URI')[0].text
    baseline = xml_values(paths['product_xml'], 'PROCESSING_BASELINE')[0].text
    acquired = xml_values(paths['granule_xml'], 'SENSING_TIME')[0].text
    require(product == props['s2:product_uri'] and baseline == props['s2:processing_baseline'], 'Product identity')
    catalog_time = utc_time(props['datetime'])
    sensing_time = utc_time(acquired)
    require(abs((catalog_time - sensing_time).total_seconds()) < .001, 'Catalog/granule time mismatch')
    require(acquired[:10] == config['date'], 'Observation date mismatch')
    require(float(xml_values(paths['product_xml'], 'BOA_QUANTIFICATION_VALUE')[0].text) == 10000, 'Quantification')
    offsets = {e.attrib['band_id']: int(e.text) for e in xml_values(paths['product_xml'], 'BOA_ADD_OFFSET')}
    require(offsets['3'] == offsets['7'] == -1000, 'B04/B08 product offsets')
    evidence = json.loads(paths['proof'].read_text())
    layout = config.get('input_layout', 'full_tile')
    require(layout in ['full_tile', 'native_window'], 'Unsupported input layout')
    expected_status = 'native_reference_checked' if layout == 'full_tile' else 'window_reference_checked'
    require(evidence['status'] == expected_status, 'Matching native reference proof required')
    for key, band in [('red', 'B04'), ('nir', 'B08')]:
        if layout == 'full_tile':
            records = [r for r in evidence['bands'] if r['scene_id'] == scene['id'] and r['band'] == band]
        else:
            records = [r for r in evidence['records'] if r['scene_id'] == scene['id'] and r['band'] == key]
        require(len(records) == 1, 'Unique band proof required')
        r = records[0]
        if layout == 'full_tile':
            counts = r['full_tile_counts']
            require(r['validated'] is True and all(counts[k] == 0 for k in
                    ['positive_shift_mismatches', 'nodata_to_nonzero', 'low_to_other', 'original_saturated']), 'Invalid encoding proof')
            require(r['legacy_sha256'] == config['inputs'][key]['sha256'], 'Proof/input identity')
            require(r['identity']['product_uri'] == product and r['identity']['baseline'] == baseline and
                    r['identity']['granule_sensing_time'] == acquired and
                    r['identity']['product_xml_sha256'] == config['inputs']['product_xml']['sha256'], 'Proof/product identity')
        else:
            require(r['crop_sha256'] == config['inputs'][key]['sha256'] and r['positive_mismatches'] == 0,
                    'Window proof/input identity')
            require(r['product_uri'] == product and r['baseline'] == baseline and r['sensing_time'] == acquired and
                    r['product_xml_sha256'] == config['inputs']['product_xml']['sha256'] and
                    r['date'] == config['date'], 'Window proof/product identity')
            require(r['pixels'] == config['window']['width'] * config['window']['height'] and
                    r['library_scale'] == 1 and r['library_offset'] == 0, 'Window proof scope')
        require(r['original_sha256'] == config['inputs'][key + '_jp2']['sha256'], 'Proof/JP2 identity')
        require(r['quantification'] == 10000 and r['product_offset_dn'] == -1000 and
                r['provider_shift_dn'] == 1000, 'Unsupported encoding; no inferred correction')
        require(r['asset_href'] == scene['assets'][key]['href'], 'Proof asset identity')
    for key in ['red', 'nir', 'scl', 'visual']:
        require(config['inputs'][key]['source'] == scene['assets'][key]['href'], 'Source/scene mismatch')
    return scene, acquired


def validate_grid(src, ref, factor=1, count=1, dtype='uint16', nodata=0, window=None):
    expected_transform = ref.window_transform(window) if window else ref.transform * rio.Affine.scale(factor)
    expected_width = window.width if window else ref.width / factor
    expected_height = window.height if window else ref.height / factor
    require(src.crs == ref.crs and src.transform == expected_transform, 'Misaligned grid')
    require(src.width == expected_width and src.height == expected_height, 'Grid extent mismatch')
    require(src.count == count and all(t == dtype for t in src.dtypes), 'Unexpected channels/encoding')
    require(all(v == 1 for v in src.scales) and all(v == 0 for v in src.offsets), 'Reader scale/offset changed')
    require(src.nodata == nodata, 'Unexpected source nodata')


def calculate(red, nir, scl):
    require(red.dtype == nir.dtype == np.dtype('uint16'), 'Expected integer stored DN, not reflectance')
    reason = np.zeros(red.shape, dtype='uint8')
    tests = [(1, (red == 0) | (nir == 0) | (scl == 0)), (2, (red == 1) | (nir == 1)),
             (3, (red == 65535) | (nir == 65535)), (4, scl == 3), (5, np.isin(scl, [8, 9, 10])),
             (6, scl == 7), (7, scl == 2), (8, scl == 11), (9, scl == 1),
             (11, ~np.isin(scl, range(12)))]
    for code, mask in tests:
        reason[(reason == 0) & mask] = code
    # Verified provider +1000 and XML -1000 cancel. Apply only scale 0.0001.
    r, n = red.astype('float64') * .0001, nir.astype('float64') * .0001
    denom = n + r
    ndvi = np.divide(n - r, denom, out=np.full(red.shape, np.nan), where=denom > 0)
    reason[(reason == 0) & (~np.isfinite(ndvi) | (abs(ndvi) > 1))] = 10
    ndvi[reason != 0] = NODATA
    return ndvi.astype('float32'), reason


def legend():
    return {'version': 'ndvi-fixed-v2', 'units': 'dimensionless', 'intervals': '[min,max), final max inclusive; boundaries rounded to stored float32',
            'unknown': {'color': '#00000000', 'label': 'Неизвестно / исключено маской'},
            'classes': [{'min': a, 'max': b, 'color': c, 'label': f'NDVI {a} … {b}'}
                        for a, b, c in zip(EDGES, EDGES[1:], COLORS)]}


def colorize(ndvi, valid):
    table = np.array([[int(c[i:i+2], 16) for i in (1, 3, 5)] for c in COLORS], dtype='uint8')
    indices = np.clip(np.searchsorted(np.asarray(EDGES[1:], dtype='float32'), ndvi, side='right'), 0, len(COLORS) - 1)
    rgba = np.zeros((4, *ndvi.shape), dtype='uint8')
    rgba[:3] = np.moveaxis(table[indices], -1, 0)
    rgba[:3, ~valid] = 0
    rgba[3] = valid.astype('uint8') * 255
    return rgba


def write_raster(path, data, affine, nodata=None, rgb=False):
    if data.ndim == 2:
        data = data[None]
    with rio.open(path, 'w', driver='GTiff', width=data.shape[2], height=data.shape[1], count=data.shape[0],
                  dtype=data.dtype, crs='EPSG:32646', transform=affine, nodata=nodata,
                  tiled=True, blockxsize=256, blockysize=256, compress='deflate') as dst:
        dst.write(data)
        if rgb:
            dst.colorinterp = (ColorInterp.red, ColorInterp.green, ColorInterp.blue) + ((ColorInterp.alpha,) if len(data) == 4 else ())


def coverage_geojson(mask, affine):
    features = []
    for geom, value in shapes(mask.astype('uint8'), mask=mask, transform=affine):
        if value == 1:
            features.append({'type': 'Feature', 'properties': {},
                             'geometry': transform_geom('EPSG:32646', 'EPSG:4326', geom)})
    return {'type': 'FeatureCollection', 'features': features}


def prepare(config_path, root, output):
    started = time.perf_counter()
    require(not output.exists(), 'Release directory already exists; choose a new path')
    config = json.loads(config_path.read_text())
    require(config['schema_version'] == 1 and config['method_version'] == METHOD, 'Unsupported recipe')
    paths = pinned_inputs(config, root)
    scene, acquired = validate_identity(config, paths)
    window = Window(**config['window'])
    require(all(isinstance(v, int) and v >= 0 for v in config['window'].values()) and
            window.width > 0 and window.height > 0 and window.width * window.height <= 4_000_000,
            'Window must be positive integer pixels, at most 4M pixels')
    with ExitStack() as stack:
        sources = {k: stack.enter_context(rio.open(paths[k])) for k in ['red', 'nir', 'scl', 'visual', 'red_jp2', 'nir_jp2']}
        cropped = config.get('input_layout', 'full_tile') == 'native_window'
        ref = sources['red_jp2'] if cropped else sources['red']
        require(ref.crs.to_epsg() == 32646 and ref.res == (10, 10) and
                ref.transform.b == ref.transform.d == 0 and ref.transform.a == 10 and ref.transform.e == -10, 'Expected native UTM grid')
        require(window.col_off + window.width <= ref.width and window.row_off + window.height <= ref.height, 'Window outside source')
        for key in ['red_jp2', 'nir_jp2']:
            validate_grid(sources[key], ref, nodata=None)
        for key in ['red', 'nir']:
            validate_grid(sources[key], ref, nodata=None if cropped else 0, window=window if cropped else None)
        validate_grid(sources['visual'], ref, count=3, dtype='uint8',
                      nodata=None if cropped else 0, window=window if cropped else None)
        validate_grid(sources['scl'], ref, factor=2, dtype='uint8')
        affine = ref.window_transform(window)
        red, nir = (sources[k].read(1, window=None if cropped else window) for k in ['red', 'nir'])
        rgb = sources['visual'].read(window=None if cropped else window)
        # Read only the enclosing 20m window; exact destination grid, nearest only.
        sw = Window(window.col_off // 2, window.row_off // 2,
                    (window.width + window.col_off % 2 + 1) // 2,
                    (window.height + window.row_off % 2 + 1) // 2)
        scl = np.zeros(red.shape, dtype='uint8')
        reproject(sources['scl'].read(1, window=sw), scl,
                  src_transform=sources['scl'].window_transform(sw), src_crs=ref.crs,
                  dst_transform=affine, dst_crs=ref.crs, src_nodata=0, dst_nodata=0, resampling=Resampling.nearest)
        ndvi, reasons = calculate(red, nir, scl)
        valid = reasons == 0
        # Independent direct JP2 formula on the entire release window, not just control points.
        jr, jn = (sources[k].read(1, window=window).astype('float64') for k in ['red_jp2', 'nir_jp2'])
        for cog, original in [(red, jr), (nir, jn)]:
            # Establish all encoding classes on every new window, not only retained DN.
            require(not np.any(original == 65535), 'Unestablished original saturation encoding')
            expected = np.where(original == 0, 0, np.maximum(original - 1000, 1))
            require(np.array_equal(cog, expected), 'COG/JP2 window encoding mismatch')
        direct = np.divide(jn - jr, jn + jr - 2000, out=np.full(red.shape, np.nan), where=(jn + jr != 2000))
        require(np.allclose(ndvi[valid], direct[valid], rtol=0, atol=6e-8), 'Independent NDVI check failed')
        max_error = float(np.max(abs(ndvi[valid] - direct[valid]))) if valid.any() else None
    geographic = (red != 0) & (nir != 0) & (scl != 0)
    output.mkdir(parents=True, exist_ok=False)
    # Absence of manifest means incomplete release; never activate it.
    write_json(output / 'recipe.json', config)
    write_json(output / 'scene.json', scene)
    write_json(output / 'legend.json', legend())
    layers = {'true-color.tif': (rgb, 0, True), 'ndvi.tif': (ndvi, NODATA, False),
              'ndvi-rgba.tif': (colorize(ndvi, valid), None, True), 'scl.tif': (scl, 0, False),
              'exclusion-reason.tif': (reasons, None, False),
              'geographic-mask.tif': (geographic.astype('uint8'), None, False),
              'usable-mask.tif': (valid.astype('uint8'), None, False)}
    for name, (data, nodata, rgb_flag) in layers.items():
        write_raster(output / name, data, affine, nodata, rgb_flag)
    for name, mask in [('geographic', geographic), ('usable', valid)]:
        write_json(output / f'{name}-coverage.geojson', coverage_geojson(mask, affine))
    native_bounds = list(rio.transform.array_bounds(*red.shape, affine))
    bounds = list(transform_bounds('EPSG:32646', 'EPSG:4326', *native_bounds, densify_pts=21))
    assets = {}
    for p in sorted(output.iterdir()):
        asset = {'path': p.name, 'bytes': p.stat().st_size, 'sha256': sha256(p)}
        if p.suffix == '.tif':
            with rio.open(p) as ds:
                require(ds.transform == affine and ds.shape == red.shape, 'Output grid mismatch')
                asset.update(media_type='image/tiff; application=geotiff', crs=str(ds.crs),
                             bounds=bounds, dtype=ds.dtypes[0], bands=ds.count, nodata=ds.nodata)
        assets[p.name] = asset
    manifest = {'schema_version': 2, 'status': 'prepared_offline', 'method_version': METHOD,
                'mask_version': MASK_VERSION, 'legend_version': legend()['version'],
                'created_at': datetime.now(timezone.utc).isoformat(), 'observation_date': config['date'],
                'acquired_at': acquired, 'scene_id': scene['id'], 'product_uri': scene['properties']['s2:product_uri'],
                'baseline': scene['properties']['s2:processing_baseline'], 'tile': '46VDH',
                'cloud_cover_percent': scene['properties'].get('eo:cloud_cover'),
                'territory': config['territory'], 'bounds': bounds, 'native_bounds': native_bounds,
                'grid': {'crs': 'EPSG:32646', 'transform': list(affine)[:6], 'width': int(window.width),
                         'height': int(window.height), 'resolution_m': 10, 'scl_source_resolution_m': 20,
                         'resampling': {'B04_B08_TCI': 'none; native window', 'SCL': 'nearest 20m to exact 10m grid'}},
                'radiometry': {'channels': {'red': 'B04', 'nir': 'B08', 'true_color': 'provider TCI (B04/B03/B02)'},
                               'stored_encoding': 'verified COG = JP2 - 1000, low DN clipped to 1',
                               'product_offset_dn': -1000, 'provider_shift_dn': 1000,
                               'applied_scale': .0001, 'applied_offset': 0,
                               'ndvi': '(rho_B08-rho_B04)/(rho_B08+rho_B04)',
                               'true_color': 'unchanged provider display TCI; not quantitative reflectance'},
                'mask': {'accepted_scl': [4, 5, 6], 'water_included': True, 'reason_codes': REASONS,
                         'priority': [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 10],
                         'dn1': 'unknown; no recovery from clipped COG', 'buffer': None,
                         'geographic': 'B04 != 0 AND B08 != 0 AND SCL != 0; independent of usability',
                         'usable': 'exclusion_reason == 0', 'rgb_nodata': 'provider TCI nodata=0; independent of NDVI mask'},
                'coverage': {'scope': 'prepared_window', 'total_pixels': int(red.size), 'geographic_pixels': int(geographic.sum()),
                             'usable_pixels': int(valid.sum()), 'geographic_fraction': float(geographic.mean()),
                             'valid_fraction': float(valid.mean()), 'nodata_fraction': float((~geographic).mean()),
                             'masked_fraction': float((geographic & ~valid).mean()),
                             'exclusive_reason_counts': {REASONS[k]: int((reasons == k).sum()) for k in REASONS},
                             'dn1_marginal_pixels': int(((red == 1) | (nir == 1)).sum()),
                             'denominator': 'all pixels of release rectangle; not place/radius or vegetation area'},
                'verification': {'jp2_checked_pixels_per_band': int(red.size), 'ndvi_max_absolute_error': max_error, 'input_layout': config.get('input_layout', 'full_tile'),
                                 'outputs_reopened': True},
                'inputs': config['inputs'], 'recipe_sha256': sha256(output / 'recipe.json'), 'source_recipe_sha256': sha256(config_path),
                'software': {'python': platform.python_version(), 'numpy': np.__version__, 'rasterio': rio.__version__,
                             'gdal': rio.__gdal_version__, 'script_sha256': sha256(Path(__file__))},
                'assets': assets, 'metrics': {'elapsed_seconds_before_manifest': time.perf_counter() - started,
                                            'output_bytes_excluding_manifest': sum(a['bytes'] for a in assets.values())},
                'limitations': ['Only this rectangle, not city coverage', 'SCL accuracy not independently validated',
                                '10m mixed pixels; NDVI is not vegetation percentage', 'No API/UI/provider activation',
                                'Missing manifest means incomplete release; existing directories never overwritten']}
    write_json(output / 'manifest.json', manifest)
    print(json.dumps({'manifest': str(output / 'manifest.json'), 'seconds': time.perf_counter() - started,
                      'output_bytes': sum(p.stat().st_size for p in output.iterdir()), 'coverage': manifest['coverage']}, ensure_ascii=False))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--input-root', type=Path, default=Path('.'))
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        with rio.Env(GDAL_NUM_THREADS='1', GDAL_CACHEMAX=64 * 1024 * 1024):
            prepare(args.config, args.input_root, args.output)
    except (ValueError, FileNotFoundError) as error:
        parser.exit(1, f'{error}\n')
