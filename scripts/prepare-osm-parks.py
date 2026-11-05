"""Offline explicitly tagged parks; shared complete geometry and relation accounting pipeline."""
import argparse
import importlib.util
import json
import pathlib

_spec = importlib.util.spec_from_file_location('retail_preparation', pathlib.Path(__file__).with_name('prepare-osm-grocery.py'))
_pipeline = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_pipeline)
_pipeline.DATASET_KEY = 'park'
_pipeline.TAG_KEY = 'leisure'
_pipeline.RULES = {'park': {'leisure': ['park']}}
_pipeline.PRODUCER = pathlib.Path(__file__)
prepare = _pipeline.prepare
selected = _pipeline.selected
sha256 = _pipeline.sha256
envelope = _pipeline.envelope

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pbf', type=pathlib.Path)
    parser.add_argument('boundary', type=pathlib.Path)
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--expected-pbf-sha256')
    parser.add_argument('--source-url')
    args = parser.parse_args()
    print(json.dumps(prepare(args.pbf, args.boundary, args.output, args.expected_pbf_sha256, args.source_url), ensure_ascii=False, indent=2))
