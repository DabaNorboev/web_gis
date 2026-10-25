<?php

namespace Tests\Integration;

use App\Services\Transport\Import\OfficialStopsImporter;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class TransportAnalysisTest extends TestCase
{
    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || DB::connection()->getDatabaseName() !== 'web_gis_test') {
            throw new RuntimeException('Transport API tests require web_gis_test.');
        }
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        $this->directory = sys_get_temp_dir().'/web-gis-api-'.bin2hex(random_bytes(8));
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

    public function test_distances_radius_and_distinct_routes_use_only_active_snapshot(): void
    {
        $rows = [
            ['1', 'Ближайшая', 'Автобус', '12,23', '', '92.9', '56.0001'],
            ['2', 'Ближайшая', 'Автобус', '12', '', '92.9', '56.003'],
            ['3', 'Далеко', 'Автобус', '99', '', '92.9', '56.02'],
        ];
        $old = $this->import($rows);
        $active = $this->import($rows, ['source_version' => 'new', 'observed_at' => '2025-05-01']);
        $response = $this->getJson('/api/v1/transport/analysis?lon=92.9&lat=56')->assertOk()
            ->assertJsonPath('nearest_stop.source_id', '1')
            ->assertJsonPath('nearest_stop.dataset_import_id', $active['import_id'])
            ->assertJsonPath('metrics.stops_count.value', 2)
            ->assertJsonPath('metrics.unique_routes_count.value', 2)
            ->assertJsonPath('metrics.unique_routes_count.quality.availability', 'AVAILABLE')
            ->assertJsonPath('metrics.stops_count.observed_at', '2025-05-01T00:00:00+00:00')
            ->assertJsonPath('metrics.stops_count.quality.freshness', 'UNKNOWN')
            ->assertJsonPath('radius_m', 500)
            ->assertJsonCount(2, 'stops_in_radius')
            ->assertJsonPath('stops_in_radius.0.source_id', '1')
            ->assertJsonPath('stops_in_radius.1.source_id', '2')
            ->assertJsonPath('stops_in_radius.0.name', 'Ближайшая')
            ->assertJsonPath('stops_in_radius.1.name', 'Ближайшая')
            ->assertJsonPath('stops_in_radius.0.lon', 92.9)
            ->assertJsonPath('stops_in_radius.0.lat', 56.0001);
        $geometry = $response->json('analysis_area');
        $this->assertSame('Polygon', $geometry['type']);
        $coverage = DB::selectOne('SELECT ST_Covers(ST_SetSRID(ST_GeomFromGeoJSON(?),4326), ST_SetSRID(ST_MakePoint(92.9,56),4326)) AS covers', [json_encode($geometry)]);
        $this->assertTrue($coverage->covers);
        foreach ($geometry['coordinates'][0] as [$lon, $lat]) {
            $vertex = DB::selectOne('SELECT ST_Distance(ST_SetSRID(ST_MakePoint(?,?),4326)::geography, ST_SetSRID(ST_MakePoint(92.9,56),4326)::geography) AS meters', [$lon, $lat]);
            $this->assertEqualsWithDelta(500, $vertex->meters, 2);
        }
        $distance = $response->json('metrics.nearest_stop_distance.value');
        $this->assertGreaterThan(11, $distance);
        $this->assertLessThan(12, $distance);
        $this->assertCount(2, $response->json('route_details.identified'));
        foreach ($response->json('metrics') as $metric) {
            $this->assertEquals($active['import_id'], $metric['dataset_import_id']);
            $this->assertNotEquals($old['import_id'], $metric['dataset_import_id']);
            $this->assertSame('DERIVED', $metric['quality']['method']);
            $this->assertNotEmpty($metric['calculated_at']);
        }
    }

    public function test_unknown_and_unparsed_routes_leave_total_unavailable_but_preserve_partial_count(): void
    {
        $this->import([['1', 'Рядом', 'Автобус и троллейбус', '12,6,экспресс', '', '92.9', '56.001']]);
        $this->getJson('/api/v1/transport/analysis?lon=92.9&lat=56')->assertOk()
            ->assertJsonPath('metrics.unique_routes_count.value', null)
            ->assertJsonPath('metrics.unique_routes_count.quality.availability', 'INSUFFICIENT_DATA')
            ->assertJsonPath('metrics.unique_routes_count.quality.method', null)
            ->assertJsonPath('metrics.identified_routes_count.value', 1)
            ->assertJsonPath('route_details.unresolved_keys.0', 'unknown:6')
            ->assertJsonPath('route_details.incomplete_stop_source_ids.0', '1')
            ->assertJsonPath('route_details.catalog.captured_at', '2026-10-10')
            ->assertJsonPath('metrics.stops_count.observed_at', null);
    }

    public function test_missing_route_list_is_not_a_real_zero(): void
    {
        $this->import([['1', 'Без маршрутов', '-', '', '', '92.9', '56.001']]);
        $this->getJson('/api/v1/transport/analysis?lon=92.9&lat=56')->assertOk()
            ->assertJsonPath('metrics.stops_count.value', 1)
            ->assertJsonPath('metrics.unique_routes_count.value', null)
            ->assertJsonPath('metrics.identified_routes_count.value', 0)
            ->assertJsonPath('route_details.incomplete_stop_source_ids.0', '1');
    }

    public function test_source_type_conflict_is_exposed_as_incomplete_data(): void
    {
        $this->import([['1', 'Ошибка исходника', 'троллейбус', '12', '', '92.9', '56.001']]);
        $this->getJson('/api/v1/transport/analysis?lon=92.9&lat=56')->assertOk()
            ->assertJsonPath('metrics.unique_routes_count.quality.availability', 'INSUFFICIENT_DATA')
            ->assertJsonPath('metrics.identified_routes_count.value', 1);
    }

    public function test_no_active_dataset_returns_null_values_with_metadata(): void
    {
        $this->import([['1', 'Архив', 'Автобус', '12', '', '92.9', '56']]);
        DB::table('dataset_imports')->update(['is_active' => false]);
        $response = $this->getJson('/api/v1/transport/analysis?lon=92.9&lat=56')->assertOk()
            ->assertJsonPath('nearest_stop', null)->assertJsonPath('route_details', null)
            ->assertJsonPath('analysis_area.type', 'Polygon')->assertJsonPath('stops_in_radius', []);
        foreach ($response->json('metrics') as $metric) {
            $this->assertNull($metric['value']);
            $this->assertNull($metric['dataset_import_id']);
            $this->assertNull($metric['quality']['method']);
            $this->assertSame('UNAVAILABLE', $metric['quality']['availability']);
        }
    }

    public function test_no_stops_in_radius_is_zero_for_the_dataset_and_nearest_can_be_farther(): void
    {
        $this->import([['1', 'Далеко', 'Автобус', '12', '', '92.9', '56.02']]);
        $response = $this->getJson('/api/v1/transport/analysis?lon=92.9&lat=56')->assertOk()
            ->assertJsonPath('stops_in_radius', [])
            ->assertJsonPath('metrics.stops_count.value', 0)
            ->assertJsonPath('metrics.unique_routes_count.value', 0)
            ->assertJsonPath('metrics.unique_routes_count.quality.availability', 'AVAILABLE');
        $this->assertGreaterThan(2000, $response->json('metrics.nearest_stop_distance.value'));
    }

    public function test_radius_boundary_includes_499_meters_and_excludes_501_meters(): void
    {
        $rows = [];
        foreach ([499, 501] as $meters) {
            $point = DB::selectOne('SELECT ST_Y(ST_Project(ST_SetSRID(ST_MakePoint(92.9, 56),4326)::geography, ?::double precision, 0::double precision)::geometry) AS lat', [$meters]);
            $rows[] = [(string) $meters, 'Граница радиуса', 'Автобус', '12', '', '92.9', (string) $point->lat];
        }
        $this->import($rows);
        $this->getJson('/api/v1/transport/analysis?lon=92.9&lat=56')->assertOk()
            ->assertJsonPath('metrics.stops_count.value', 1)
            ->assertJsonPath('nearest_stop.source_id', '499')
            ->assertJsonCount(1, 'stops_in_radius')->assertJsonPath('stops_in_radius.0.source_id', '499');
    }

    public function test_invalid_coordinates_return_json_validation_errors(): void
    {
        foreach (['lon=92.9', 'lon=181&lat=56', 'lon=92&lat=-91', 'lon=NaN&lat=56', 'lon[]=92&lat=56'] as $query) {
            $this->getJson('/api/v1/transport/analysis?'.$query)->assertUnprocessable()->assertJsonStructure(['message', 'errors']);
        }
    }

    public function test_selectable_radii_sort_by_exact_distance_and_preserve_input_point(): void
    {
        $rows = [];
        foreach ([900, 200, 450] as $meters) {
            $point = DB::selectOne('SELECT ST_Y(ST_Project(ST_SetSRID(ST_MakePoint(92.9,56),4326)::geography, ?::double precision, 0::double precision)::geometry) AS lat', [$meters]);
            $rows[] = [(string) $meters, 'Остановка', 'Автобус', '12', '', '92.9', (string) $point->lat];
        }
        $this->import($rows);
        foreach ([300 => ['200'], 500 => ['200', '450']] as $radius => $ids) {
            $response = $this->getJson('/api/v1/transport/analysis?lon=92.9&lat=56&radius_m='.$radius)->assertOk()
                ->assertJsonPath('radius_m', $radius)->assertJsonPath('point.lon', 92.9)
                ->assertJsonPath('point.lat', 56)->assertJsonPath('metrics.stops_count.value', count($ids));
            $this->assertSame($ids, array_column($response->json('stops_in_radius'), 'source_id'));
            $ring = $response->json('analysis_area.coordinates.0');
            $bounds = $response->json('analysis_bounds');
            $expected = [min(array_column($ring, 0)), min(array_column($ring, 1)), max(array_column($ring, 0)), max(array_column($ring, 1))];
            foreach ($expected as $index => $coordinate) {
                $this->assertEqualsWithDelta($coordinate, $bounds[$index], 0.00000001);
            }
            $this->assertTrue($bounds[0] < 92.9 && $bounds[2] > 92.9 && $bounds[1] < 56 && $bounds[3] > 56);
            foreach ($response->json('stops_in_radius') as $stop) {
                $this->assertEqualsWithDelta((float) $stop['source_id'], $stop['distance_m'], 0.05);
            }
            foreach ($response->json('analysis_area.coordinates.0') as [$lon, $lat]) {
                $distance = DB::selectOne('SELECT ST_Distance(ST_SetSRID(ST_MakePoint(?,?),4326)::geography, ST_SetSRID(ST_MakePoint(92.9,56),4326)::geography) AS meters', [$lon, $lat]);
                $this->assertEqualsWithDelta($radius, $distance->meters, 3);
            }
        }
        foreach (['0', '400', '1000', '1001', '300.5', 'abc', ''] as $radius) {
            $this->getJson('/api/v1/transport/analysis?lon=92.9&lat=56&radius_m='.$radius)->assertUnprocessable();
        }
    }

    public function test_outside_service_area_is_distinct_from_no_stops_and_from_a_missing_source(): void
    {
        $this->import([['1', 'В городе', 'Автобус', '12', '', '92.9', '56']]);
        $response = $this->getJson('/api/v1/transport/analysis?lon=37.62&lat=55.75')->assertOk()
            ->assertJsonPath('coverage.status', 'OUTSIDE_SERVICE_AREA')
            ->assertJsonPath('nearest_stop', null)->assertJsonPath('stops_in_radius', [])
            ->assertJsonPath('route_details', null);
        foreach ($response->json('metrics') as $metric) {
            $this->assertNull($metric['value']);
            $this->assertNull($metric['quality']['method']);
            $this->assertSame('UNAVAILABLE', $metric['quality']['availability']);
            $this->assertStringContainsString('вне территории сервиса', $metric['quality']['reason']);
        }
    }

    public function test_buffer_includes_external_stops_without_expanding_service_and_preserves_old_snapshot(): void
    {
        file_put_contents($this->directory.'/boundary.json', '{"type":"Polygon","coordinates":[[[92.89,55.99],[92.91,55.99],[92.91,56.01],[92.89,56.01],[92.89,55.99]]]}');
        $rows = [['1', 'Внутри', 'Автобус', '12', '', '92.9', '56'], ['2', 'За границей', 'Автобус', '23', '', '92.911', '56']];
        $old = $this->import($rows);
        $this->getJson('/api/v1/transport/analysis?lon=92.909&lat=56')->assertOk()
            ->assertJsonPath('coverage.status', 'PARTIAL')
            ->assertJsonPath('metrics.stops_count.value', null)
            ->assertJsonPath('metrics.stops_count.quality.availability', 'INSUFFICIENT_DATA')
            ->assertJsonPath('metrics.nearest_stop_distance.value', null);
        $new = $this->import($rows, ['buffer_m' => 1000]);
        $this->getJson('/api/v1/transport/analysis?lon=92.909&lat=56')->assertOk()
            ->assertJsonPath('coverage.status', 'COVERED')->assertJsonPath('coverage.buffer_m', 1000)
            ->assertJsonPath('nearest_stop.source_id', '2')->assertJsonPath('metrics.stops_count.value', 1)
            ->assertJsonPath('metrics.unique_routes_count.value', 1);
        $this->getJson('/api/v1/transport/analysis?lon=92.911&lat=56')->assertOk()
            ->assertJsonPath('coverage.status', 'OUTSIDE_SERVICE_AREA')->assertJsonPath('metrics.stops_count.value', null);
        // An exact point on the service boundary is included, with the whole radius covered by the buffer.
        $this->getJson('/api/v1/transport/analysis?lon=92.91&lat=56')->assertOk()
            ->assertJsonPath('coverage.status', 'COVERED')->assertJsonPath('nearest_stop.source_id', '2');
        $this->assertSame(1, DB::table('transport_stops')->where('dataset_import_id', $old['import_id'])->count());
        $this->assertSame(2, DB::table('transport_stops')->where('dataset_import_id', $new['import_id'])->count());
        $this->assertFalse(DB::table('dataset_imports')->find($old['import_id'])->is_active);
        $this->assertSame(2, DB::table('dataset_coverages')->count());
    }

    public function test_unknown_coverage_never_claims_zero_or_a_nearest_stop(): void
    {
        $result = $this->import([['1', 'В городе', 'Автобус', '12', '', '92.9', '56']]);
        DB::table('dataset_coverages')->where('dataset_import_id', $result['import_id'])->delete();
        $this->getJson('/api/v1/transport/analysis?lon=92.9&lat=56')->assertOk()
            ->assertJsonPath('coverage.status', 'UNKNOWN')->assertJsonPath('metrics.stops_count.value', null)
            ->assertJsonPath('nearest_stop', null)->assertJsonPath('stops_in_radius', []);
    }

    private function import(array $rows, array $options = []): array
    {
        $file = $this->directory.'/stops.csv';
        $handle = fopen($file, 'w');
        fputcsv($handle, ['id', 'name', 'type_transport', 'num_route', 'address', 'the_geom_lon', 'the_geom_lat'], escape: '');
        foreach ($rows as $row) {
            fputcsv($handle, $row, escape: '');
        }
        fclose($handle);

        return app(OfficialStopsImporter::class)->import($file, $this->directory.'/boundary.json', $options);
    }
}
