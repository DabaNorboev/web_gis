<?php

namespace Tests\Integration;

use App\Services\Osm\Import\OsmBuildingImporter;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class OsmBuildingImportTest extends TestCase
{
    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || DB::connection()->getDatabaseName() !== 'web_gis_test') {
            throw new RuntimeException('Building tests require web_gis_test.');
        }
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        $this->directory = sys_get_temp_dir().'/web-gis-buildings-'.bin2hex(random_bytes(8));
        mkdir($this->directory);
        file_put_contents($this->directory.'/boundary.json', $this->encode(['type' => 'Polygon', 'coordinates' => [$this->ring(92, 55, 94, 57)]]));
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

    public function test_addressless_buildings_parts_holes_and_source_metadata_are_preserved(): void
    {
        $way = $this->way(1);
        $way['version'] = 3;
        $way['timestamp'] = '2026-01-01T00:00:00Z';
        $outer = $this->ring(92.7, 55.7, 93.3, 56.3);
        $hole = $this->ring(92.8, 55.8, 93.2, 56.2);
        $relation = $this->relation(10, [$this->member(20, 'outer', $outer), $this->member(21, 'inner', $hole)]);
        $result = $this->import([$way, $this->way(2, ['building:part' => 'yes']), $relation]);
        $this->assertSame(3, $result['report']['accepted_objects']);
        $this->assertSame(2, $result['report']['independent_building_objects']);
        $this->assertSame(1, $result['report']['parts']);
        $row = DB::table('osm_buildings')->where('osm_type', 'way')->where('osm_id', 1)->first();
        $this->assertSame(3, $row->osm_version);
        $this->assertSame(['building' => 'yes'], json_decode($row->raw_data, true)['tags']);
        $this->assertNull($row->count_exclusion);
        $geometry = DB::selectOne('SELECT ST_Equals(geom,ST_GeomFromGeoJSON(?)) AS equal FROM osm_buildings WHERE id=?', [$this->encode(['type' => 'Polygon', 'coordinates' => [$this->ring()]]), $row->id]);
        $this->assertTrue($geometry->equal);
        $geometry = DB::selectOne("SELECT ST_NumInteriorRings(ST_GeometryN(geom,1)) AS holes,ST_SRID(geom) AS srid FROM osm_buildings WHERE osm_type='relation' AND osm_id=10");
        $this->assertSame(1, $geometry->holes);
        $this->assertSame(4326, $geometry->srid);
        $import = DB::table('dataset_imports')->find($result['import_id']);
        $this->assertNull($import->observed_at);
        $this->assertSame('2026-10-19T10:34:32Z', $import->source_version);
        $this->assertSame('https://example.org/osm', $import->source_url);
        $this->assertSame('part', DB::table('osm_buildings')->where('osm_id', 2)->value('feature_kind'));
    }

    public function test_outer_member_exclusion_requires_membership_and_valid_covering_building_parent(): void
    {
        $small = $this->ring(92.8, 55.8, 92.9, 55.9);
        $second = $this->ring(93, 56, 93.1, 56.1);
        $way = $this->way(1, coordinates: $small);
        $relation = $this->relation(10, [$this->member(1, 'outer', $small), $this->member(99, 'outer', $second)]);
        $unrelated = $this->way(2, coordinates: $small);
        $partParent = $this->relation(11, [$this->member(3, 'outer', $small)], ['building:part' => 'yes']);
        $result = $this->import([$way, $unrelated, $this->way(3, coordinates: $small), $relation, $partParent]);
        $this->assertSame(3, $result['report']['independent_building_objects']);
        $this->assertSame([['source_id' => 'way/1', 'reason' => 'covered_outer_member', 'parent_osm_ids' => [10]]], $result['report']['count_exclusions']);
        $excluded = DB::table('osm_buildings')->where('osm_type', 'way')->where('osm_id', 1)->first();
        $this->assertEquals([['osm_id' => 10, 'role' => 'outer']], json_decode($excluded->parent_relations, true));
        $this->assertSame([10], json_decode($excluded->count_exclusion, true)['parent_osm_ids']);
        foreach ([2, 3] as $id) {
            $this->assertNull(DB::table('osm_buildings')->where('osm_type', 'way')->where('osm_id', $id)->value('count_exclusion'));
        }
        // A failed parent cannot suppress its valid member.
        $relation['members'][] = ['type' => 'relation', 'ref' => 99, 'role' => 'outer'];
        $result = $this->import([$way, $relation], ['allow_large_drop' => true]);
        $this->assertSame(1, $result['report']['independent_building_objects']);
        $this->assertSame([], $result['report']['count_exclusions']);
        $this->assertSame('unsupported_multipolygon_member', $result['report']['skipped'][0]['reason']);
    }

    public function test_partial_boundary_intersections_preserve_whole_geometry_and_boundary_holes_exclude_objects(): void
    {
        $crossing = $this->way(1, coordinates: $this->ring(93.9, 55.9, 94.1, 56.1));
        $result = $this->import([$crossing, $this->way(2, coordinates: $this->ring(95, 55.9, 96, 56.1))]);
        $this->assertSame(1, $result['report']['accepted_objects']);
        $row = DB::selectOne('SELECT crosses_boundary,ST_XMax(Box3D(geom)) AS east FROM osm_buildings WHERE dataset_import_id=?', [$result['import_id']]);
        $this->assertTrue($row->crosses_boundary);
        $this->assertEquals(94.1, $row->east);
        $this->assertSame('source_crosses_boundary', $result['report']['warnings'][0]['reason']);
        $this->assertSame('outside_boundary', $result['report']['skipped'][0]['reason']);
        file_put_contents($this->directory.'/boundary.json', $this->encode(['type' => 'Polygon', 'coordinates' => [$this->ring(92, 55, 94, 57), $this->ring(92.7, 55.7, 93.3, 56.3)]]));
        $second = $this->import([$crossing, $this->way(2)], ['allow_large_drop' => true]);
        $this->assertSame(1, $second['report']['accepted_objects']);
        $this->assertNotSame(DB::table('dataset_imports')->find($result['import_id'])->configuration_sha256, DB::table('dataset_imports')->find($second['import_id'])->configuration_sha256);
    }

    public function test_outer_membership_without_coverage_does_not_exclude_a_building(): void
    {
        $relation = $this->relation(10, [$this->member(1, 'outer', $this->ring(93.3, 56.3, 93.4, 56.4))]);
        $result = $this->import([$this->way(1), $relation]);
        $this->assertSame(2, $result['report']['independent_building_objects']);
        $this->assertSame([], $result['report']['count_exclusions']);
        $row = DB::table('osm_buildings')->where('osm_type', 'way')->first();
        $this->assertNotSame('[]', $row->parent_relations);
        $this->assertNull($row->count_exclusion);
    }

    public function test_concurrent_import_lock_refuses_publication_and_is_released_afterward(): void
    {
        $this->write([$this->way(1)]);
        config(['database.connections.building_lock_test' => DB::connection()->getConfig()]);
        $other = DB::connection('building_lock_test');
        $this->assertSame('web_gis_test', $other->getDatabaseName());
        $key = 'web_gis:OpenStreetMap:buildings';
        try {
            $other->selectOne('SELECT pg_advisory_lock(hashtextextended(?,0))', [$key]);
            try {
                app(OsmBuildingImporter::class)->import($this->directory.'/buildings.json', $this->directory.'/boundary.json');
                $this->fail('Expected import lock rejection');
            } catch (RuntimeException $e) {
                $this->assertStringContainsString('already running', $e->getMessage());
            }
            $this->assertSame(0, DB::table('osm_buildings')->count());
        } finally {
            $other->selectOne('SELECT pg_advisory_unlock(hashtextextended(?,0))', [$key]);
            DB::purge('building_lock_test');
        }
        $this->assertSame('dry-run', $this->import([$this->way(1)], ['dry_run' => true])['status']);
    }

    public function test_invalid_open_nested_and_point_objects_are_reported_without_repairs(): void
    {
        $point = ['type' => 'node', 'id' => 8, 'lon' => 92.9, 'lat' => 56, 'tags' => ['building' => 'yes']];
        $result = $this->import([
            $this->way(1), $point,
            $this->way(2, coordinates: [[92.8, 56], [93, 56], [93, 56.1]]),
            $this->way(3, coordinates: [[92.8, 56], [93, 56.1], [92.8, 56.1], [93, 56], [92.8, 56]]),
            $this->relation(4, [['type' => 'relation', 'ref' => 99, 'role' => 'outer']]),
        ]);
        $this->assertSame(1, $result['report']['accepted_objects']);
        $reasons = array_column($result['report']['skipped'], 'reason');
        foreach (['point_without_footprint', 'unclosed_ring', 'invalid_geometry', 'unsupported_multipolygon_member'] as $reason) {
            $this->assertContains($reason, $reasons);
        }
    }

    public function test_dry_run_repeat_history_and_independent_datasets_are_preserved(): void
    {
        $otherIds = [];
        foreach (['addresses', 'transport_stops:krasnoyarsk'] as $key) {
            $otherIds[] = DB::table('dataset_imports')->insertGetId(['source' => $key === 'addresses' ? 'OpenStreetMap' : '24bpd',
                'dataset_key' => $key, 'checksum_sha256' => str_repeat('a', 64), 'configuration_sha256' => str_repeat('b', 64),
                'configuration' => '{}', 'status' => 'succeeded', 'finished_at' => DB::raw('clock_timestamp()'), 'is_active' => true, 'row_count' => 0]);
        }
        $journal = DB::table('dataset_imports')->count();
        $this->assertSame('dry-run', $this->import([$this->way(1), $this->way(2)], ['dry_run' => true])['status']);
        $this->assertSame($journal, DB::table('dataset_imports')->count());
        $this->assertSame(0, DB::table('osm_buildings')->count());
        $first = $this->import([$this->way(1), $this->way(2)]);
        $this->assertSame('skipped', $this->import([$this->way(1), $this->way(2)])['status']);
        $second = $this->import([$this->way(3)], ['allow_large_drop' => true]);
        $historical = $this->import([$this->way(1), $this->way(2)]);
        $this->assertSame('skipped', $historical['status']);
        $this->assertFalse($historical['is_active']);
        $this->assertSame(2, DB::table('osm_buildings')->where('dataset_import_id', $first['import_id'])->count());
        $this->assertTrue(DB::table('dataset_imports')->find($second['import_id'])->is_active);
        $this->assertSame(2, DB::table('dataset_imports')->whereIn('id', $otherIds)->where('is_active', true)->count());
    }

    public function test_parts_cannot_mask_a_large_drop_in_independent_buildings(): void
    {
        $first = $this->import([$this->way(1), $this->way(2), $this->way(3, ['building:part' => 'yes'])]);
        $next = [$this->way(1), $this->way(3, ['building:part' => 'yes']), $this->way(4, ['building:part' => 'yes'])];
        $this->assertTrue($this->import($next, ['dry_run' => true])['report']['large_drop']);
        try {
            $this->import($next);
            $this->fail('Expected large-drop protection');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('20%', $e->getMessage());
        }
        $this->assertTrue(DB::table('dataset_imports')->find($first['import_id'])->is_active);
        $this->assertSame('succeeded', $this->import($next, ['allow_large_drop' => true])['status']);
    }

    public function test_publication_failure_rolls_back_all_new_objects_and_records_failure(): void
    {
        $first = $this->import([$this->way(1)]);
        DB::unprepared("CREATE FUNCTION pg_temp.reject_building() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''test building publication failure''; END';
            CREATE TRIGGER reject_building BEFORE INSERT ON osm_buildings FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_building()");
        try {
            $this->import([$this->way(2), $this->way(3)]);
            $this->fail('Expected publication failure');
        } catch (QueryException $e) {
            $this->assertStringContainsString('test building publication failure', $e->getMessage());
        }
        $this->assertSame(1, DB::table('osm_buildings')->count());
        $this->assertTrue(DB::table('dataset_imports')->find($first['import_id'])->is_active);
        $this->assertSame(1, DB::table('dataset_imports')->where('dataset_key', 'buildings')->where('status', 'failed')->count());
        DB::unprepared('DROP TRIGGER reject_building ON osm_buildings');
        $this->assertSame('succeeded', $this->import([$this->way(2), $this->way(3)])['status']);
    }

    public function test_duplicate_partial_bad_checksum_and_parts_only_inputs_never_replace_active_snapshot(): void
    {
        $first = $this->import([$this->way(1)]);
        foreach ([['elements' => [$this->way(1), $this->way(1)]], ['elements' => [$this->way(2)], 'remark' => 'runtime error: timed out'], ['elements' => [$this->way(2, ['building:part' => 'yes'])]]] as $document) {
            $this->write($document['elements'], $document);
            try {
                app(OsmBuildingImporter::class)->import($this->directory.'/buildings.json', $this->directory.'/boundary.json');
                $this->fail('Expected input rejection');
            } catch (RuntimeException $e) {
                $this->assertNotEmpty($e->getMessage());
            }
        }
        try {
            $this->import([$this->way(2)], ['expected_sha256' => str_repeat('0', 64)]);
            $this->fail('Expected checksum rejection');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('SHA-256', $e->getMessage());
        }
        $this->assertTrue(DB::table('dataset_imports')->find($first['import_id'])->is_active);
        $this->assertSame(1, DB::table('osm_buildings')->count());
    }

    public function test_command_requires_boundary_and_writes_verified_dry_run_report(): void
    {
        $this->write([$this->way(1)]);
        $this->artisan('osm:import-buildings', ['file' => $this->directory.'/buildings.json'])->assertFailed();
        $this->artisan('osm:import-buildings', ['file' => $this->directory.'/buildings.json', '--boundary' => $this->directory.'/boundary.json',
            '--dry-run' => true, '--report' => $this->directory.'/report.json', '--expected-sha256' => hash_file('sha256', $this->directory.'/buildings.json')])->assertSuccessful();
        $this->assertSame('dry-run', json_decode(file_get_contents($this->directory.'/report.json'), true)['status']);
        $this->assertSame(0, DB::table('osm_buildings')->count());
    }

    public function test_schema_rejects_invalid_identity_geometry_metadata_and_count_exclusions(): void
    {
        $result = $this->import([$this->way(1)]);
        $row = DB::table('osm_buildings')->where('dataset_import_id', $result['import_id'])->first();
        foreach ([['osm_id' => 0], ['osm_type' => 'node'], ['osm_version' => 0], ['feature_kind' => 'part'],
            ['geom' => DB::raw("ST_GeomFromText('POINT(92.9 56)',4326)")], ['geom' => DB::raw("ST_GeomFromText('POLYGON EMPTY',4326)")],
            ['raw_data' => '{}'], ['parent_relations' => '{}'], ['count_exclusion' => '{"parent_osm_ids":[10]}'],
            ['count_exclusion' => '{"reason":"covered_outer_member","parent_osm_ids":[]}']] as $change) {
            try {
                DB::transaction(fn () => DB::table('osm_buildings')->where('id', $row->id)->update($change));
                $this->fail('Expected schema constraint');
            } catch (QueryException $e) {
                $this->assertSame('23514', $e->errorInfo[0]);
            }
        }
        try {
            $copy = (array) $row;
            $copy['id'] = $row->id + 1000000;
            DB::transaction(fn () => DB::table('osm_buildings')->insert($copy));
            $this->fail('Expected unique identity');
        } catch (QueryException $e) {
            $this->assertSame('23505', $e->errorInfo[0]);
        }
    }

    public function test_migration_reverses_only_in_an_isolated_test_schema(): void
    {
        DB::statement('CREATE SCHEMA building_migration_test');
        DB::statement('SET LOCAL search_path TO building_migration_test,public');
        DB::statement('CREATE TABLE building_migration_test.dataset_imports (id bigint PRIMARY KEY)');
        $migration = require database_path('migrations/2026_10_19_000001_create_osm_buildings_table.php');
        $migration->up();
        $this->assertCount(5, DB::select("SELECT indexname FROM pg_indexes WHERE schemaname='building_migration_test' AND tablename='osm_buildings'"));
        $migration->down();
        $this->assertNull(DB::selectOne("SELECT to_regclass('building_migration_test.osm_buildings') name")->name);
        $migration->up();
        $this->assertNotNull(DB::selectOne("SELECT to_regclass('building_migration_test.osm_buildings') name")->name);
    }

    private function import(array $elements, array $options = []): array
    {
        $this->write($elements);

        return app(OsmBuildingImporter::class)->import($this->directory.'/buildings.json', $this->directory.'/boundary.json', $options + ['source_url' => 'https://example.org/osm']);
    }

    private function write(array $elements, array $extra = []): void
    {
        file_put_contents($this->directory.'/buildings.json', $this->encode($extra + ['osm3s' => ['timestamp_osm_base' => '2026-10-19T10:34:32Z'], 'elements' => $elements]));
    }

    private function way(int $id, array $tags = [], ?array $coordinates = null): array
    {
        return ['type' => 'way', 'id' => $id, 'tags' => array_replace(['building' => 'yes'], $tags), 'geometry' => $this->coordinates($coordinates ?? $this->ring())];
    }

    private function relation(int $id, array $members, array $tags = []): array
    {
        return ['type' => 'relation', 'id' => $id, 'tags' => array_replace(['building' => 'yes', 'type' => 'multipolygon'], $tags), 'members' => $members];
    }

    private function member(int $id, string $role, array $coordinates): array
    {
        return ['type' => 'way', 'ref' => $id, 'role' => $role, 'geometry' => $this->coordinates($coordinates)];
    }

    private function ring(float $west = 92.8, float $south = 55.8, float $east = 93.2, float $north = 56.2): array
    {
        return [[$west, $south], [$east, $south], [$east, $north], [$west, $north], [$west, $south]];
    }

    private function coordinates(array $points): array
    {
        return array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], $points);
    }

    private function encode(array $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    }
}
