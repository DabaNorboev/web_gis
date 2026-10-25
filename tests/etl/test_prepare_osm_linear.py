import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_linear", pathlib.Path(__file__).resolve().parents[2] / "scripts/prepare-osm-linear.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PreparationTest(unittest.TestCase):
    def test_bbox_keeps_crossing_line_even_when_both_endpoints_are_outside(self):
        self.assertTrue(module.intersects_bbox([(91, 56), (95, 56)], (92, 55, 94, 57)))
        self.assertFalse(module.intersects_bbox([(91, 54), (95, 54)], (92, 55, 94, 57)))

    def test_geojson_boundary_rejects_non_polygon_or_custom_crs(self):
        for value in [{"type": "Point", "coordinates": [92, 56]}, {"type": "Polygon", "crs": "custom", "coordinates": []}]:
            with self.assertRaises(ValueError):
                module.boundary_bbox(value)

    def fixture(self, directory, missing=False):
        source = directory / "fixture.osm"
        source.write_text('''<osm version="0.6" generator="fixture">
          <node id="1" lat="56" lon="91.5" version="1" timestamp="2026-10-01T00:00:00Z"/>
          <node id="2" lat="56" lon="94.5" version="1" timestamp="2026-10-01T00:00:00Z"/>
          <way id="10" version="2" timestamp="2026-10-01T00:00:00Z"><nd ref="1"/><nd ref="''' + ('99' if missing else '2') + '''"/>
            <tag k="highway" v="primary"/><tag k="bridge" v="yes"/><tag k="layer" v="1"/></way>
          <way id="11" version="1" timestamp="2026-10-01T00:00:00Z"><nd ref="1"/><nd ref="2"/><tag k="railway" v="rail"/></way>
          <way id="12" version="1" timestamp="2026-10-01T00:00:00Z"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
        </osm>''')
        boundary = directory / "boundary.json"
        boundary.write_text(json.dumps({"type": "Polygon", "coordinates": [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]}))
        return source, boundary

    def test_real_reader_preserves_source_nodes_tags_timestamp_and_full_geometry(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = pathlib.Path(folder)
            source, boundary = self.fixture(directory)
            output = directory / "prepared"
            report = module.prepare(source, boundary, output, module.sha256(source))
            document = json.loads((output / "linear.json").read_text())
            self.assertEqual(2, report["objects"])
            self.assertEqual([10, 11], [row["id"] for row in document["elements"]])
            way = document["elements"][0]
            self.assertEqual([1, 2], way["nodes"])
            self.assertEqual([91.5, 94.5], [p["lon"] for p in way["geometry"]])
            self.assertEqual("2026-10-01T00:00:00Z", way["timestamp"])
            self.assertEqual("1", way["tags"]["layer"])
            self.assertIsNone(report["osm_base_timestamp"])
            with self.assertRaises(FileExistsError):
                module.prepare(source, boundary, output)

    def test_bad_checksum_or_missing_node_never_produces_a_successful_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = pathlib.Path(folder)
            source, boundary = self.fixture(directory, missing=True)
            output = directory / "prepared"
            with self.assertRaises(ValueError):
                module.prepare(source, boundary, output, "0" * 64)
            self.assertFalse(output.exists())
            with self.assertRaises((RuntimeError, ValueError)):
                module.prepare(source, boundary, output)
            self.assertFalse((output / "manifest.json").exists())
            self.assertFalse((output / "linear.json").exists())


if __name__ == "__main__":
    unittest.main()
