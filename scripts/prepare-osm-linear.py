"""Offline PBF -> prepared OSM JSON for roads/railways; Python 3.12 + osmium 4.3.0.

Keeps entire source ways and metadata. The bbox is a coarse candidate filter;
the Laravel importer applies the exact polygon. No snapping or routing graph.
"""
import argparse
import datetime
import hashlib
import importlib.metadata
import json
import math
import pathlib
import resource
import time

import osmium

ROAD_TYPES = {"motorway", "trunk", "primary", "secondary"}
RAIL_TYPES = {"rail", "narrow_gauge"}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def boundary_bbox(document):
    if "crs" in document:
        raise ValueError("Boundary must use standard EPSG:4326 GeoJSON")
    if document["type"] == "FeatureCollection":
        if len(document["features"]) != 1:
            raise ValueError("Expected one polygon boundary")
        return boundary_bbox(document["features"][0])
    if document["type"] == "Feature":
        return boundary_bbox(document["geometry"])
    if document["type"] not in ("Polygon", "MultiPolygon"):
        raise ValueError("Expected Polygon/MultiPolygon boundary")

    def points(value):
        if value and isinstance(value[0], (int, float)):
            if len(value) != 2 or not all(math.isfinite(v) for v in value) or abs(value[0]) > 180 or abs(value[1]) > 90:
                raise ValueError("Invalid boundary coordinate")
            yield value
        else:
            for item in value:
                yield from points(item)

    coordinates = list(points(document["coordinates"]))
    if not coordinates:
        raise ValueError("Empty boundary")
    return (min(p[0] for p in coordinates), min(p[1] for p in coordinates), max(p[0] for p in coordinates), max(p[1] for p in coordinates))


def intersects_bbox(coordinates, bbox):
    west, south, east, north = bbox
    return not (max(p[0] for p in coordinates) < west or min(p[0] for p in coordinates) > east
                or max(p[1] for p in coordinates) < south or min(p[1] for p in coordinates) > north)


class Lines(osmium.SimpleHandler):
    def __init__(self, stream, bbox):
        super().__init__()
        self.stream, self.bbox = stream, bbox
        self.count, self.types = 0, {"roads": 0, "railways": 0}

    def way(self, way):
        tags = dict(way.tags)
        road = tags.get("highway") in ROAD_TYPES
        rail = tags.get("railway") in RAIL_TYPES
        if not road and not rail:
            return
        if any(not node.location.valid() for node in way.nodes):
            raise ValueError(f"way/{way.id}: missing node location; no bridging allowed")
        coordinates = [(node.lon, node.lat) for node in way.nodes]
        if len(coordinates) < 2:
            raise ValueError(f"way/{way.id}: incomplete way")
        if not intersects_bbox(coordinates, self.bbox):
            return
        row = {"type": "way", "id": way.id, "version": way.version, "timestamp": way.timestamp.isoformat().replace("+00:00", "Z"),
               "nodes": [node.ref for node in way.nodes], "tags": tags,
               "geometry": [{"lon": lon, "lat": lat} for lon, lat in coordinates]}
        if self.count:
            self.stream.write(",\n")
        self.stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
        self.count += 1
        self.types["roads"] += int(road)
        self.types["railways"] += int(rail)


def prepare(pbf, boundary, output, expected_checksum=None, source_url=None):
    started = time.monotonic()
    checksum = sha256(pbf)
    if expected_checksum and checksum != expected_checksum:
        raise ValueError("PBF checksum mismatch")
    bbox = boundary_bbox(json.loads(boundary.read_text()))
    with osmium.io.Reader(str(pbf), osmium.osm.NOTHING) as reader:
        timestamp = reader.header().get("osmosis_replication_timestamp") or None
    # Header timestamp is the source version, not an observation or preparation date.
    preparation = {"method": "whole_ways_intersecting_boundary_bbox", "pbf_sha256": checksum,
                   "boundary_sha256": sha256(boundary), "bbox": bbox, "osmium_version": importlib.metadata.version("osmium"),
                   "node_index": "sparse_file_array", "script_sha256": sha256(pathlib.Path(__file__)),
                   "road_types": sorted(ROAD_TYPES), "rail_types": sorted(RAIL_TYPES)}
    output.mkdir(parents=True, exist_ok=False)
    partial = output / "linear.json.partial"
    with partial.open("x") as stream:
        prefix = {"generator": "PlaceLens offline PBF preparation", "osm3s": {"timestamp_osm_base": timestamp}, "preparation": preparation}
        stream.write(json.dumps(prefix, ensure_ascii=False)[:-1] + ',"elements":[\n')
        handler = Lines(stream, bbox)
        cache = output / "nodes.index"
        try:
            handler.apply_file(str(pbf), locations=True, idx=f"sparse_file_array,{cache}")
        finally:
            # Only our disposable location index; never remove source datasets.
            cache.unlink(missing_ok=True)
        if not handler.count:
            raise ValueError("No selected lines; snapshot not published")
        stream.write("\n]}\n")
    partial.rename(output / "linear.json")
    manifest = {"status": "prepared_not_imported", "source": "OpenStreetMap", "source_url": source_url,
                "file": "linear.json", "bytes": (output / "linear.json").stat().st_size,
                "sha256": sha256(output / "linear.json"), "osm_base_timestamp": timestamp, "observed_at": None,
                "prepared_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "objects": handler.count,
                "candidate_counts": handler.types, "preparation": preparation,
                "duration_seconds": round(time.monotonic() - started, 2), "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pbf", type=pathlib.Path)
    parser.add_argument("boundary", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--expected-pbf-sha256")
    parser.add_argument("--source-url")
    args = parser.parse_args()
    print(json.dumps(prepare(args.pbf, args.boundary, args.output, args.expected_pbf_sha256, args.source_url), ensure_ascii=False, indent=2))
