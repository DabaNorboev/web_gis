<?php

namespace Tests\Integration;

use App\Services\Osm\Import\OsmAreaDataset;
use App\Services\Osm\Import\OsmAreaImporter;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class OsmAreaImportTest extends TestCase
{
    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || DB::connection()->getDatabaseName() !== 'web_gis_test') {
            throw new RuntimeException('Area tests require web_gis_test.');
        }
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        $this->directory = sys_get_temp_dir().'/web-gis-areas-'.bin2hex(random_bytes(6));
        mkdir($this->directory);
        $this->boundary([[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]);
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

    public function test_separate_datasets_preserve_source_tags_and_polygon_coordinates(): void
    {
        $rows = [$this->way(1, ['natural' => 'wood', 'access' => 'private']), $this->way(2, ['natural' => 'water', 'intermittent' => 'yes', 'water' => 'river'])];
        foreach (OsmAreaDataset::cases() as $dataset) {
            $r = $this->import($dataset, $rows);
            $this->assertSame(1, $r['report']['accepted_objects']);
            $this->assertSame(1, $r['report']['not_selected']);
            $row = DB::table($dataset->table())->first();
            $this->assertSame($dataset === OsmAreaDataset::GreenAreas ? 'vegetation_landuse' : 'water_area', $row->representation);
            $this->assertEquals($rows[$row->osm_id - 1]['tags'], json_decode($row->raw_data, true)['tags']);
            $check = DB::selectOne('SELECT ST_AsGeoJSON(geom) geo,ST_SRID(geom) srid FROM '.$dataset->table());
            $this->assertEquals($this->ring(), json_decode($check->geo, true)['coordinates'][0]);
            $this->assertSame(4326, $check->srid);
            $journal = DB::table('dataset_imports')->find($r['import_id']);
            $this->assertNull($journal->observed_at);
            $this->assertSame('2026-10-18T20:25:06Z', $journal->source_version);
        }
        $this->assertSame(2, DB::table('dataset_imports')->where('is_active', true)->whereIn('dataset_key', ['green_areas', 'water'])->count());
    }

    public function test_parks_are_boundaries_not_measured_vegetation_and_overlaps_are_not_merged(): void
    {
        $r = $this->import(OsmAreaDataset::GreenAreas, [$this->way(1, ['leisure' => 'park']), $this->way(2, ['natural' => 'wood', 'leisure' => 'park']), $this->way(3, ['landuse' => 'grass'])]);
        $this->assertSame(['recreation_boundary' => 1, 'vegetation_landuse' => 2], $r['report']['representation_counts']);
        $this->assertSame(3, DB::table('osm_green_areas')->count());
        $this->assertSame('natural:wood', DB::table('osm_green_areas')->where('osm_id', 2)->value('feature_type'));
        $this->assertSame(1, DB::selectOne('SELECT count(DISTINCT ST_AsBinary(geom)) total FROM osm_green_areas')->total);
    }

    public function test_every_supported_tag_has_matching_database_classification(): void
    {
        foreach (OsmAreaDataset::cases() as $dataset) {
            $rows = [];
            foreach ($dataset->rules() as $key => $values) {
                foreach ($values as $value) {
                    $rows[] = $this->way(count($rows) + 1, [$key => $value]);
                }
            }
            $this->assertSame(count($rows), $this->import($dataset, $rows)['report']['accepted_objects']);
            if ($dataset === OsmAreaDataset::GreenAreas) {
                $stored = DB::table('osm_green_areas')->orderBy('osm_id')->get()->keyBy('osm_id');
                foreach ($rows as $row) {
                    $this->assertSame(isset($row['tags']['natural']) || isset($row['tags']['landuse']), $stored[$row['id']]->is_vegetation);
                    $this->assertSame(($row['tags']['leisure'] ?? null) === 'park', $stored[$row['id']]->is_park);
                    $this->assertSame(($row['tags']['leisure'] ?? null) === 'garden', $stored[$row['id']]->is_garden);
                }
            }
        }
    }

    public function test_complete_multipolygon_keeps_hole_and_multiple_outers(): void
    {
        $r = $this->relation(20);
        $second = [[93.5, 56.5], [93.8, 56.5], [93.8, 56.8], [93.5, 56.8], [93.5, 56.5]];
        $r['members'][] = $this->member(3, 'outer', $second);
        $this->import(OsmAreaDataset::Water, [$r]);
        $row = DB::selectOne('SELECT ST_AsGeoJSON(geom) geo,ST_NumGeometries(geom) total FROM osm_water');
        $this->assertSame(2, $row->total);
        $geometry = json_decode($row->geo, true);
        $this->assertCount(2, $geometry['coordinates'][0]);
        $this->assertEquals($this->hole(), $geometry['coordinates'][0][1]);
        $this->assertSame('inner', json_decode(DB::table('osm_water')->value('raw_data'), true)['osm']['members'][1]['role']);
    }

    public function test_open_broken_nested_ambiguous_and_invalid_shapes_are_reported_not_repaired(): void
    {
        $open = $this->way(2, ['natural' => 'water'], array_slice($this->ring(), 0, 4));
        $nested = $this->relation(3);
        $nested['members'][] = ['type' => 'relation', 'ref' => 99, 'role' => 'outer'];
        $missing = $this->relation(4);
        unset($missing['members'][0]['geometry']);
        $invalid = $this->way(5, ['natural' => 'water'], [[92.5, 55.5], [93, 56], [92.5, 56], [93, 55.5], [92.5, 55.5]]);
        $explicit = $this->way(6, ['natural' => 'water', 'area' => 'no']);
        $node = ['type' => 'node', 'id' => 7, 'lon' => 93, 'lat' => 56, 'tags' => ['natural' => 'water']];
        $r = $this->import(OsmAreaDataset::Water, [$this->way(1), $open, $nested, $missing, $invalid, $explicit, $node]);
        $this->assertSame(1, $r['report']['accepted_objects']);
        $this->assertCount(6, $r['report']['skipped']);
        foreach (['unclosed_ring', 'unsupported_multipolygon_member', 'incomplete_geometry', 'invalid_geometry', 'explicit_non_area', 'point_without_footprint'] as $reason) {
            $this->assertContains($reason, array_column($r['report']['skipped'], 'reason'));
        }
    }

    public function test_exact_boundary_hole_and_full_crossing_footprint_are_respected(): void
    {
        $this->boundary([[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]], $this->hole()]);
        $r = $this->import(OsmAreaDataset::Water, [$this->way(1, coordinates: $this->hole()),
            $this->way(2, coordinates: [[93.9, 56], [94.2, 56], [94.2, 56.2], [93.9, 56.2], [93.9, 56]]),
            $this->way(3, coordinates: [[92.75, 55.75], [92.8, 55.75], [92.8, 55.8], [92.75, 55.8], [92.75, 55.75]])]);
        // A polygon touching the hole edge intersects the boundary; strictly inside it does not.
        $this->assertSame(2, $r['report']['accepted_objects']);
        $this->assertSame('outside_boundary', $r['report']['skipped'][0]['reason']);
        $row = DB::selectOne('SELECT crosses_boundary,ST_XMax(Box3D(geom)) east FROM osm_water WHERE osm_id=2');
        $this->assertTrue($row->crosses_boundary);
        $this->assertEquals(94.2, $row->east);
    }

    public function test_lifecycle_and_other_land_uses_do_not_become_green_or_water(): void
    {
        $r = $this->import(OsmAreaDataset::GreenAreas, [$this->way(1, ['natural' => 'wood']), $this->way(2, ['landuse' => 'farmland']),
            $this->way(3, ['leisure' => 'pitch', 'surface' => 'grass']), $this->way(4, ['natural' => 'wood', 'proposed' => 'yes']),
            $this->way(5, ['natural' => 'wood', 'disused' => 'no'])]);
        $this->assertSame(2, $r['report']['accepted_objects']);
        $this->assertSame(3, $r['report']['not_selected']);
        $this->assertSame(1, $r['report']['ignored_counts']['lifecycle_flag']);
        $r = $this->import(OsmAreaDataset::Water, [$this->way(1), $this->way(2, ['waterway' => 'stream']), $this->way(3, ['landuse' => 'basin'])]);
        $this->assertSame(1, $r['report']['accepted_objects']);
    }

    public function test_dry_run_repeat_history_and_large_drop_leave_other_dataset_active(): void
    {
        $green = $this->import(OsmAreaDataset::GreenAreas, [$this->way(1, ['natural' => 'wood'])]);
        $count = DB::table('dataset_imports')->count();
        $this->assertSame('dry-run', $this->import(OsmAreaDataset::Water, [$this->way(1)], ['dry_run' => true])['status']);
        $this->assertSame($count, DB::table('dataset_imports')->count());
        $first = $this->import(OsmAreaDataset::Water, [$this->way(1), $this->way(2)]);
        $this->assertSame('skipped', $this->import(OsmAreaDataset::Water, [$this->way(1), $this->way(2)])['status']);
        try {
            $this->import(OsmAreaDataset::Water, [$this->way(3)]);
            $this->fail('Expected large-drop rejection');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('20%', $e->getMessage());
        }
        $second = $this->import(OsmAreaDataset::Water, [$this->way(3)], ['allow_large_drop' => true]);
        $this->assertFalse($this->import(OsmAreaDataset::Water, [$this->way(1), $this->way(2)])['is_active']);
        foreach ([$green['import_id'], $second['import_id']] as $id) {
            $this->assertTrue(DB::table('dataset_imports')->find($id)->is_active);
        }
        $this->assertSame(2, DB::table('osm_water')->where('dataset_import_id', $first['import_id'])->count());
    }

    public function test_failed_publication_rolls_back_geometry_and_active_snapshot(): void
    {
        $first = $this->import(OsmAreaDataset::Water, [$this->way(1)]);
        DB::unprepared("CREATE OR REPLACE FUNCTION pg_temp.reject_area() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''area test failure''; END'; CREATE TRIGGER reject_area BEFORE INSERT ON osm_water FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_area()");
        try {
            $this->import(OsmAreaDataset::Water, [$this->way(2)]);
            $this->fail('Expected publication failure');
        } catch (QueryException $e) {
            $this->assertStringContainsString('area test failure', $e->getMessage());
        }
        $this->assertSame(1, DB::table('osm_water')->count());
        $this->assertTrue(DB::table('dataset_imports')->find($first['import_id'])->is_active);
        $this->assertSame(1, DB::table('dataset_imports')->where('dataset_key', 'water')->where('status', 'failed')->count());
    }

    public function test_invalid_source_document_cannot_replace_active_data(): void
    {
        $first = $this->import(OsmAreaDataset::Water, [$this->way(1)]);
        foreach ([['elements' => [$this->way(2), $this->way(2)]], ['elements' => [$this->way(2)], 'remark' => 'timeout'], ['elements' => [$this->way(2, ['natural' => 'tree'])]]] as $doc) {
            $this->write($doc['elements'], $doc);
            try {
                app(OsmAreaImporter::class)->import(OsmAreaDataset::Water, $this->directory.'/areas.json', $this->directory.'/boundary.json');
                $this->fail('Expected input rejection');
            } catch (RuntimeException $e) {
                $this->assertNotEmpty($e->getMessage());
            }
        }
        try {
            $this->import(OsmAreaDataset::Water, [$this->way(2)], ['expected_sha256' => str_repeat('0', 64)]);
            $this->fail('Expected checksum rejection');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('SHA-256', $e->getMessage());
        }
        $this->assertTrue(DB::table('dataset_imports')->find($first['import_id'])->is_active);
    }

    public function test_schema_constraints_source_uniqueness_and_spatial_indexes(): void
    {
        foreach (OsmAreaDataset::cases() as $dataset) {
            $this->import($dataset, [$this->way(1, ['natural' => 'wood', 'waterway' => 'riverbank'])]);
            $table = $dataset->table();
            $row = DB::table($table)->first();
            foreach ([['osm_id' => 0], ['osm_type' => 'node'], ['representation' => 'fake'], ['raw_data' => '{}'], ['feature_type' => 'natural:tree'], ['geom' => DB::raw("ST_GeomFromText('POINT(93 56)',4326)")], ['geom' => DB::raw("ST_GeomFromText('POLYGON EMPTY',4326)")]] as $change) {
                try {
                    DB::transaction(fn () => DB::table($table)->where('id', $row->id)->update($change));
                    $this->fail('Expected constraint rejection');
                } catch (QueryException $e) {
                    $this->assertSame('23514', $e->errorInfo[0]);
                }
            }
            $copy = array_diff_key((array) $row, array_flip(['is_park', 'is_garden', 'is_vegetation']));
            $copy['id'] += 1000000;
            try {
                DB::transaction(fn () => DB::table($table)->insert($copy));
                $this->fail('Expected uniqueness rejection');
            } catch (QueryException $e) {
                $this->assertSame('23505', $e->errorInfo[0]);
            }
            $indexes = DB::select("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=?", [$table]);
            $this->assertCount(6, $indexes);
            $this->assertStringContainsString('geography', implode(' ', array_column($indexes, 'indexdef')));
        }
    }

    public function test_migration_is_reversible_only_in_isolated_test_schema(): void
    {
        DB::statement('CREATE SCHEMA area_migration_test');
        DB::statement('SET LOCAL search_path TO area_migration_test,public');
        DB::statement('CREATE TABLE area_migration_test.dataset_imports(id bigint PRIMARY KEY)');
        $migration = require database_path('migrations/2026_10_19_000003_create_osm_area_tables.php');
        $migration->up();
        $migration->down();
        $this->assertNull(DB::selectOne("SELECT to_regclass('area_migration_test.osm_water') name")->name);
        $this->assertNull(DB::selectOne("SELECT to_regclass('area_migration_test.osm_green_areas') name")->name);
        $migration->up();
    }

    public function test_command_report_and_preparation_provenance(): void
    {
        $this->write([$this->way(1)], ['preparation' => ['pbf_sha256' => str_repeat('a', 64)]]);
        $this->artisan('osm:import-areas', ['dataset' => 'water', 'file' => $this->directory.'/areas.json'])->assertFailed();
        $args = ['dataset' => 'water', 'file' => $this->directory.'/areas.json', '--boundary' => $this->directory.'/boundary.json', '--report' => $this->directory.'/report.json'];
        $this->artisan('osm:import-areas', $args + ['--dry-run' => true])->assertSuccessful();
        $this->assertSame('dry-run', json_decode(file_get_contents($this->directory.'/report.json'), true)['status']);
        $this->assertSame(0, DB::table('osm_water')->count());
        $this->artisan('osm:import-areas', $args)->assertSuccessful();
        $config = json_decode(DB::table('dataset_imports')->where('dataset_key', 'water')->value('configuration'), true);
        $this->assertSame(str_repeat('a', 64), $config['preparation']['pbf_sha256']);
        $this->assertSame('Polygon', $config['selection_boundary']['type']);
    }

    public function test_increase_in_park_boundaries_cannot_hide_loss_of_vegetation_objects(): void
    {
        $this->import(OsmAreaDataset::GreenAreas, [$this->way(1, ['natural' => 'wood']), $this->way(2, ['leisure' => 'park'])]);
        $r = $this->import(OsmAreaDataset::GreenAreas, [$this->way(3, ['leisure' => 'park']), $this->way(4, ['leisure' => 'garden']), $this->way(5, ['leisure' => 'park'])], ['dry_run' => true]);
        $this->assertTrue($r['report']['large_drop']);
        $this->assertSame(['vegetation_landuse'], $r['report']['large_drop_representations']);
        $this->assertSame(2, DB::table('osm_green_areas')->count());
    }

    public function test_concurrent_dataset_lock_prevents_a_new_attempt(): void
    {
        $connection = DB::connection()->getConfig();
        config(['database.connections.area_lock_test' => $connection]);
        $other = DB::connection('area_lock_test');
        $key = 'web_gis:OpenStreetMap:water';
        $other->selectOne('SELECT pg_advisory_lock(hashtextextended(?,0))', [$key]);
        $count = DB::table('dataset_imports')->count();
        try {
            try {
                $this->import(OsmAreaDataset::Water, [$this->way(1)]);
                $this->fail('Expected concurrent-import rejection');
            } catch (RuntimeException $e) {
                $this->assertStringContainsString('already running', $e->getMessage());
            }
            $this->assertSame($count, DB::table('dataset_imports')->count());
        } finally {
            $other->selectOne('SELECT pg_advisory_unlock(hashtextextended(?,0))', [$key]);
            DB::purge('area_lock_test');
        }
    }

    private function import(OsmAreaDataset $dataset, array $rows, array $options = []): array
    {
        $this->write($rows);

        return app(OsmAreaImporter::class)->import($dataset, $this->directory.'/areas.json', $this->directory.'/boundary.json', $options + ['source_url' => 'https://example.org/region.osm.pbf']);
    }

    private function write(array $rows, array $extra = []): void
    {
        file_put_contents($this->directory.'/areas.json', json_encode($extra + ['osm3s' => ['timestamp_osm_base' => '2026-10-18T20:25:06Z'], 'elements' => $rows], JSON_THROW_ON_ERROR));
    }

    private function ring(): array
    {
        return [[92.5, 55.5], [93.2, 55.5], [93.2, 56.2], [92.5, 56.2], [92.5, 55.5]];
    }

    private function hole(): array
    {
        return [[92.7, 55.7], [92.9, 55.7], [92.9, 55.9], [92.7, 55.9], [92.7, 55.7]];
    }

    private function way(int $id, array $tags = ['natural' => 'water'], ?array $coordinates = null): array
    {
        return ['type' => 'way', 'id' => $id, 'version' => 2, 'timestamp' => '2026-10-01T00:00:00Z', 'tags' => $tags, 'geometry' => array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], $coordinates ?? $this->ring())];
    }

    private function member(int $id, string $role, array $ring): array
    {
        return ['type' => 'way', 'ref' => $id, 'role' => $role, 'geometry' => array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], $ring)];
    }

    private function relation(int $id): array
    {
        return ['type' => 'relation', 'id' => $id, 'tags' => ['type' => 'multipolygon', 'natural' => 'water'], 'members' => [$this->member(1, 'outer', $this->ring()), $this->member(2, 'inner', $this->hole())]];
    }

    private function boundary(array $rings): void
    {
        file_put_contents($this->directory.'/boundary.json', json_encode(['type' => 'Polygon', 'coordinates' => $rings], JSON_THROW_ON_ERROR));
    }
}
