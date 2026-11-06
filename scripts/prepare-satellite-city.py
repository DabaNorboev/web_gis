#!/usr/bin/env python3
"""Offline acquisition and bounded preparation for explicit city recipes."""
import argparse
import os
from pathlib import Path

os.environ.setdefault('OPJ_NUM_THREADS','1')
import rasterio as rio
from satellite_city import acquire, prepare, review_city, validate_city_release

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--stage',choices=['acquire','prepare','review','validate'],required=True)
p.add_argument('--run',type=Path)
p.add_argument('--config',type=Path)
p.add_argument('--release',type=Path)
p.add_argument('--output',type=Path)
a=p.parse_args()
try:
    with rio.Env(GDAL_NUM_THREADS='1',GDAL_CACHEMAX=32*1024*1024):
        if a.stage=='acquire':
            if a.run is None:p.error('--run required')
            acquire(a.run)
        elif a.stage=='review':
            if a.release is None or a.output is None:p.error('--release and --output required')
            review_city(a.release,a.output)
        elif a.stage=='validate':
            if a.release is None:p.error('--release required')
            validate_city_release(a.release/'manifest.json')
            print('City release validated')
        else:
            if a.config is None or a.output is None:p.error('--config and --output required')
            prepare(a.config,a.output)
except (ValueError,OSError,KeyError) as e:
    p.exit(1,str(e)+'\n')
