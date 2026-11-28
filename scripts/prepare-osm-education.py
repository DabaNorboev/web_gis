"""Extract one explicitly tagged education category from a saved OSM PBF."""
import argparse
import importlib.util
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('category', choices=('school', 'kindergarten'))
parser.add_argument('pbf', type=Path)
parser.add_argument('boundary', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--expected-pbf-sha256')
parser.add_argument('--source-url')
args = parser.parse_args()

spec = importlib.util.spec_from_file_location('poi_preparation', Path(__file__).with_name('prepare-osm-grocery.py'))
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)
pipeline.DATASET_KEY = args.category
pipeline.TAG_KEY = 'amenity'
pipeline.PRODUCER = Path(__file__)
pipeline.RULES = {args.category: {'amenity': [args.category]}}
print(json.dumps(pipeline.prepare(args.pbf, args.boundary, args.output, args.expected_pbf_sha256, args.source_url),
                 ensure_ascii=False, indent=2))
