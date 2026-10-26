<?php

namespace Tests\Integration;

use App\Services\Osm\Import\OsmAddressImporter;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class OsmAddressImportTest extends TestCase
{
    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || DB::connection()->getDatabaseName() !== 'web_gis_test') {
            throw new RuntimeException('Address tests require web_gis_test.');
        }
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        $this->directory = sys_get_temp_dir().'/web-gis-addresses-'.bin2hex(random_bytes(8));
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

    public function test_import_preserves_source_identity_parts_metadata_and_node_coordinates(): void
    {
        $result = $this->import([$this->node(1, ['addr:housenumber' => '10/2А', 'addr:housenumber2' => '8', 'addr:city' => 'Солонцы'])]);
        $row = DB::table('osm_addresses')->where('dataset_import_id', $result['import_id'])->first();
        $this->assertSame('node', $row->osm_type);
        $this->assertSame(1, $row->osm_id);
        $this->assertSame('10/2А', $row->house_number);
        $this->assertSame('Солонцы', $row->locality);
        $this->assertSame('Солонцы, проспект Мира, 10/2А', $row->label);
        $this->assertSame('8', json_decode($row->raw_data, true)['tags']['addr:housenumber2']);
        $point = DB::selectOne('SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat, ST_SRID(source_geom) AS srid FROM osm_addresses WHERE id=?', [$row->id]);
        $this->assertEquals(92.9, $point->lon);
        $this->assertEquals(56, $point->lat);
        $this->assertSame(4326, $point->srid);
        $this->assertSame('osm_node', $row->point_method);
        $metadata = DB::table('dataset_imports')->find($result['import_id']);
        $this->assertNull($metadata->observed_at);
        $this->assertSame('2026-10-18T08:33:06Z', $metadata->source_version);
        $this->assertSame(1, $metadata->row_count);
        $this->assertSame(64, strlen($metadata->checksum_sha256));
    }

    public function test_associated_street_priority_conflicts_missing_parts_and_same_labels(): void
    {
        $relations = [
            $this->associated(100, 'улица Ленина', [1, 2, 3]),
            $this->associated(101, 'улица Другая', [2]),
        ];
        $result = $this->import(array_merge($relations, [
            $this->node(1, ['addr:street' => '']),
            $this->node(2, ['addr:street' => '']),
            $this->node(3, ['addr:street' => '', 'addr:place' => 'Остров']),
            $this->node(4), $this->node(5),
            $this->node(6, ['addr:housenumber' => '', 'addr:full' => 'улица Ленина, 8']),
        ]));
        $report = $result['report'];
        $this->assertSame(4, $report['accepted_addresses']);
        $this->assertSame(2, $report['auxiliary_relations']);
        $this->assertSame('ambiguous_associated_street', $report['skipped'][0]['reason']);
        $rows = DB::table('osm_addresses')->where('dataset_import_id', $result['import_id'])->orderBy('osm_id')->get()->keyBy('osm_id');
        $this->assertSame('улица Ленина', $rows[1]->street);
        $this->assertSame('associatedStreet', json_decode($rows[1]->raw_data, true)['address_resolution']['method']);
        $this->assertNull($rows[3]->street);
        $this->assertSame('Остров', $rows[3]->place);
        $this->assertSame($rows[4]->label, $rows[5]->label);
        $this->assertNull($rows[4]->locality);
    }

    public function test_complete_multipolygon_keeps_hole_and_derives_an_interior_point(): void
    {
        $outer = [[92.8, 55.9], [93, 55.9], [93, 56.1], [92.8, 56.1], [92.8, 55.9]];
        $hole = [[92.85, 55.95], [92.95, 55.95], [92.95, 56.05], [92.85, 56.05], [92.85, 55.95]];
        $relation = $this->relation(5, [
            $this->member(1, 'outer', array_slice($outer, 0, 3)),
            $this->member(2, 'outer', array_reverse(array_slice($outer, 2))),
            $this->member(3, 'inner', $hole),
        ]);
        $result = $this->import([$relation]);
        $row = DB::selectOne('SELECT ST_NumInteriorRings(ST_GeometryN(source_geom,1)) AS holes, ST_Covers(source_geom,geom) AS covered, point_method FROM osm_addresses WHERE dataset_import_id=?', [$result['import_id']]);
        $this->assertSame(1, $row->holes);
        $this->assertTrue($row->covered);
        $this->assertSame('point_on_surface', $row->point_method);
    }

    public function test_incomplete_invalid_outside_and_unsupported_geometries_are_reported_without_repairs(): void
    {
        $open = $this->way(2, [[92.8, 56], [92.9, 56], [92.9, 56.1]]);
        $bowtie = $this->way(3, [[92.8, 56], [92.9, 56.1], [92.8, 56.1], [92.9, 56], [92.8, 56]]);
        $unsupported = $this->relation(4, [['type' => 'relation', 'ref' => 99, 'role' => 'outer']]);
        $incomplete = $this->relation(5, [$this->member(5, 'outer', [[92.8, 56], [92.9, 56]])]);
        $result = $this->import([$this->node(1), $open, $bowtie, $unsupported, $incomplete,
            array_replace($this->node(6), ['lon' => 200]), array_replace($this->node(7), ['lon' => 95]),
            $this->relation(8, [$this->member(8, 'outer', [[92.8, 56], [92.9, 56], [92.9, 56.1], [92.8, 56]]), $this->member(9, 'inner', [[93.1, 56], [93.2, 56], [93.2, 56.1], [93.1, 56]])]),
        ]);
        $this->assertSame(1, $result['report']['accepted_addresses']);
        $reasons = array_column($result['report']['skipped'], 'reason');
        foreach (['unclosed_ring', 'invalid_geometry', 'unsupported_multipolygon_member', 'incomplete_or_ambiguous_ring', 'invalid_or_missing_coordinates', 'outside_boundary', 'unassigned_or_ambiguous_inner_ring'] as $reason) {
            $this->assertContains($reason, $reasons);
        }
    }

    public function test_dry_run_repeat_new_snapshot_and_historical_repeat_are_isolated_from_stops(): void
    {
        $before = DB::table('dataset_imports')->count();
        $this->assertSame('dry-run', $this->import([$this->node(1), $this->node(2)], ['dry_run' => true])['status']);
        $this->assertSame($before, DB::table('dataset_imports')->count());
        $first = $this->import([$this->node(1), $this->node(2)]);
        $this->assertSame('skipped', $this->import([$this->node(1), $this->node(2)])['status']);
        $second = $this->import([$this->node(1, ['addr:housenumber' => '20'])], ['allow_large_drop' => true]);
        $this->assertSame('skipped', $this->import([$this->node(1), $this->node(2)])['status']);
        $this->assertFalse(DB::table('dataset_imports')->find($first['import_id'])->is_active);
        $this->assertTrue(DB::table('dataset_imports')->find($second['import_id'])->is_active);
        $this->assertSame(2, DB::table('osm_addresses')->where('dataset_import_id', $first['import_id'])->count());
        $this->assertSame(1, DB::table('osm_addresses')->where('dataset_import_id', $second['import_id'])->count());
    }

    public function test_large_drop_and_publication_failure_keep_previous_active_snapshot(): void
    {
        $first = $this->import([$this->node(1), $this->node(2)]);
        try {
            $this->import([$this->node(1)]);
            $this->fail('Expected drop protection');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('20%', $e->getMessage());
        }
        DB::unprepared("CREATE FUNCTION pg_temp.reject_osm_address() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''test publication failure''; END';
            CREATE TRIGGER reject_osm_address BEFORE INSERT ON osm_addresses FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_osm_address()");
        try {
            $this->import([$this->node(3), $this->node(4)]);
            $this->fail('Expected insert failure');
        } catch (QueryException $e) {
            $this->assertStringContainsString('test publication failure', $e->getMessage());
        }
        $this->assertTrue(DB::table('dataset_imports')->find($first['import_id'])->is_active);
        $this->assertSame(2, DB::table('osm_addresses')->whereIn('dataset_import_id', DB::table('dataset_imports')->where('source', OsmAddressImporter::SOURCE)->pluck('id'))->count());
        $this->assertSame(2, DB::table('dataset_imports')->where('source', OsmAddressImporter::SOURCE)->where('status', 'failed')->count());
        DB::unprepared('DROP TRIGGER reject_osm_address ON osm_addresses');
        $this->assertSame('succeeded', $this->import([$this->node(3), $this->node(4)])['status']);
    }

    public function test_duplicate_identity_and_empty_snapshot_cannot_be_published(): void
    {
        $first = $this->import([$this->node(1)]);
        foreach ([[$this->node(1), $this->node(1)], [$this->node(2, ['addr:street' => ''])]] as $rows) {
            try {
                $this->import($rows);
                $this->fail('Expected rejected snapshot');
            } catch (RuntimeException $e) {
                $this->assertNotEmpty($e->getMessage());
            }
        }
        $this->assertTrue(DB::table('dataset_imports')->find($first['import_id'])->is_active);
    }

    public function test_boundary_hash_changes_snapshot_identity_and_point_filter_is_not_a_bounding_box(): void
    {
        $first = $this->import([$this->node(1), $this->node(2)]);
        $beforeStops = DB::table('transport_stops')->count();
        $boundary = ['type' => 'Polygon', 'coordinates' => [[[92.8, 55.9], [93, 55.9], [93, 56.1], [92.8, 56.1], [92.8, 55.9]], [[92.85, 55.95], [92.95, 55.95], [92.95, 56.05], [92.85, 56.05], [92.85, 55.95]]]];
        file_put_contents($this->directory.'/boundary.json', $this->encode($boundary));
        $second = $this->import([array_replace($this->node(1), ['lon' => 92.81]), $this->node(2)], ['allow_large_drop' => true]);
        $this->assertSame(1, $second['report']['accepted_addresses']);
        $this->assertSame('outside_boundary', $second['report']['skipped'][0]['reason']);
        $a = DB::table('dataset_imports')->find($first['import_id']);
        $b = DB::table('dataset_imports')->find($second['import_id']);
        $this->assertNotSame($a->configuration_sha256, $b->configuration_sha256);
        $this->assertSame($beforeStops, DB::table('transport_stops')->count());
    }

    public function test_command_requires_boundary_and_writes_dry_run_report(): void
    {
        $this->write([$this->node(1)]);
        $this->artisan('osm:import-addresses', ['file' => $this->directory.'/addresses.json'])->assertFailed();
        $this->artisan('osm:import-addresses', ['file' => $this->directory.'/addresses.json', '--boundary' => $this->directory.'/boundary.json', '--dry-run' => true, '--report' => $this->directory.'/report.json'])->assertSuccessful();
        $this->assertSame('dry-run', json_decode(file_get_contents($this->directory.'/report.json'), true)['status']);
    }

    public function test_database_constraints_reject_invalid_identity_geometry_and_cross_snapshot_duplicates(): void
    {
        $result = $this->import([$this->node(1)]);
        $row = DB::table('osm_addresses')->where('dataset_import_id', $result['import_id'])->first();
        $changes = [
            ['osm_id' => 0], ['osm_type' => 'other'], ['osm_version' => 0], ['house_number' => ''],
            ['street' => null, 'place' => null], ['point_method' => 'entrance'],
            ['geom' => DB::raw('ST_SetSRID(ST_MakePoint(92.91,56),4326)')],
            ['source_geom' => DB::raw("ST_GeomFromText('POINT EMPTY',4326)")],
            ['source_geom' => DB::raw("ST_GeomFromText('POINT(200 56)',4326)")],
            ['raw_data' => '[]'],
        ];
        foreach ($changes as $change) {
            try {
                DB::transaction(fn () => DB::table('osm_addresses')->where('id', $row->id)->update($change));
                $this->fail('Expected a schema constraint violation');
            } catch (QueryException $error) {
                $this->assertSame('23514', $error->errorInfo[0]);
            }
        }
        try {
            DB::transaction(fn () => DB::statement('INSERT INTO osm_addresses SELECT (SELECT max(id)+1 FROM osm_addresses), dataset_import_id, osm_type, osm_id, osm_version, osm_updated_at, street, place, house_number, locality, postcode, label, source_geom, geom, point_method, raw_data FROM osm_addresses WHERE id=?', [$row->id]));
            $this->fail('Expected unique source identity');
        } catch (QueryException $error) {
            $this->assertSame('23505', $error->errorInfo[0]);
        }
    }

    public function test_address_migration_is_reversible_only_in_an_isolated_test_schema(): void
    {
        DB::statement('CREATE SCHEMA address_migration_test');
        DB::statement('SET LOCAL search_path TO address_migration_test, public');
        DB::statement('CREATE TABLE address_migration_test.dataset_imports (id bigint PRIMARY KEY)');
        $migration = require database_path('migrations/2026_10_18_000001_create_osm_addresses_table.php');
        $migration->up();
        $indexes = DB::select("SELECT indexdef FROM pg_indexes WHERE schemaname='address_migration_test' AND tablename='osm_addresses'");
        $this->assertCount(6, $indexes);
        $migration->down();
        $this->assertNull(DB::selectOne("SELECT to_regclass('address_migration_test.osm_addresses') AS name")->name);
        $migration->up();
        $this->assertNotNull(DB::selectOne("SELECT to_regclass('address_migration_test.osm_addresses') AS name")->name);
    }

    private function import(array $elements, array $options = []): array
    {
        $this->write($elements);

        return app(OsmAddressImporter::class)->import($this->directory.'/addresses.json', $this->directory.'/boundary.json', $options);
    }

    private function write(array $elements): void
    {
        file_put_contents($this->directory.'/addresses.json', $this->encode(['osm3s' => ['timestamp_osm_base' => '2026-10-18T08:33:06Z'], 'elements' => $elements]));
    }

    private function node(int $id, array $tags = []): array
    {
        return ['type' => 'node', 'id' => $id, 'lon' => 92.9, 'lat' => 56.0, 'version' => 1, 'timestamp' => '2025-01-01T00:00:00Z', 'tags' => array_replace(['addr:street' => 'проспект Мира', 'addr:housenumber' => '10'], $tags)];
    }

    private function way(int $id, array $coordinates): array
    {
        return ['type' => 'way', 'id' => $id, 'tags' => $this->node(1)['tags'], 'geometry' => $this->coordinates($coordinates)];
    }

    private function relation(int $id, array $members): array
    {
        return ['type' => 'relation', 'id' => $id, 'tags' => $this->node(1)['tags'] + ['type' => 'multipolygon'], 'members' => $members];
    }

    private function member(int $id, string $role, array $coordinates): array
    {
        return ['type' => 'way', 'ref' => $id, 'role' => $role, 'geometry' => $this->coordinates($coordinates)];
    }

    private function coordinates(array $coordinates): array
    {
        return array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], $coordinates);
    }

    private function associated(int $id, string $name, array $nodes): array
    {
        return ['type' => 'relation', 'id' => $id, 'tags' => ['type' => 'associatedStreet', 'name' => $name], 'members' => array_map(fn ($id) => ['type' => 'node', 'ref' => $id, 'role' => 'house'], $nodes)];
    }

    private function encode(array $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    }
}
