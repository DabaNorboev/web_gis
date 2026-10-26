<?php

namespace Tests\Integration;

use App\Services\Gis\DatasetCoverage;
use App\Services\Osm\Import\OsmAreaDataset;
use App\Services\Osm\Import\OsmAreaImporter;
use App\Services\Osm\Import\OsmLinearDataset;
use App\Services\Osm\Import\OsmLinearImporter;
use App\Services\Transport\Import\OfficialStopsImporter;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class DatasetCoverageTest extends TestCase
{
    private string $directory;

    private string $boundary = '{"type":"Polygon","coordinates":[[[92.89,55.99],[92.91,55.99],[92.91,56.01],[92.89,56.01],[92.89,55.99]]]}';

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || DB::connection()->getDatabaseName() !== 'web_gis_test') {
            throw new RuntimeException('Coverage tests require web_gis_test.');
        }
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        $this->directory = sys_get_temp_dir().'/web-gis-coverage-'.bin2hex(random_bytes(8));
        mkdir($this->directory);
        file_put_contents($this->directory.'/service.json', $this->boundary);
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

    public function test_exported_selection_is_exactly_the_preparation_hash_and_cannot_overwrite(): void
    {
        $file = $this->directory.'/selection.json';
        $this->artisan('gis:prepare-coverage', ['boundary' => $this->directory.'/service.json', 'output' => $file])->assertSuccessful();
        $coverage = app(DatasetCoverage::class)->prepare($this->boundary, 1000);
        $this->assertSame($coverage['data_boundary_sha256'], hash_file('sha256', $file));
        $this->assertSame($coverage['data_geometry'], file_get_contents($file));
        $this->artisan('gis:prepare-coverage', ['boundary' => $this->directory.'/service.json', 'output' => $file])->assertFailed();
        foreach ([-1, 5001, 'bad', '500.5'] as $value) {
            try {
                app(DatasetCoverage::class)->prepare($this->boundary, $value);
                $this->fail('Invalid buffer must be rejected');
            } catch (RuntimeException $error) {
                $this->assertStringContainsString('Buffer', $error->getMessage());
            }
        }
        $unbuffered = app(DatasetCoverage::class)->prepare($this->boundary);
        app(DatasetCoverage::class)->validatePreparation(['preparation' => ['boundary_sha256' => hash('sha256', $this->boundary)]], $unbuffered);
        try {
            app(DatasetCoverage::class)->validatePreparation(['preparation' => ['boundary_sha256' => str_repeat('0', 64)]], $unbuffered);
            $this->fail('A different preparation boundary cannot claim coverage even without a buffer');
        } catch (RuntimeException $error) {
            $this->assertStringContainsString('exact selection boundary', $error->getMessage());
        }
    }

    public function test_buffered_osm_import_requires_preparation_for_exact_selection_and_preserves_geometry(): void
    {
        $coverage = app(DatasetCoverage::class)->prepare($this->boundary, 1000);
        $coordinates = [[92.911, 56], [92.912, 56], [92.912, 56.001], [92.911, 56.001], [92.911, 56]];
        foreach (['linear', 'area'] as $kind) {
            $element = ['type' => 'way', 'id' => 1, 'tags' => $kind === 'linear' ? ['highway' => 'primary'] : ['natural' => 'water'],
                'geometry' => array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], $coordinates)];
            $import = fn () => $kind === 'linear'
                ? app(OsmLinearImporter::class)->import(OsmLinearDataset::Roads, $this->directory.'/osm.json', $this->directory.'/service.json', ['buffer_m' => 1000])
                : app(OsmAreaImporter::class)->import(OsmAreaDataset::Water, $this->directory.'/osm.json', $this->directory.'/service.json', ['buffer_m' => 1000]);
            foreach ([null, str_repeat('0', 64)] as $hash) {
                file_put_contents($this->directory.'/osm.json', json_encode(['elements' => [$element], 'preparation' => ['boundary_sha256' => $hash]]));
                $before = DB::table('dataset_imports')->count();
                try {
                    $import();
                    $this->fail('A city-only or differently prepared file cannot claim buffered coverage');
                } catch (RuntimeException $error) {
                    $this->assertStringContainsString('exact selection boundary', $error->getMessage());
                }
                $this->assertSame($before, DB::table('dataset_imports')->count());
            }
            file_put_contents($this->directory.'/osm.json', json_encode(['elements' => [$element], 'preparation' => ['boundary_sha256' => $coverage['data_boundary_sha256']]]));
            $result = $import();
            $this->assertSame(1, $result['report']['accepted_objects']);
            $this->assertSame('COVERED', app(DatasetCoverage::class)->assess($result['import_id'], 92.91, 56, 500)['status']);
            $this->assertSame('OUTSIDE_SERVICE_AREA', app(DatasetCoverage::class)->assess($result['import_id'], 92.911, 56, 500)['status']);
            $table = $kind === 'linear' ? 'osm_roads' : 'osm_water';
            $geometry = json_decode(DB::selectOne("SELECT ST_AsGeoJSON(geom) g FROM {$table} WHERE dataset_import_id=?", [$result['import_id']])->g, true);
            $this->assertSame($coordinates, $kind === 'linear' ? $geometry['coordinates'] : $geometry['coordinates'][0]);
        }
    }

    public function test_service_holes_are_outside_even_when_the_buffer_fills_them(): void
    {
        $service = json_decode($this->boundary, true);
        $service['coordinates'][] = [[92.899, 55.999], [92.901, 55.999], [92.901, 56.001], [92.899, 56.001], [92.899, 55.999]];
        $coverage = app(DatasetCoverage::class)->prepare(json_encode($service), 1000);
        $id = DB::table('dataset_imports')->insertGetId(['source' => 'coverage-test', 'dataset_key' => 'holes',
            'checksum_sha256' => str_repeat('a', 64), 'configuration_sha256' => str_repeat('b', 64), 'configuration' => '{}']);
        app(DatasetCoverage::class)->store($id, $coverage);
        $this->assertSame('OUTSIDE_SERVICE_AREA', app(DatasetCoverage::class)->assess($id, 92.9, 56, 500)['status']);
        $this->assertSame('COVERED', app(DatasetCoverage::class)->assess($id, 92.895, 56, 500)['status']);
    }

    public function test_coverage_migration_rollback_does_not_remove_source_snapshots(): void
    {
        DB::statement('CREATE SCHEMA coverage_migration_test');
        DB::statement('SET LOCAL search_path TO coverage_migration_test,public');
        DB::statement('CREATE TABLE coverage_migration_test.dataset_imports (id bigint PRIMARY KEY)');
        DB::statement('INSERT INTO coverage_migration_test.dataset_imports VALUES (1)');
        $migration = require database_path('migrations/2026_10_20_000002_create_dataset_coverages.php');
        $migration->up();
        $migration->down();
        $this->assertSame(1, DB::table('coverage_migration_test.dataset_imports')->count());
        $this->assertNull(DB::selectOne("SELECT to_regclass('coverage_migration_test.dataset_coverages') n")->n);
        $migration->up();
    }

    public function test_coverage_write_failure_rolls_back_objects_and_keeps_old_coverage_active(): void
    {
        $csv = $this->directory.'/stops.csv';
        file_put_contents($csv, "id,name,type_transport,num_route,address,the_geom_lon,the_geom_lat\n1,Stop,Автобус,12,,92.9,56\n");
        $old = app(OfficialStopsImporter::class)->import($csv, $this->directory.'/service.json');
        DB::unprepared("CREATE FUNCTION pg_temp.reject_coverage() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''coverage publication failure''; END';
            CREATE TRIGGER reject_coverage BEFORE INSERT ON dataset_coverages FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_coverage()");
        try {
            app(OfficialStopsImporter::class)->import($csv, $this->directory.'/service.json', ['buffer_m' => 1000]);
            $this->fail('Expected coverage publication failure');
        } catch (QueryException $error) {
            $this->assertStringContainsString('coverage publication failure', $error->getMessage());
        }
        DB::statement('DROP TRIGGER reject_coverage ON dataset_coverages');
        $this->assertTrue(DB::table('dataset_imports')->find($old['import_id'])->is_active);
        $this->assertSame(1, DB::table('transport_stops')->count());
        $this->assertSame(1, DB::table('dataset_coverages')->count());
        $this->assertSame(1, DB::table('dataset_imports')->where('status', 'failed')->count());
        $this->assertSame('COVERED', app(DatasetCoverage::class)->assess($old['import_id'], 92.9, 56, 500)['status']);
    }
}
