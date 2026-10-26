<?php

namespace Tests\Integration;

use App\Services\Osm\Import\OsmLinearDataset;
use App\Services\Osm\Import\OsmLinearImporter;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class OsmLinearImportTest extends TestCase
{
    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || DB::connection()->getDatabaseName() !== 'web_gis_test') {
            throw new RuntimeException('Linear tests require web_gis_test.');
        }
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        $this->directory = sys_get_temp_dir().'/web-gis-linear-'.bin2hex(random_bytes(8));
        mkdir($this->directory);
        file_put_contents($this->directory.'/boundary.json', $this->encode(['type' => 'Polygon', 'coordinates' => [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]]));
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

    public function test_both_datasets_preserve_geometry_metadata_and_separate_snapshots(): void
    {
        $rows = [$this->way(1, ['highway' => 'primary', 'bridge' => 'yes', 'layer' => '1', 'name' => 'Мост', 'ref' => 'Р-1']),
            $this->way(2, ['railway' => 'rail', 'tunnel' => 'yes', 'layer' => '-1', 'access' => 'private']),
            $this->way(3, ['railway' => 'tram']), $this->way(4, ['highway' => 'residential'])];
        $results = [];
        foreach (OsmLinearDataset::cases() as $dataset) {
            $results[] = $result = $this->import($dataset, $rows);
            $this->assertSame(1, $result['report']['accepted_objects']);
            $this->assertSame(3, $result['report']['not_selected']);
            $row = DB::table($dataset->table())->first();
            $this->assertSame($dataset === OsmLinearDataset::Roads ? 1 : 2, $row->osm_id);
            $this->assertSame(2, $row->osm_version);
            $this->assertSame('way', $row->osm_type);
            $this->assertEquals($rows[$row->osm_id - 1]['tags'], json_decode($row->raw_data, true)['tags']);
            $check = DB::selectOne('SELECT ST_Equals(geom,ST_GeomFromGeoJSON(?)) AS equal,ST_SRID(geom) srid FROM '.$dataset->table(),
                [$this->encode(['type' => 'LineString', 'coordinates' => [[92.8, 55.8], [93.2, 56.2]]])]);
            $this->assertTrue($check->equal);
            $this->assertSame(4326, $check->srid);
            $import = DB::table('dataset_imports')->find($result['import_id']);
            $this->assertNull($import->observed_at);
            $this->assertSame('2026-10-18T20:25:06Z', $import->source_version);
            $this->assertSame('https://example.org/region.osm.pbf', $import->source_url);
        }
        $this->assertSame(2, DB::table('dataset_imports')->whereIn('id', array_column($results, 'import_id'))->where('is_active', true)->count());
    }

    public function test_raw_levels_and_overlapping_ways_are_kept_without_graph_or_merging(): void
    {
        $loop = [[92.8, 55.8], [93, 56], [92.8, 56], [93, 55.8], [92.8, 55.8]];
        $result = $this->import(OsmLinearDataset::Roads, [
            $this->way(1, ['highway' => 'primary', 'layer' => '1', 'bridge' => 'yes'], $loop),
            $this->way(2, ['highway' => 'primary', 'layer' => '-1', 'tunnel' => 'yes'], $loop),
        ]);
        $this->assertSame(2, $result['report']['accepted_objects']);
        foreach (DB::select('SELECT ST_AsGeoJSON(geom) geo,raw_data FROM osm_roads ORDER BY osm_id') as $index => $row) {
            $this->assertEquals($loop, json_decode($row->geo, true)['coordinates']);
            $this->assertSame($index === 0 ? '1' : '-1', json_decode($row->raw_data, true)['tags']['layer']);
        }
    }

    public function test_filters_do_not_treat_tram_links_areas_or_inactive_objects_as_selected_lines(): void
    {
        foreach (OsmLinearDataset::cases() as $dataset) {
            $tag = $dataset->tag();
            $type = $dataset->types()[0];
            $result = $this->import($dataset, [
                $this->way(1, [$tag => $type]), $this->way(2, [$tag => $type, 'construction' => $type]),
                $this->way(3, [$tag => $type, 'disused' => 'yes']), $this->way(4, [$tag => $type, 'area' => 'yes']),
                $this->way(5, [$tag => $dataset === OsmLinearDataset::Roads ? 'primary_link' : 'tram']),
            ]);
            $this->assertSame(1, $result['report']['accepted_objects']);
            $this->assertSame(3, $result['report']['not_selected']);
            $this->assertSame(2, $result['report']['ignored_counts']['lifecycle_flag']);
            $this->assertSame('area_not_a_linear_centerline', $result['report']['skipped'][0]['reason']);
        }
    }

    public function test_incomplete_missing_invalid_and_non_way_geometry_are_rejected_without_bridging(): void
    {
        $broken = $this->way(2);
        $broken['nodes'] = [1, 2, 3];
        $missing = $this->way(3);
        $missing['geometry'][1] = null;
        $node = ['type' => 'node', 'id' => 4, 'tags' => ['railway' => 'rail'], 'lon' => 92.9, 'lat' => 56];
        $result = $this->import(OsmLinearDataset::Railways, [$this->way(1), $broken, $missing, $node,
            $this->way(5, coordinates: [[92.9, 56], [92.9, 56]]), $this->way(6, coordinates: [[200, 56], [93, 56]])]);
        $this->assertSame(1, $result['report']['accepted_objects']);
        foreach (['incomplete_way_nodes', 'invalid_or_missing_coordinates', 'only_way_geometry_supported', 'invalid_geometry'] as $reason) {
            $this->assertContains($reason, array_column($result['report']['skipped'], 'reason'));
        }
    }

    public function test_exact_boundary_with_hole_keeps_crossing_line_and_preserves_full_extent(): void
    {
        file_put_contents($this->directory.'/boundary.json', $this->encode(['type' => 'Polygon', 'coordinates' => [
            [[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]],
            [[92.7, 55.7], [93.3, 55.7], [93.3, 56.3], [92.7, 56.3], [92.7, 55.7]],
        ]]));
        foreach (OsmLinearDataset::cases() as $dataset) {
            $result = $this->import($dataset, [$this->way(1), $this->way(2, coordinates: [[93.9, 56], [94.1, 56]]),
                $this->way(3, coordinates: [[95, 56], [96, 56]])]);
            $this->assertSame(1, $result['report']['accepted_objects']);
            $this->assertSame(2, count($result['report']['skipped']));
            $row = DB::selectOne('SELECT crosses_boundary,ST_XMax(Box3D(geom)) east FROM '.$dataset->table());
            $this->assertTrue($row->crosses_boundary);
            $this->assertEquals(94.1, $row->east);
        }
    }

    public function test_dry_run_repeats_history_and_large_drop_are_independent_per_dataset(): void
    {
        $roads = $this->import(OsmLinearDataset::Roads, [$this->way(1)]);
        $before = DB::table('dataset_imports')->count();
        $this->assertSame('dry-run', $this->import(OsmLinearDataset::Railways, [$this->way(1), $this->way(2)], ['dry_run' => true])['status']);
        $this->assertSame($before, DB::table('dataset_imports')->count());
        $this->assertSame(0, DB::table('osm_railways')->count());
        $first = $this->import(OsmLinearDataset::Railways, [$this->way(1), $this->way(2)]);
        $this->assertSame('skipped', $this->import(OsmLinearDataset::Railways, [$this->way(1), $this->way(2)])['status']);
        $this->assertTrue($this->import(OsmLinearDataset::Railways, [$this->way(3)], ['dry_run' => true])['report']['large_drop']);
        try {
            $this->import(OsmLinearDataset::Railways, [$this->way(3)]);
            $this->fail('Expected drop protection');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('20%', $e->getMessage());
        }
        $second = $this->import(OsmLinearDataset::Railways, [$this->way(3)], ['allow_large_drop' => true]);
        $historical = $this->import(OsmLinearDataset::Railways, [$this->way(1), $this->way(2)]);
        $this->assertFalse($historical['is_active']);
        foreach ([$roads['import_id'], $second['import_id']] as $id) {
            $this->assertTrue(DB::table('dataset_imports')->find($id)->is_active);
        }
        $this->assertSame(2, DB::table('osm_railways')->where('dataset_import_id', $first['import_id'])->count());
    }

    public function test_failed_publication_rolls_back_all_rows_and_keeps_active_snapshot(): void
    {
        foreach (OsmLinearDataset::cases() as $dataset) {
            $first = $this->import($dataset, [$this->way(1)]);
            $table = $dataset->table();
            DB::unprepared("CREATE OR REPLACE FUNCTION pg_temp.reject_linear() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''linear test failure''; END';
                CREATE TRIGGER reject_linear BEFORE INSERT ON {$table} FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_linear()");
            try {
                $this->import($dataset, [$this->way(2), $this->way(3)]);
                $this->fail('Expected publication failure');
            } catch (QueryException $e) {
                $this->assertStringContainsString('linear test failure', $e->getMessage());
            }
            $this->assertSame(1, DB::table($table)->count());
            $this->assertTrue(DB::table('dataset_imports')->find($first['import_id'])->is_active);
            $this->assertSame(1, DB::table('dataset_imports')->where('dataset_key', $dataset->value)->where('status', 'failed')->count());
            DB::unprepared("DROP TRIGGER reject_linear ON {$table}");
            $this->assertSame('succeeded', $this->import($dataset, [$this->way(2), $this->way(3)])['status']);
        }
    }

    public function test_bad_checksum_partial_or_duplicate_input_cannot_replace_active_data(): void
    {
        $first = $this->import(OsmLinearDataset::Roads, [$this->way(1)]);
        foreach ([['elements' => [$this->way(1), $this->way(1)]], ['elements' => [$this->way(2)], 'remark' => 'timeout'],
            ['elements' => [$this->way(2, ['railway' => 'tram'])]]] as $extra) {
            $this->write($extra['elements'], $extra);
            try {
                app(OsmLinearImporter::class)->import(OsmLinearDataset::Roads, $this->directory.'/lines.json', $this->directory.'/boundary.json');
                $this->fail('Expected input rejection');
            } catch (RuntimeException $e) {
                $this->assertNotEmpty($e->getMessage());
            }
        }
        try {
            $this->import(OsmLinearDataset::Roads, [$this->way(2)], ['expected_sha256' => str_repeat('0', 64)]);
            $this->fail('Expected checksum rejection');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('SHA-256', $e->getMessage());
        }
        $this->assertTrue(DB::table('dataset_imports')->find($first['import_id'])->is_active);
    }

    public function test_preparation_provenance_and_boundary_are_part_of_snapshot_configuration(): void
    {
        $this->write([$this->way(1)], ['preparation' => ['pbf_sha256' => str_repeat('a', 64), 'method' => 'whole_ways_intersecting_boundary_bbox']]);
        $a = app(OsmLinearImporter::class)->import(OsmLinearDataset::Roads, $this->directory.'/lines.json', $this->directory.'/boundary.json');
        $config = json_decode(DB::table('dataset_imports')->find($a['import_id'])->configuration, true);
        $this->assertSame(str_repeat('a', 64), $config['preparation']['pbf_sha256']);
        $this->assertSame('Polygon', $config['selection_boundary']['type']);
        file_put_contents($this->directory.'/boundary.json', $this->encode(['type' => 'Polygon', 'coordinates' => [[[92, 55], [95, 55], [95, 57], [92, 57], [92, 55]]]]));
        $b = app(OsmLinearImporter::class)->import(OsmLinearDataset::Roads, $this->directory.'/lines.json', $this->directory.'/boundary.json');
        $this->assertNotSame($a['import_id'], $b['import_id']);
    }

    public function test_schema_constraints_and_unique_source_identity(): void
    {
        foreach (OsmLinearDataset::cases() as $dataset) {
            $result = $this->import($dataset, [$this->way(1)]);
            $table = $dataset->table();
            $row = DB::table($table)->where('dataset_import_id', $result['import_id'])->first();
            foreach ([['osm_id' => 0], ['osm_type' => 'relation'], ['osm_version' => 0], ['feature_type' => 'unsupported'],
                ['raw_data' => '{}'], ['geom' => DB::raw("ST_GeomFromText('LINESTRING EMPTY',4326)")]] as $change) {
                try {
                    DB::transaction(fn () => DB::table($table)->where('id', $row->id)->update($change));
                    $this->fail('Expected schema constraint');
                } catch (QueryException $e) {
                    $this->assertSame('23514', $e->errorInfo[0]);
                }
            }
            $copy = (array) $row;
            $copy['id'] += 1000000;
            try {
                DB::transaction(fn () => DB::table($table)->insert($copy));
                $this->fail('Expected unique source identity');
            } catch (QueryException $e) {
                $this->assertSame('23505', $e->errorInfo[0]);
            }
        }
    }

    public function test_migration_indexes_and_rollback_only_in_isolated_test_schema(): void
    {
        DB::statement('CREATE SCHEMA linear_migration_test');
        DB::statement('SET LOCAL search_path TO linear_migration_test,public');
        DB::statement('CREATE TABLE linear_migration_test.dataset_imports (id bigint PRIMARY KEY)');
        $migration = require database_path('migrations/2026_10_19_000002_create_osm_linear_tables.php');
        $migration->up();
        foreach (['osm_roads', 'osm_railways'] as $table) {
            $indexes = DB::select("SELECT indexdef FROM pg_indexes WHERE schemaname='linear_migration_test' AND tablename=?", [$table]);
            $this->assertCount(6, $indexes);
            $this->assertStringContainsString('geography', implode(' ', array_column($indexes, 'indexdef')));
        }
        $migration->down();
        $this->assertNull(DB::selectOne("SELECT to_regclass('linear_migration_test.osm_roads') name")->name);
        $this->assertNull(DB::selectOne("SELECT to_regclass('linear_migration_test.osm_railways') name")->name);
        $migration->up();
    }

    public function test_command_validates_dataset_boundary_and_writes_dry_run_report(): void
    {
        $this->write([$this->way(1)]);
        foreach ([['dataset' => 'anything', 'file' => $this->directory.'/lines.json'], ['dataset' => 'roads', 'file' => $this->directory.'/lines.json']] as $args) {
            $this->artisan('osm:import-linear', $args)->assertFailed();
        }
        foreach (OsmLinearDataset::cases() as $dataset) {
            $this->artisan('osm:import-linear', ['dataset' => $dataset->value, 'file' => $this->directory.'/lines.json',
                '--boundary' => $this->directory.'/boundary.json', '--dry-run' => true, '--report' => $this->directory.'/report.json'])->assertSuccessful();
            $this->assertSame('dry-run', json_decode(file_get_contents($this->directory.'/report.json'), true)['status']);
            $this->assertSame(0, DB::table($dataset->table())->count());
        }
    }

    private function import(OsmLinearDataset $dataset, array $elements, array $options = []): array
    {
        $this->write($elements);

        return app(OsmLinearImporter::class)->import($dataset, $this->directory.'/lines.json', $this->directory.'/boundary.json', $options + ['source_url' => 'https://example.org/region.osm.pbf']);
    }

    private function write(array $elements, array $extra = []): void
    {
        file_put_contents($this->directory.'/lines.json', $this->encode($extra + ['osm3s' => ['timestamp_osm_base' => '2026-10-18T20:25:06Z'], 'elements' => $elements]));
    }

    private function way(int $id, array $tags = ['highway' => 'primary', 'railway' => 'rail'], ?array $coordinates = null): array
    {
        return ['type' => 'way', 'id' => $id, 'version' => 2, 'timestamp' => '2026-10-01T00:00:00Z', 'tags' => $tags,
            'geometry' => array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], $coordinates ?? [[92.8, 55.8], [93.2, 56.2]])];
    }

    private function encode(array $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    }
}
