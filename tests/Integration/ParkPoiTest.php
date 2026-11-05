<?php

namespace Tests\Integration;

use App\Services\Analysis\ParkPoiProvider;
use App\Services\Osm\Import\OsmGroceryImporter;
use App\Services\Osm\Import\OsmParkImporter;
use App\Services\Osm\Import\OsmParkReader;
use App\Services\Osm\Import\OsmPharmacyImporter;
use App\Services\Transport\Import\OfficialStopsImporter;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase;

class ParkPoiTest extends PostgisTestCase
{
    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        DB::table('dataset_imports')->whereIn('dataset_key', ['park', 'grocery', 'pharmacy', OfficialStopsImporter::DATASET])->update(['is_active' => false]);
        config(['place_analysis.parks_enabled' => true, 'place_analysis.official_stops_enabled' => true]);
        $this->directory = sys_get_temp_dir().'/park-test-'.bin2hex(random_bytes(6));
        mkdir($this->directory);
        file_put_contents($this->directory.'/boundary.json', '{"type":"Polygon","coordinates":[[[92,55],[94,55],[94,57],[92,57],[92,55]]]}');
    }

    protected function tearDown(): void
    {
        while (DB::transactionLevel() > 0) {
            DB::rollBack();
        }
        foreach (glob($this->directory.'/*') as $file) {
            unlink($file);
        }
        rmdir($this->directory);
        parent::tearDown();
    }

    private function node(int $id, array $tags = [], float $lon = 93, float $lat = 56): array
    {
        return ['type' => 'node', 'id' => $id, 'lon' => $lon, 'lat' => $lat, 'tags' => $tags + ['leisure' => 'park']];
    }

    private function way(int $id, array $ring, array $tags = []): array
    {
        return ['type' => 'way', 'id' => $id, 'tags' => $tags + ['leisure' => 'park'], 'geometry' => array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], $ring)];
    }

    private function import(array $rows, ?array $change = null): array
    {
        $counts = ['node' => 0, 'way' => 0, 'relation' => 0];
        $outcomes = [];
        foreach ($rows as $row) {
            $counts[$row['type']]++;
            if ($row['type'] === 'relation') {
                $outcomes[] = ['source_id' => 'osm:relation:'.$row['id'], 'status' => 'emitted'];
            }
        }
        $p = ['schema_version' => 2, 'dataset_key' => 'park', 'categories' => ['park'], 'method' => 'complete_source_members_bbox_v2', 'object_types' => ['node', 'way', 'relation'],
            'rules' => ['park' => ['leisure' => ['park']]], 'pbf_sha256' => hash('sha256', 'fixture'), 'script_sha256' => hash('sha256', 'producer'),
            'common_script_sha256' => hash('sha256', 'common'), 'retail_script_sha256' => hash('sha256', 'shared'),
            'boundary_sha256' => hash_file('sha256', $this->directory.'/boundary.json'), 'bbox' => [92, 55, 94, 57],
            'extraction_geometry' => json_decode(file_get_contents($this->directory.'/boundary.json'), true),
            'emitted_counts' => $counts, 'relation_audit' => ['selected_count' => count($outcomes), 'outcomes' => $outcomes]];
        file_put_contents($this->directory.'/park.json', json_encode(['elements' => $rows, 'preparation' => $change ?? $p]));

        return app(OsmParkImporter::class)->import($this->directory.'/park.json', $this->directory.'/boundary.json');
    }

    private function response(float $lon = 93, float $lat = 56, int $radius = 200): array
    {
        return $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'point', 'lon' => $lon, 'lat' => $lat], 'radius_m' => $radius, 'blocks' => ['poi']])->assertOk()->json();
    }

    public function test_exact_tag_scope_unknown_boundary_private_access_and_no_name_inference(): void
    {
        $reader = app(OsmParkReader::class);
        $rows = [$this->node(1), $this->node(2, ['access' => 'private']), $this->node(3, ['landuse' => 'cemetery']), $this->node(4, ['amenity' => 'grave_yard']), $this->node(5, ['closed' => 'yes']),
            $this->node(6, ['leisure' => 'garden', 'name' => 'Сквер']), $this->node(7, ['leisure' => 'none', 'landuse' => 'grass', 'name' => 'Парк']), $this->node(8, ['leisure' => 'none', 'natural' => 'wood'])];
        $this->assertSame(['osm:node:1', 'osm:node:2'], array_column($reader->rows(['elements' => $rows]), 'source_id'));
        $this->import(array_slice($rows, 0, 5));
        $poi = $this->response()['blocks']['poi'];
        $this->assertSame(2, $poi['data']['counts_by_category']['park']);
        $this->assertStringContainsString('границы неизвестны', $poi['data']['items'][0]['limitations']);
        $this->assertNull($poi['data']['items'][0]['name']);
        $this->assertNull($poi['data']['items'][0]['observed_at']);
        $this->assertSame('private', $poi['data']['items'][1]['access']);
    }

    public function test_full_geometry_selection_marker_outside_circle_inside_zero_and_independent_nested_park(): void
    {
        $long = $this->way(10, [[92.999, 55.9999], [93.1, 55.9999], [93.1, 56.0001], [92.999, 56.0001], [92.999, 55.9999]]);
        $nested = $this->way(11, [[92.9999, 55.99995], [93.0001, 55.99995], [93.0001, 56.00005], [92.9999, 56.00005], [92.9999, 55.99995]]);
        $this->import([$long, $nested]);
        $items = $this->response()['blocks']['poi']['data']['items'];
        $this->assertCount(2, $items);
        $this->assertSame(0.0, (float) $items[0]['distance_m']);
        $this->assertGreaterThan(93.01, $items[0]['point']['lon']);
        $this->assertSame(array_map(fn ($p) => [$p['lon'], $p['lat']], $long['geometry']), $items[0]['geometry']['coordinates'][0]);
        $this->assertStringContainsString('не до входа', $items[0]['limitations']);
    }

    public function test_multipolygon_components_outer_aliases_hole_and_nested_relation_refusal(): void
    {
        $a = $this->way(10, [[92.999, 55.999], [93.002, 55.999], [93.002, 56.002], [92.999, 56.002], [92.999, 55.999]]);
        $b = $this->way(11, [[93.01, 56], [93.012, 56], [93.012, 56.002], [93.01, 56.002], [93.01, 56]]);
        $hole = $this->way(12, [[92.9998, 55.9998], [93.0002, 55.9998], [93.0002, 56.0002], [92.9998, 56.0002], [92.9998, 55.9998]]);
        $relation = ['type' => 'relation', 'id' => 30, 'tags' => ['leisure' => 'park', 'type' => 'multipolygon', 'name' => 'Composite'], 'members' => []];
        foreach ([[$a, 'outer'], [$b, 'outer'], [$hole, 'inner']] as [$way,$role]) {
            $relation['members'][] = ['type' => 'way', 'ref' => $way['id'], 'role' => $role, 'geometry' => $way['geometry']];
        }
        $result = $this->import([$a, $b, $relation]);
        $this->assertCount(2, $result['report']['duplicate_representations']);
        $poi = $this->response()['blocks']['poi'];
        $this->assertSame(1, $poi['data']['counts_by_category']['park']);
        $this->assertCount(1, $poi['data']['items']);
        $this->assertSame('osm:relation:30', $poi['data']['items'][0]['id']);
        $this->assertCount(2, $poi['data']['items'][0]['geometry']['coordinates']);
        $this->assertGreaterThan(0, $poi['data']['items'][0]['distance_m']); // The circle centre is in a hole.
        $this->assertSame(0.0, (float) $this->response(93.001)['blocks']['poi']['data']['items'][0]['distance_m']);
        $relation['id'] = 31;
        $relation['members'] = [['type' => 'relation', 'ref' => 30, 'role' => 'outer']];
        try {
            $this->import([$relation]);
            $this->fail('Nested relation was silently accepted');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('unsupported', $e->getMessage());
        }
        $this->assertSame($result['import_id'], DB::table('dataset_imports')->where('dataset_key', 'park')->where('is_active', true)->value('id'));
    }

    public function test_200_1000_boundary_touches_zero_partial_missing_coverage_and_error(): void
    {
        $rows = [$this->node(1)];
        foreach ([200, 200.001, 1000, 1000.001] as $i => $d) {
            $p = DB::selectOne('SELECT ST_AsGeoJSON(ST_Project(ST_SetSRID(ST_MakePoint(93,56),4326)::geography,?::double precision,0::double precision)::geometry,15) p', [$d]);
            [$lon,$lat] = json_decode($p->p, true)['coordinates'];
            $rows[] = $this->node(10 + $i, [], $lon, $lat);
            if ($i === 0) {
                $rows[] = $this->way(20, [[$lon, $lat], [$lon + .001, $lat + .002], [$lon - .001, $lat + .002], [$lon, $lat]]);
            }
        }
        $result = $this->import($rows);
        foreach ([200 => ['osm:node:10', 'osm:way:20'], 1000 => ['osm:node:12', 'osm:way:20']] as $radius => $ids) {
            $items = $this->response(93, 56, $radius)['blocks']['poi']['data']['items'];
            foreach ($ids as $id) {
                $this->assertContains($id, array_column($items, 'id'));
            }$this->assertNotContains('osm:node:'.($radius === 200 ? '11' : '13'), array_column($items, 'id'));
        }
        $this->assertSame(0, $this->response(93.2)['blocks']['poi']['data']['counts_by_category']['park']);
        $partial = $this->response(92.0001, 56, 1000)['blocks']['poi'];
        $this->assertSame('PARTIAL', $partial['coverage']['by_category']['park']['status']);
        $this->assertNull($partial['data']['counts_by_category']['park']);
        DB::table('dataset_coverages')->where('dataset_import_id', $result['import_id'])->delete();
        $unknown = $this->response()['blocks']['poi'];
        $this->assertSame('UNKNOWN', $unknown['coverage']['by_category']['park']['status']);
        $this->assertNull($unknown['data']['counts_by_category']['park']);
        config(['place_analysis.parks_enabled' => false]);
        $this->assertSame('PARK_NOT_ENABLED', $this->response()['blocks']['poi']['availability_by_category']['park']['code']);
        config(['place_analysis.parks_enabled' => true]);
        $this->mock(ParkPoiProvider::class, fn ($m) => $m->shouldReceive('analyze')->andThrow(new RuntimeException('PRIVATE_PARK_CANARY')));
        $error = $this->response()['blocks']['poi'];
        $this->assertSame('ERROR', $error['availability_by_category']['park']['status']);
        $this->assertStringNotContainsString('PRIVATE_PARK_CANARY', json_encode($error));
    }

    public function test_scope_rules_and_relation_audit_refuse_incomplete_publication(): void
    {
        $first = $this->import([$this->node(1)]);
        $document = json_decode(file_get_contents($this->directory.'/park.json'), true);
        $original = $document['preparation'];
        $bad = [];
        $rules = $original;
        $rules['rules']['park']['leisure'] = ['park', 'garden'];
        $bad[] = $rules;
        $scope = $original;
        $scope['bbox'] = [92, 55, 93, 57];
        $scope['extraction_geometry']['coordinates'][0] = [[92, 55], [93, 55], [93, 57], [92, 57], [92, 55]];
        $bad[] = $scope;
        $audit = $original;
        $audit['relation_audit'] = ['selected_count' => 1, 'outcomes' => [['source_id' => 'osm:relation:20', 'status' => 'rejected', 'reason' => 'unsupported_node_or_nested_member']]];
        $bad[] = $audit;
        foreach ($bad as $p) {
            try {
                $this->import([$this->node(1)], $p);
                $this->fail('Incomplete scope admitted');
            } catch (RuntimeException $error) {
                $this->assertNotEmpty($error->getMessage());
            }
            $this->assertSame($first['import_id'], DB::table('dataset_imports')->where('dataset_key', 'park')->where('is_active', true)->value('id'));
        }
    }

    public function test_real_prepared_parks_and_other_three_categories_are_unchanged(): void
    {
        if (! ($file = getenv('A8_PARK_FILE'))) {
            $this->markTestSkipped('Explicit prepared park fixture required.');
        }
        $boundary = base_path('data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson');
        $g = app(OsmGroceryImporter::class)->import(base_path('data/prepared/grocery/a8-scope-v2-20261104-01/grocery.json'), $boundary);
        $p = app(OsmPharmacyImporter::class)->import(base_path('data/prepared/pharmacy/a8-pharmacy-v2-20261105-01/pharmacy.json'), $boundary);
        $s = app(OfficialStopsImporter::class)->import(base_path('data/raw/transport_stops/2025-05-31/stops.csv'), $boundary, ['buffer_m' => 1000, 'source_version' => '20250531T1612', 'source_updated_at' => '2025-05-31']);
        $point = ['lon' => 92.855136533542, 'lat' => 56.011162843471];
        $before = $this->response($point['lon'], $point['lat'], 1000)['blocks']['poi']['data']['items'];
        $result = app(OsmParkImporter::class)->import($file, $boundary);
        $this->assertGreaterThan(0, $result['report']['accepted_objects']);
        foreach ([200, 1000] as $radius) {
            $response = $this->response($point['lon'], $point['lat'], $radius);
            $poi = $response['blocks']['poi'];
            $parks = array_values(array_filter($poi['data']['items'], fn ($i) => $i['category'] === 'park'));
            $this->assertNotEmpty($parks);
            if ($radius === 1000) {
                $this->assertSame($before, array_values(array_filter($poi['data']['items'], fn ($i) => $i['category'] !== 'park')));
            }
            if ($dir = getenv('A8_PARK_QA_DIR')) {
                $stream = fopen($dir.'/test-api-'.$radius.'.json', 'x');
                fwrite($stream, json_encode(['environment' => 'web_gis_test_rolled_back', 'request' => ['place' => ['kind' => 'point'] + $point, 'radius_m' => $radius, 'blocks' => ['poi']], 'response' => $response], JSON_UNESCAPED_UNICODE));
                fclose($stream);
            }
        }
        foreach ([['grocery', $g['import_id']], ['pharmacy', $p['import_id']], [OfficialStopsImporter::DATASET, $s['import_id']]] as [$key,$id]) {
            $this->assertSame($id, DB::table('dataset_imports')->where('dataset_key', $key)->where('is_active', true)->value('id'));
        }
        $sourceRows = app(OsmParkReader::class)->rows(app(OsmParkReader::class)->read(file_get_contents($file)));
        $anchors = ['osm:way:31825878', 'osm:relation:3989139', 'osm:relation:3301398', 'osm:node:11553373159', 'osm:node:14008066605'];
        foreach ($anchors as $sourceId) {
            $original = collect($sourceRows)->firstWhere('source_id', $sourceId);
            $saved = DB::table('osm_park')->where('dataset_import_id', $result['import_id'])->where('source_id', $sourceId)->first();
            $this->assertNotNull($saved, $sourceId);
            $this->assertSame($original['name'], $saved->name);
            $same = DB::selectOne('SELECT ST_Equals(geom,ST_GeomFromGeoJSON(?)) ok FROM osm_park WHERE dataset_import_id=? AND source_id=?', [json_encode($original['geometry']), $result['import_id'], $sourceId]);
            $this->assertTrue($same->ok);
        }
        $this->assertFalse(DB::table('osm_park')->where('dataset_import_id', $result['import_id'])->where('source_id', 'osm:way:31959413')->exists());
        $pointPark = collect($this->response(92.6817087, 56.0237065)['blocks']['poi']['data']['items'])->firstWhere('id', 'osm:node:11553373159');
        $this->assertNotNull($pointPark);
        $this->assertSame('Point', $pointPark['geometry']['type']);
        $this->assertSame(0.0, (float) $pointPark['distance_m']);
        $this->assertStringContainsString('границы неизвестны', $pointPark['limitations']);

        $review = DB::select("SELECT source_id,name,ST_GeometryType(geom) geometry_type,raw_data->'tags' tags FROM osm_park WHERE dataset_import_id=? ORDER BY name NULLS LAST,source_id LIMIT 8", [$result['import_id']]);
        $this->mock(ParkPoiProvider::class, fn ($m) => $m->shouldReceive('analyze')->andThrow(new RuntimeException('PRIVATE_PARK_CANARY')));
        $error = $this->response($point['lon'], $point['lat'], 1000)['blocks']['poi'];
        $this->assertSame('READY', $error['status']);
        $this->assertSame($before, $error['data']['items']);
        if ($dir = getenv('A8_PARK_QA_DIR')) {
            $stream = fopen($dir.'/test-import-report.json', 'x');
            fwrite($stream, json_encode(['import' => $result, 'source_review' => $review], JSON_UNESCAPED_UNICODE));
            fclose($stream);
        }
    }
}
