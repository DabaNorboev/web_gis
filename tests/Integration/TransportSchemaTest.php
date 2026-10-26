<?php

namespace Tests\Integration;

use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class TransportSchemaTest extends TestCase
{
    private int $sequence = 0;

    protected function setUp(): void
    {
        parent::setUp();

        $this->assertSame('pgsql', DB::connection()->getDriverName());
        $this->assertSame('web_gis_test', DB::connection()->getDatabaseName());
        $this->artisan('migrate', ['--force' => true])->assertExitCode(0);
        DB::beginTransaction();
    }

    protected function tearDown(): void
    {
        while (DB::transactionLevel() > 0) {
            DB::rollBack();
        }

        parent::tearDown();
    }

    public function test_fixture_writes_are_allowed_only_in_the_writable_test_database(): void
    {
        $state = DB::selectOne("SELECT current_database() AS name,
            current_setting('transaction_read_only') AS read_only,
            current_setting('default_transaction_read_only') AS default_read_only");
        $this->assertSame('web_gis_test', $state->name);
        $this->assertSame('off', $state->read_only);
        $this->assertSame('off', $state->default_read_only);

        $id = $this->createImport();
        $this->assertNotNull(DB::table('dataset_imports')->find($id));
    }

    public function test_snapshot_preserves_source_metadata_raw_data_and_distances_in_metres(): void
    {
        $import = $this->createImport(['source_updated_at' => '2025-05-31T00:00:00Z']);
        $stop = $this->createStop($import, '2535');
        $metadata = DB::table('dataset_imports')->find($import);

        $this->assertNull($metadata->observed_at);
        $this->assertNotNull($metadata->source_updated_at);
        $this->assertSame('running', $metadata->status);

        $point = DB::selectOne(<<<'SQL'
            SELECT ST_SRID(geom) AS srid, ST_X(geom) AS lon, ST_Y(geom) AS lat,
                raw_data->>'id' AS original_id,
                ST_Distance(geom::geography,
                    ST_SetSRID(ST_MakePoint(92.87, 56.011), 4326)::geography) AS distance_m,
                ST_DWithin(geom::geography,
                    ST_SetSRID(ST_MakePoint(92.87, 56.011), 4326)::geography, 500) AS in_radius
            FROM transport_stops WHERE id = ?
            SQL, [$stop]);

        $this->assertSame(4326, $point->srid);
        $this->assertEquals(92.87, $point->lon);
        $this->assertEquals(56.01, $point->lat);
        $this->assertSame('2535', $point->original_id);
        $this->assertGreaterThan(110, (float) $point->distance_m);
        $this->assertLessThan(113, (float) $point->distance_m);
        $this->assertTrue($point->in_radius);

        $indexes = DB::select(<<<'SQL'
            SELECT c.relname AS name, am.amname AS method, i.indisvalid AS valid,
                pg_get_expr(i.indexprs, i.indrelid) AS expression
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_am am ON am.oid = c.relam
            WHERE i.indrelid = 'transport_stops'::regclass AND am.amname = 'gist'
            SQL);
        $this->assertCount(2, $indexes);
        foreach ($indexes as $index) {
            $this->assertTrue($index->valid);
        }
        $geography = collect($indexes)->firstWhere('name', 'transport_stops_geography_index');
        $this->assertNotNull($geography);
        $this->assertStringContainsString('geography', $geography->expression);
    }

    public function test_stop_identity_is_unique_within_a_snapshot_and_preserved_between_snapshots(): void
    {
        $first = $this->createImport();
        $second = $this->createImport();
        $this->createStop($first, '2535');
        $this->createStop($second, '2535');

        $this->assertSame(2, DB::table('transport_stops')->where('source_id', '2535')->count());
        $this->assertRejected(fn () => $this->createStop($first, '2535'), '23505');
        $this->assertRejected(fn () => DB::table('dataset_imports')->where('id', $first)->delete(), '23503');
    }

    public function test_equal_route_numbers_in_different_modes_remain_distinct(): void
    {
        $import = $this->createImport();
        $this->createRoute($import, 'bus:7', 'bus', '7');
        $this->createRoute($import, 'tram:7', 'tram', '7');

        $this->assertSame(2, DB::table('transport_routes')->where('ref', '7')->count());
        $this->assertRejected(fn () => $this->createRoute($import, 'other-bus:7', 'bus', '7'), '23505');
        $this->assertRejected(fn () => $this->createRoute($import, 'boat:7', 'boat', '7'), '23514');
    }

    public function test_stop_route_links_cannot_duplicate_or_mix_snapshots(): void
    {
        $first = $this->createImport();
        $second = $this->createImport();
        $stop = $this->createStop($first, '2535');
        $route = $this->createRoute($first, 'bus:7', 'bus', '7');
        $foreignRoute = $this->createRoute($second, 'bus:7', 'bus', '7');
        $link = ['dataset_import_id' => $first, 'transport_stop_id' => $stop, 'transport_route_id' => $route];

        DB::table('transport_stop_routes')->insert($link);
        $this->assertRejected(fn () => DB::table('transport_stop_routes')->insert($link), '23505');
        $this->assertRejected(fn () => DB::table('transport_stop_routes')->insert([
            ...$link, 'transport_route_id' => $foreignRoute,
        ]), '23503');
        $this->assertRejected(fn () => DB::table('transport_stop_routes')->insert([
            ...$link, 'dataset_import_id' => $second, 'transport_route_id' => $foreignRoute,
        ]), '23503');
    }

    public function test_invalid_import_metadata_is_rejected(): void
    {
        foreach ([
            ['source' => ' '],
            ['checksum_sha256' => 'bad'],
            ['configuration_sha256' => 'bad'],
            ['configuration' => '[]'],
            ['status' => 'unknown'],
            ['is_active' => true],
            ['status' => 'failed'],
            ['finished_at' => '2026-10-07T01:00:00Z'],
            ['status' => 'succeeded', 'finished_at' => '2026-10-06T00:00:00Z'],
            ['row_count' => -1],
        ] as $invalid) {
            $this->assertRejected(fn () => $this->createImport($invalid), '23514');
        }
    }

    public function test_only_nonempty_two_dimensional_wgs84_points_are_accepted(): void
    {
        $import = $this->createImport();
        foreach ([
            ['SRID=3857;POINT(92 56)', '22023'],
            ['SRID=4326;LINESTRING(92 56,93 57)', '22023'],
            ['SRID=4326;POINT Z(92 56 1)', '22023'],
            ['SRID=4326;POINT EMPTY', '23514'],
            ['SRID=4326;POINT(181 56)', '23514'],
            ['SRID=4326;POINT(92 91)', '23514'],
        ] as [$ewkt, $sqlState]) {
            $this->assertRejected(fn () => DB::table('transport_stops')->insert([
                'dataset_import_id' => $import,
                'source_id' => 'invalid',
                'geom' => DB::raw("ST_GeomFromEWKT('$ewkt')"),
                'raw_data' => '{}',
            ]), $sqlState);
        }
    }

    public function test_successful_input_is_idempotent_but_failed_attempt_can_be_retried(): void
    {
        $input = ['checksum_sha256' => hash('sha256', 'same-file')];
        $this->createImport([...$input, 'status' => 'failed', 'finished_at' => '2026-10-07T01:00:00Z']);
        $this->createImport([...$input, 'status' => 'succeeded', 'finished_at' => '2026-10-07T01:00:00Z']);

        $this->assertRejected(fn () => $this->createImport([
            ...$input, 'status' => 'succeeded', 'finished_at' => '2026-10-07T01:00:00Z',
        ]), '23505');

        $this->createImport([
            ...$input,
            'configuration_sha256' => hash('sha256', 'new-boundary-or-parser'),
            'configuration' => '{"importer_version":2}',
            'status' => 'succeeded',
            'finished_at' => '2026-10-07T01:00:00Z',
        ]);
        $this->assertSame(3, DB::table('dataset_imports')->where('checksum_sha256', $input['checksum_sha256'])->count());
    }

    public function test_only_one_successful_snapshot_can_be_active_for_a_dataset(): void
    {
        $this->createImport(['status' => 'succeeded', 'is_active' => true, 'finished_at' => '2026-10-07T01:00:00Z']);
        $this->assertRejected(fn () => $this->createImport([
            'status' => 'succeeded', 'is_active' => true, 'finished_at' => '2026-10-07T01:00:00Z',
        ]), '23505');

        $this->createImport([
            'source' => 'another-source', 'status' => 'succeeded', 'is_active' => true,
            'finished_at' => '2026-10-07T01:00:00Z',
        ]);
    }

    public function test_failed_publication_preserves_the_previous_snapshot_and_success_switches_it(): void
    {
        $old = $this->createImport([
            'status' => 'succeeded', 'is_active' => true, 'finished_at' => '2026-10-07T01:00:00Z',
        ]);
        $this->createStop($old, '2535');
        $next = $this->createImport();

        try {
            DB::transaction(function () use ($old, $next) {
                $this->createStop($next, '2535');
                $this->activate($old, $next);

                throw new RuntimeException('Simulated import failure');
            });
            $this->fail('Expected the simulated import failure.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Simulated import failure', $exception->getMessage());
        }

        $this->assertTrue(DB::table('dataset_imports')->find($old)->is_active);
        $this->assertSame('running', DB::table('dataset_imports')->find($next)->status);
        $this->assertSame(0, DB::table('transport_stops')->where('dataset_import_id', $next)->count());

        DB::transaction(function () use ($old, $next) {
            $this->createStop($next, '2535');
            $this->activate($old, $next);
        });

        $this->assertFalse(DB::table('dataset_imports')->find($old)->is_active);
        $this->assertTrue(DB::table('dataset_imports')->find($next)->is_active);
        $this->assertSame(2, DB::table('transport_stops')->where('source_id', '2535')->count());
        $this->assertSame(1, DB::table('transport_stops as s')
            ->join('dataset_imports as i', 'i.id', '=', 's.dataset_import_id')
            ->where('i.is_active', true)->count());
    }

    public function test_gis_migrations_can_be_rolled_back_and_reapplied_without_removing_postgis(): void
    {
        DB::statement('CREATE SCHEMA stage1_migration_check');
        DB::statement('SET LOCAL search_path TO stage1_migration_check, public');

        $migrations = array_map(fn (string $path) => require $path, glob(database_path('migrations/2026_10_07_*.php')));
        foreach ($migrations as $migration) {
            $migration->up();
        }

        $this->assertSame(4, $this->isolatedTableCount());
        foreach (array_reverse($migrations) as $migration) {
            $migration->down();
        }

        $this->assertSame(0, $this->isolatedTableCount());
        $this->assertNotEmpty(DB::selectOne('SELECT PostGIS_Version() AS version')->version);
        foreach ($migrations as $migration) {
            $migration->up();
        }
        $this->assertSame(4, $this->isolatedTableCount());
    }

    private function isolatedTableCount(): int
    {
        return (int) DB::selectOne(<<<'SQL'
            SELECT count(*) AS total FROM information_schema.tables
            WHERE table_schema = 'stage1_migration_check' AND table_type = 'BASE TABLE'
            SQL)->total;
    }

    private function createImport(array $overrides = []): int
    {
        return DB::table('dataset_imports')->insertGetId([
            'source' => 'official-fixture',
            'dataset_key' => 'transport_stops:krasnoyarsk',
            'checksum_sha256' => hash('sha256', 'fixture-'.++$this->sequence),
            'configuration_sha256' => hash('sha256', 'fixture-config'),
            'configuration' => '{"importer_version":1}',
            'started_at' => '2026-10-07T00:00:00Z',
            ...$overrides,
        ]);
    }

    private function createStop(int $import, string $sourceId): int
    {
        return DB::table('transport_stops')->insertGetId([
            'dataset_import_id' => $import,
            'source_id' => $sourceId,
            'name' => 'Test stop',
            'geom' => DB::raw('ST_SetSRID(ST_MakePoint(92.87, 56.01), 4326)'),
            'raw_data' => json_encode(['id' => $sourceId], JSON_THROW_ON_ERROR),
        ]);
    }

    private function createRoute(int $import, string $sourceId, string $mode, string $ref): int
    {
        return DB::table('transport_routes')->insertGetId([
            'dataset_import_id' => $import, 'source_id' => $sourceId,
            'mode' => $mode, 'ref' => $ref, 'raw_data' => '{}',
        ]);
    }

    private function activate(int $old, int $next): void
    {
        DB::table('dataset_imports')->where('id', $old)->update(['is_active' => false]);
        DB::table('dataset_imports')->where('id', $next)->update([
            'status' => 'succeeded', 'is_active' => true, 'finished_at' => '2026-10-07T01:00:00Z',
            'row_count' => 1,
        ]);
    }

    private function assertRejected(callable $operation, string $sqlState): void
    {
        try {
            DB::transaction($operation);
        } catch (QueryException $exception) {
            $this->assertSame($sqlState, $exception->errorInfo[0]);

            return;
        }

        $this->fail('Expected PostgreSQL to reject the operation with SQLSTATE '.$sqlState);
    }
}
