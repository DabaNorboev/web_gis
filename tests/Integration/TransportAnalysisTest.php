<?php

namespace Tests\Integration;

use App\Services\Transport\Import\OfficialStopsImporter;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\TestCase;

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
            ['2', 'Рядом', 'Автобус', '12', '', '92.9', '56.003'],
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
            ->assertJsonPath('radius_m', 500);
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
            ->assertJsonPath('nearest_stop', null)->assertJsonPath('route_details', null);
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
            ->assertJsonPath('nearest_stop.source_id', '499');
    }

    public function test_invalid_coordinates_return_json_validation_errors(): void
    {
        foreach (['lon=92.9', 'lon=181&lat=56', 'lon=92&lat=-91', 'lon=NaN&lat=56', 'lon[]=92&lat=56'] as $query) {
            $this->getJson('/api/v1/transport/analysis?'.$query)->assertUnprocessable()->assertJsonStructure(['message', 'errors']);
        }
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
