<?php

namespace Tests\Integration;

use App\Services\Analysis\OfficialStopPoiProvider;
use App\Services\Osm\Import\OsmGroceryImporter;
use App\Services\Osm\Import\OsmPharmacyImporter;
use App\Services\Transport\Import\OfficialStopsCsvReader;
use App\Services\Transport\Import\OfficialStopsImporter;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase;

class OfficialStopPoiTest extends PostgisTestCase
{
    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        DB::table('dataset_imports')->whereIn('dataset_key', ['grocery', 'pharmacy', OfficialStopsImporter::DATASET])->update(['is_active' => false]);
        config(['place_analysis.official_stops_enabled' => true]);
        $this->directory = sys_get_temp_dir().'/official-stop-poi-'.bin2hex(random_bytes(6));
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

    private function import(array $rows, array $options = []): array
    {
        $file = $this->directory.'/stops.csv';
        $stream = fopen($file, 'w');
        fputcsv($stream, ['id', 'name', 'type_transport', 'num_route', 'address', 'the_geom_lon', 'the_geom_lat'], escape: '');
        foreach ($rows as $row) {
            fputcsv($stream, [$row[0], $row[1], 'Автобус', '12', $row[4] ?? '', $row[2], $row[3]], escape: '');
        }
        fclose($stream);

        return app(OfficialStopsImporter::class)->import($file, $this->directory.'/boundary.json', $options + ['source_version' => 'fixture-version', 'source_updated_at' => '2025-05-31']);
    }

