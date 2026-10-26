<?php

namespace Tests\Integration;

use App\Services\Transport\Import\OfficialRouteNormalizer;
use App\Services\Transport\Import\OfficialStopsCsvReader;
use App\Services\Transport\Import\OfficialStopsImporter;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class OfficialStopsImportTest extends TestCase
{
    private string $directory;

    private string $csv;

    private string $boundary;

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || DB::connection()->getDatabaseName() !== 'web_gis_test') {
            throw new RuntimeException('Import tests require the dedicated web_gis_test PostgreSQL database.');
        }
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        $this->directory = sys_get_temp_dir().'/web-gis-import-'.bin2hex(random_bytes(8));
        mkdir($this->directory);
        $this->csv = $this->directory.'/stops.csv';
        $this->boundary = $this->directory.'/boundary.geojson';
        file_put_contents($this->boundary, json_encode(['type' => 'Polygon', 'coordinates' => [[[92.8, 56.0], [93.0, 56.0], [93.0, 56.2], [92.8, 56.2], [92.8, 56.0]]]]));
        $this->writeRows([
            ['1', 'Центр', 'Автобус', '12,12,23', 'Мира', '92.9', '56.1'],
            ['2', 'Граница', 'Автобус и тролейбус', '12,7т', '', '92.8', '56.1'],
            ['3', 'Вне города', 'Автобус', '12', '', '95', '56'],
            ['4', 'Нет координат', '-', '', '', '', ''],
        ]);
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

    public function test_import_preserves_raw_data_coordinates_and_uncertain_modes(): void
    {
        $result = $this->runImport(['source_updated_at' => '2025-05-31']);
        $this->assertSame('succeeded', $result['status']);
        $this->assertSame(2, $result['report']['accepted_stops']);
        $this->assertSame(1, $result['report']['outside_boundary']);
        $this->assertSame(['4'], $result['report']['invalid_coordinates']);
        $this->assertSame(3, $result['report']['routes']);
        $this->assertSame(4, $result['report']['stop_route_links']);
        $this->assertSame(0, $result['report']['unknown_routes']);
        $stop = DB::selectOne("SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat, ST_SRID(geom) AS srid, raw_data FROM transport_stops WHERE source_id = '1'");
        $this->assertEquals(92.9, $stop->lon);
        $this->assertEquals(56.1, $stop->lat);
        $this->assertEquals(4326, $stop->srid);
        $this->assertSame('12,12,23', json_decode($stop->raw_data, true)['num_route']);
        $import = DB::table('dataset_imports')->find($result['import_id']);
        $this->assertTrue($import->is_active);
        $this->assertNull($import->observed_at);
        $this->assertStringStartsWith('2025-05-31', $import->source_updated_at);
        $this->assertNotNull($import->finished_at);
    }

    public function test_repeated_input_does_not_duplicate_or_reactivate_an_old_snapshot(): void
    {
        $first = $this->runImport();
        $second = $this->runImport();
        $this->assertSame('skipped', $second['status']);
        $this->assertSame($first['import_id'], $second['import_id']);
        $this->assertEquals(1, DB::table('dataset_imports')->count());
        $this->assertEquals(2, DB::table('transport_stops')->count());
        $new = $this->runImport(['source_version' => 'new']);
        $again = $this->runImport();
        $this->assertSame('skipped', $again['status']);
        $this->assertEquals($new['import_id'], DB::table('dataset_imports')->where('is_active', true)->value('id'));
    }

    public function test_dry_run_and_command_do_not_write_any_data(): void
    {
        $this->artisan('transport:import-stops', ['file' => $this->csv, '--boundary' => $this->boundary, '--dry-run' => true])
            ->expectsOutputToContain('Status: dry-run')->assertSuccessful();
        $this->assertEquals(0, DB::table('dataset_imports')->count());
        $this->assertEquals(0, DB::table('transport_stops')->count());
    }

    public function test_database_failure_rolls_back_partial_rows_and_keeps_previous_snapshot(): void
    {
        $old = $this->runImport();
        DB::unprepared(<<<'SQL'
            CREATE FUNCTION pg_temp.reject_stop() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.source_id = 'fail-write' THEN RAISE EXCEPTION 'deliberate write failure'; END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER reject_import_stop BEFORE INSERT ON transport_stops
                FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_stop();
            SQL);
        $this->writeRows([
            ['new-first', 'Первый', 'Автобус', '99', '', '92.9', '56.1'],
            ['fail-write', 'Второй', 'Автобус', '99', '', '92.9', '56.1'],
        ]);
        try {
            $this->runImport();
            $this->fail('Database failure must propagate.');
        } catch (QueryException $error) {
            $this->assertStringContainsString('deliberate write failure', $error->getMessage());
        }
        $this->assertEquals(2, DB::table('transport_stops')->count());
        $this->assertFalse(DB::table('transport_routes')->where('ref', '99')->exists());
        $this->assertEquals($old['import_id'], DB::table('dataset_imports')->where('is_active', true)->value('id'));
        $failed = DB::table('dataset_imports')->where('status', 'failed')->first();
        $this->assertNotNull($failed);
        $this->assertFalse($failed->is_active);
        $this->assertNotNull($failed->finished_at);
    }

    public function test_large_drop_needs_explicit_override_and_disappeared_stops_remain_in_history(): void
    {
        $old = $this->runImport();
        $this->writeRows([['1', 'Центр', 'Автобус', '12', '', '92.9', '56.1']]);
        try {
            $this->runImport();
            $this->fail('Unverified large drop must fail.');
        } catch (RuntimeException $error) {
            $this->assertStringContainsString('20%', $error->getMessage());
        }
        $new = $this->runImport(['allow_large_drop' => true]);
        $this->assertEquals(1, DB::table('transport_stops')->where('dataset_import_id', $new['import_id'])->count());
        $this->assertEquals(2, DB::table('transport_stops')->where('dataset_import_id', $old['import_id'])->count());
        $this->assertEquals(1, DB::table('dataset_imports')->where('is_active', true)->count());
    }

    public function test_invalid_boundary_or_duplicate_ids_cannot_publish(): void
    {
        file_put_contents($this->boundary, '{"type":"Point","coordinates":[92.9,56.1]}');
        $this->artisan('transport:import-stops', ['file' => $this->csv, '--boundary' => $this->boundary])->assertFailed();
        // Invalid coverage is an invalid import parameter; reject it before registering an attempt.
        $this->assertEquals(0, DB::table('dataset_imports')->count());
        $this->assertEquals(0, DB::table('transport_stops')->count());
        $this->writeRows([
            ['1', 'А', 'Автобус', '1', '', '92.9', '56.1'],
            ['1', 'Б', 'Автобус', '1', '', '92.9', '56.1'],
        ]);
        $this->expectException(RuntimeException::class);
        app(OfficialStopsCsvReader::class)->read(file_get_contents($this->csv));
    }

    public function test_route_normalization_does_not_invent_modes_or_parse_unknown_labels(): void
    {
        $result = app(OfficialRouteNormalizer::class)->normalize('12,7т,4тр,экспресс', 'Автобус и троллейбус');
        $this->assertSame(['bus:12', 'trolleybus:7', 'tram:4'], array_column($result['routes'], 'source_id'));
        $this->assertContains('unparsed_route:экспресс', $result['issues']);
        $this->assertSame([], app(OfficialRouteNormalizer::class)->normalize('', '-')['routes']);
    }

    public function test_invalid_dates_and_missing_boundary_fail_before_writing(): void
    {
        $this->artisan('transport:import-stops', ['file' => $this->csv])->assertFailed();
        $this->artisan('transport:import-stops', ['file' => $this->csv, '--boundary' => $this->boundary, '--observed-at' => '2025-02-30'])->assertFailed();
        $this->assertEquals(0, DB::table('dataset_imports')->count());
    }

    public function test_empty_snapshot_is_rejected_even_with_large_drop_override(): void
    {
        $old = $this->runImport();
        $this->writeRows([['outside', 'Вне границы', 'Автобус', '1', '', '95', '56']]);
        try {
            $this->runImport(['allow_large_drop' => true]);
            $this->fail('Empty snapshots must never replace active data.');
        } catch (RuntimeException $error) {
            $this->assertStringContainsString('empty snapshots', $error->getMessage());
        }
        $this->assertEquals($old['import_id'], DB::table('dataset_imports')->where('is_active', true)->value('id'));
    }

    public function test_changed_boundary_creates_new_input_identity(): void
    {
        $first = $this->runImport();
        file_put_contents($this->boundary, file_get_contents($this->boundary)."\n");
        $second = $this->runImport();
        $this->assertSame('succeeded', $second['status']);
        $this->assertNotEquals($first['import_id'], $second['import_id']);
        $this->assertEquals(1, DB::table('dataset_imports')->where('is_active', true)->count());
        $this->assertEquals(2, DB::table('dataset_imports')->where('status', 'succeeded')->count());
    }

    public function test_catalog_resolves_unique_refs_but_preserves_ambiguous_and_missing_refs(): void
    {
        $normalizer = app(OfficialRouteNormalizer::class);
        $result = $normalizer->normalize('12,6,20,4т,4тр,1', 'Автобус и троллейбус');
        $this->assertSame(['bus:12', 'unknown:6', 'unknown:20', 'trolleybus:4', 'tram:4', 'bus:1'], array_column($result['routes'], 'source_id'));
        $this->assertSame('electric_bus', $result['routes'][5]['resolutions'][0]['vehicle_type']);
        $this->assertContains('source_type_conflict:4тр', $result['issues']);
        $old = $normalizer->normalize('20,8т', 'Автобус и троллейбус');
        $this->assertSame(['unknown:20', 'trolleybus:8'], array_column($old['routes'], 'source_id'));
        $this->assertContains('route_not_in_catalog:8т', $old['issues']);
        $wrongType = $normalizer->normalize('12,23', 'троллейбус');
        $this->assertSame(['bus:12', 'bus:23'], array_column($wrongType['routes'], 'source_id'));
        $this->assertContains('source_type_conflict:12', $wrongType['issues']);
        $this->assertSame('bus:6', $normalizer->normalize('6', 'Автобус')['routes'][0]['source_id']);
    }

    public function test_catalog_change_creates_new_snapshot_and_preserves_resolution_provenance(): void
    {
        $first = $this->runImport();
        $raw = json_decode(DB::table('transport_routes')->where('dataset_import_id', $first['import_id'])->where('source_id', 'bus:12')->value('raw_data'), true);
        $this->assertContains('catalog_unique', array_column($raw['resolutions'], 'method'));
        config(['transport_routes.version' => 2]);
        $second = $this->runImport();
        $this->assertSame('succeeded', $second['status']);
        $this->assertNotEquals($first['import_id'], $second['import_id']);
        $configuration = json_decode(DB::table('dataset_imports')->find($second['import_id'])->configuration, true);
        $this->assertSame(2, $configuration['route_catalog']['version']);
        $this->assertNull($configuration['route_catalog']['observed_at']);
    }

    private function runImport(array $options = []): array
    {
        return app(OfficialStopsImporter::class)->import($this->csv, $this->boundary, $options);
    }

    private function writeRows(array $rows): void
    {
        $handle = fopen($this->csv, 'w');
        fputcsv($handle, ['id', 'name', 'type_transport', 'num_route', 'address', 'the_geom_lon', 'the_geom_lat'], escape: '');
        foreach ($rows as $row) {
            fputcsv($handle, $row, escape: '');
        }
        fclose($handle);
    }
}
