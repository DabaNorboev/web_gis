#!/bin/sh
set -eu
cd /data
# Reviewed release pins. Graph copies live only in tmpfs because GraphHopper locks it.
printf '%s\n' \
  'c448c4c1625e4bc514347d03ede7d364ba04d1af536f8a25e91d347b34a6a6a7  manifest.json' \
  '69158892dc33fb1a936d6a30b70d665440ecb9e4742966f2869f542e03e52a41  graph.sha256' \
  '8495bc1117d283c929979489f16ad653cc5699fff75c2595012893d7b6125e4b  ors-config.yml' \
  '7b6233984c6246db014fa8d85461d7a2f33405261410f040612e0380a1c1089d  source.osm.pbf' \
  | sha256sum -c - >/dev/null
sha256sum -c graph.sha256 >/dev/null
mkdir -p /tmp/ors
cp -R /data/graph /tmp/graphs
export ORS_HOME=/tmp/ors
export ORS_CONFIG_LOCATION=/data/ors-config.yml
exec java -Xms256m -Xmx2g -XX:ActiveProcessorCount=2 \
  -Dlog4j.configurationFile=/logging.xml -Dlogging.config=/logging.xml \
  -jar /ors.jar
