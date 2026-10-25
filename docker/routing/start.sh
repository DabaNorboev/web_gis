#!/bin/sh
set -eu
cd /data
# These two pins are part of the reviewed runtime release, not mutable data input.
printf '%s\n' \
  'cd62979bb110e446addd6c4221e731990b7e553a679a85921562b9ed557683cc  manifest.json' \
  '6b4b314f72190f18c85ad9950bf8a9ba4dc57ad19688997147a8610c0a369680  graph.sha256' \
  | sha256sum -c -
sha256sum -c graph.sha256
exec osrm-routed --algorithm mld --threads 1 --verbosity WARNING \
  --max-viaroute-size 3 --max-table-size 16 --max-trip-size 3 \
  --max-matching-size 3 --max-nearest-size 2 --max-alternatives 1 \
  /data/graph/pilot.osrm