    private function response(float $lon = 93, float $lat = 56, int $radius = 200): array
    {
        return $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'point', 'lon' => $lon, 'lat' => $lat], 'radius_m' => $radius, 'blocks' => ['poi']])->assertOk()->json();
    }

    public function test_full_circle_same_names_distinct_ids_and_exact_200_1000_metre_boundaries(): void
    {
        $rows = [['a', 'Same', 93, 56], ['b', 'Same', 93.00001, 56]];
        foreach ([200, 200.001, 1000, 1000.001] as $i => $distance) {
            $p = DB::selectOne('SELECT ST_AsGeoJSON(ST_Project(ST_SetSRID(ST_MakePoint(93,56),4326)::geography,?::double precision,0::double precision)::geometry,15) point', [$distance]);
            [$lon,$lat] = json_decode($p->point, true)['coordinates'];
            $rows[] = ['edge-'.$i, 'Same', $lon, $lat];
        }
        $old = $this->import($rows);
        $active = $this->import($rows, ['source_version' => 'new']);
        foreach ([200 => ['a', 'b', 'edge-0'], 1000 => ['a', 'b', 'edge-0', 'edge-1', 'edge-2']] as $radius => $ids) {
            $poi = $this->response(93, 56, $radius)['blocks']['poi'];
            $this->assertSame('READY', $poi['status']);
            $this->assertSame(array_map(fn ($id) => 'official-stop:'.$id, $ids), array_column($poi['data']['items'], 'id'));
            $this->assertSame(count($ids), $poi['data']['counts_by_category']['official_stop']);
            $this->assertSame(count($ids), $poi['data']['official_stop_summary']['found_count']);
            foreach ($poi['data']['items'] as $item) {
                $this->assertSame($active['import_id'], $item['dataset_import_id']);
                $this->assertSame('Same', $item['name']);
                $this->assertSame('official-stops', $item['source']);
                $this->assertSame('Point', $item['geometry']['type']);
                $this->assertSame('new', $item['source_version']);
                $this->assertNull($item['observed_at']);
            }
            $last = end($poi['data']['items']);
            $this->assertEqualsWithDelta($radius, $last['distance_m'], 0.0000001);
        }
        $this->assertFalse((bool) DB::table('dataset_imports')->where('id', $old['import_id'])->value('is_active'));
    }

    public function test_disabled_missing_snapshot_missing_coverage_zero_partial_outside_and_unlocated_rows(): void
    {
        $result = $this->import([['1', 'One', 93, 56]]);
        config(['place_analysis.official_stops_enabled' => false]);
        $disabled = $this->response()['blocks']['poi'];
        $this->assertSame('OFFICIAL_STOP_NOT_ENABLED', $disabled['availability_by_category']['official_stop']['code']);
        // Existing transport API remains available and retains its own radius contract.
        $this->getJson('/api/v1/transport/analysis?lon=93&lat=56&radius_m=300')->assertOk()->assertJsonCount(1, 'stops_in_radius');
        config(['place_analysis.official_stops_enabled' => true]);
        $zero = $this->response(93.1)['blocks']['poi'];
        $this->assertSame(0, $zero['data']['counts_by_category']['official_stop']);
        $this->assertSame(0, $zero['data']['official_stop_summary']['found_count']);
        $partial = $this->response(92.0001, 56, 1000)['blocks']['poi'];
        $this->assertSame('PARTIAL', $partial['coverage']['by_category']['official_stop']['status']);
        $this->assertNull($partial['data']['counts_by_category']['official_stop']);
        $outside = $this->response(0, 0)['blocks']['poi'];
        $this->assertSame('OUTSIDE_SERVICE_AREA', $outside['coverage']['by_category']['official_stop']['status']);
        $this->assertSame([], $outside['data']['items']);
        $this->assertNull($outside['data']['counts_by_category']['official_stop']);
        $this->assertNull($outside['data']['official_stop_summary']['found_count']);
        DB::table('dataset_coverages')->where('dataset_import_id', $result['import_id'])->delete();
        $missing = $this->response()['blocks']['poi'];
        $this->assertSame('OFFICIAL_STOP_COVERAGE_UNAVAILABLE', $missing['availability_by_category']['official_stop']['code']);
        DB::table('dataset_imports')->where('id', $result['import_id'])->update(['is_active' => false]);
        // An OSM snapshot with the same dataset key is never an official fallback.
        $foreign = (array) DB::table('dataset_imports')->where('id', $result['import_id'])->first();
        unset($foreign['id']);
        $foreign['source'] = 'OpenStreetMap';
        $foreign['is_active'] = true;
        DB::table('dataset_imports')->insert($foreign);
        $this->assertSame('OFFICIAL_STOP_SNAPSHOT_UNAVAILABLE', $this->response()['blocks']['poi']['availability_by_category']['official_stop']['code']);
        $this->import([['1', 'One', 93, 56], ['2', 'Unlocated', '', '']]);
        $incomplete = $this->response(93.1)['blocks']['poi'];
        $this->assertSame('PARTIAL', $incomplete['completeness']['by_category']['official_stop']['status']);
        $this->assertNull($incomplete['data']['counts_by_category']['official_stop']);
        $this->assertSame(['found_count' => 0, 'source_without_coordinates' => 1], $incomplete['data']['official_stop_summary']);
    }

    public function test_error_is_not_a_zero_and_does_not_echo_private_exception(): void
    {
        $this->mock(OfficialStopPoiProvider::class, fn ($mock) => $mock->shouldReceive('analyze')->andThrow(new RuntimeException('PRIVATE_STOP_CANARY')));
        $poi = $this->response()['blocks']['poi'];
        $this->assertSame('ERROR', $poi['status']);
        $this->assertSame('ERROR', $poi['availability_by_category']['official_stop']['status']);
        $this->assertNull($poi['data']);
        $this->assertStringNotContainsString('PRIVATE_STOP_CANARY', json_encode($poi));
    }

    public function test_real_existing_csv_snapshot_and_other_categories_are_preserved(): void
    {
        if (! ($file = getenv('A8_OFFICIAL_STOPS_FILE'))) {
            $this->markTestSkipped('Explicit official CSV fixture required.');
        }
        $this->assertSame('7ef6db18c365078c9db8e8b5fdeffb7e654e9249012d8aa35d6d6e2900a12e2c', hash_file('sha256', $file));
        $boundary = base_path('data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson');
        $grocery = app(OsmGroceryImporter::class)->import(base_path('data/prepared/grocery/a8-scope-v2-20261104-01/grocery.json'), $boundary);
        $pharmacy = app(OsmPharmacyImporter::class)->import(base_path('data/prepared/pharmacy/a8-pharmacy-v2-20261105-01/pharmacy.json'), $boundary);
        $base = $this->response(92.855136533542, 56.011162843471, 1000)['blocks']['poi']['data']['items'];
        $result = app(OfficialStopsImporter::class)->import($file, $boundary, ['buffer_m' => 1000, 'source_version' => '20250531T1612', 'source_updated_at' => '2025-05-31']);
        $this->assertSame(1176, $result['report']['accepted_stops']);
        $this->assertSame(['2219', '2220'], $result['report']['invalid_coordinates']);
        $this->assertSame(663, DB::table('osm_grocery')->where('dataset_import_id', $grocery['import_id'])->count());
        $this->assertSame(158, DB::table('osm_pharmacy')->where('dataset_import_id', $pharmacy['import_id'])->count());
        $source = app(OfficialStopsCsvReader::class)->read(file_get_contents($file));
        $anchors = ['3965', '3966', '3970', '3971', '3972'];
        $review = [];
        foreach ($anchors as $id) {
            $raw = collect($source)->firstWhere('source_id', $id);
            $saved = DB::table('transport_stops')->selectRaw('source_id,name,address,ST_X(geom) lon,ST_Y(geom) lat')->where('dataset_import_id', $result['import_id'])->where('source_id', $id)->first();
            $this->assertNotNull($saved, $id);
            $this->assertSame(trim($raw['raw']['name']) ?: null, $saved->name);
            $this->assertSame(trim($raw['raw']['address']) ?: null, $saved->address);
            $this->assertEqualsWithDelta($raw['lon'], (float) $saved->lon, 1e-12);
            $this->assertEqualsWithDelta($raw['lat'], (float) $saved->lat, 1e-12);
            $review[] = (array) $saved;
        }
        foreach ([200, 1000] as $radius) {
            $request = ['place' => ['kind' => 'point', 'lon' => 92.855136533542, 'lat' => 56.011162843471], 'radius_m' => $radius, 'blocks' => ['poi']];
            $response = $this->postJson('/api/v1/place-analysis', $request)->assertOk()->json();
            $poi = $response['blocks']['poi'];
            $stops = array_values(array_filter($poi['data']['items'], fn ($i) => $i['category'] === 'official_stop'));
            $this->assertSame(['found_count' => count($stops), 'source_without_coordinates' => 2], $poi['data']['official_stop_summary']);
            $this->assertContains('official-stop:3965', array_column($stops, 'id'));
            $this->assertContains('official-stop:3966', array_column($stops, 'id'));
            $this->assertSame('PARTIAL', $poi['completeness']['by_category']['official_stop']['status']);
            $this->assertNull($poi['data']['counts_by_category']['official_stop']);
            if ($radius === 1000) {
                $this->assertSame($base, array_values(array_filter($poi['data']['items'], fn ($i) => $i['category'] !== 'official_stop')));
            }
            if ($dir = getenv('A8_OFFICIAL_STOPS_QA_DIR')) {
                $stream = fopen($dir.'/test-api-'.$radius.'.json', 'x');
                fwrite($stream, json_encode(['environment' => 'web_gis_test_rolled_back', 'request' => $request, 'response' => $response], JSON_UNESCAPED_UNICODE));
                fclose($stream);
            }
        }
        $this->mock(OfficialStopPoiProvider::class, fn ($mock) => $mock->shouldReceive('analyze')->andThrow(new RuntimeException('PRIVATE_STOP_CANARY')));
        $error = $this->response(92.855136533542, 56.011162843471, 1000)['blocks']['poi'];
        $this->assertSame('READY', $error['status']);
        $this->assertSame('ERROR', $error['availability_by_category']['official_stop']['status']);
        $this->assertSame($base, $error['data']['items']);
        $this->assertNull($error['data']['counts_by_category']['official_stop']);
        if ($dir = getenv('A8_OFFICIAL_STOPS_QA_DIR')) {
            $stream = fopen($dir.'/test-import-report.json', 'x');
            fwrite($stream, json_encode(['import' => $result, 'manual_source_review' => $review], JSON_UNESCAPED_UNICODE));
            fclose($stream);
        }
    }
}
