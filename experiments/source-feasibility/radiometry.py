"""Explicit DN encodings verified against original JP2; no archive-wide inference."""
import hashlib
import json
from numbers import Integral


def dn_to_reflectance(dn, *, quantification, product_offset_dn, provider_shift_dn):
    """Convert integer stored DN once. Shift is storage history, not another correction."""
    if not isinstance(dn, Integral):
        raise TypeError('Expected integer raw DN, not already converted reflectance')
    if quantification <= 0:
        raise ValueError('Quantification must be positive')
    if dn in (0, 65535):
        return None
    # These COGs collapse original DN <= 1000 (and original 1001) to 1.
    # Without the matching JP2 the original reflectance is ambiguous.
    if provider_shift_dn and dn == 1:
        return None
    return (int(dn) + provider_shift_dn + product_offset_dn) / quantification


def file_sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()


def verified_recipes(path, scenes, raw_directory):
    if path is None:
        raise ValueError('An original-JP2 radiometry evidence file is required; metadata flags alone are insufficient')
    evidence = json.loads(path.read_text())
    if evidence.get('status') != 'native_reference_checked':
        raise ValueError('Native-reference proof is missing')
    recipes = {}
    for scene in scenes:
        for key, band in [('red', 'B04'), ('nir', 'B08')]:
            matches = [r for r in evidence['bands'] if r['scene_id'] == scene['id'] and r['band'] == band]
            if len(matches) != 1:
                raise ValueError('No unique proof for this scene and band')
            proof = matches[0]
            counts = proof['full_tile_counts']
            if (proof.get('validated') is not True or counts['positive_shift_mismatches'] != 0
                    or counts['nodata_to_nonzero'] != 0 or counts['low_to_other'] != 0
                    or counts['original_saturated'] != 0
                    or proof['identity']['product_uri'] != scene['properties']['s2:product_uri']
                    or proof['identity']['baseline'] != scene['properties']['s2:processing_baseline']
                    or proof['asset_href'] != scene['assets'][key]['href']):
                raise ValueError('Proof does not establish this encoding')
            local = raw_directory/f"satellite-{proof['year']}-{key}.tif"
            if file_sha256(local) != proof['legacy_sha256']:
                raise ValueError('COG bytes differ from the verified input')
            recipes[(scene['id'], key)] = {k: proof[k] for k in ['quantification', 'product_offset_dn', 'provider_shift_dn']}
    return recipes
