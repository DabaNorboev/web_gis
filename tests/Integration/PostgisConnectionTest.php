<?php

namespace Tests\Integration;

use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\PostgisTestCase as TestCase;

class PostgisConnectionTest extends TestCase
{
    protected const READ_ONLY = true;

    public function test_read_only_session_rejects_persistent_table_writes(): void
    {
        $state = DB::selectOne("SELECT current_database() AS name,
            current_setting('transaction_read_only') AS read_only,
            current_setting('default_transaction_read_only') AS default_read_only");
        $this->assertSame('web_gis_test', $state->name);
        $this->assertSame('on', $state->read_only);
        $this->assertSame('on', $state->default_read_only);

        DB::beginTransaction();
        try {
            DB::statement('CREATE TABLE public.postgis_read_only_probe (id integer)');
            $this->fail('READ ONLY must reject persistent DDL.');
        } catch (QueryException $error) {
            $this->assertSame('25006', $error->errorInfo[0]);
        } finally {
            DB::rollBack();
        }
    }

    public function test_laravel_can_run_spatial_queries_in_the_test_database(): void
    {
        $this->assertSame('pgsql', DB::connection()->getDriverName());
        $this->assertSame('web_gis_test', DB::connection()->getDatabaseName());

        $result = DB::selectOne(<<<'SQL'
            SELECT
                current_database() AS database_name,
                PostGIS_Version() AS postgis_version,
                ST_Distance(
                    ST_SetSRID(ST_MakePoint(92.87, 56.01), 4326)::geography,
                    ST_SetSRID(ST_MakePoint(92.87, 56.011), 4326)::geography
                ) AS distance_m
            SQL);

        $this->assertSame('web_gis_test', $result->database_name);
        $this->assertNotEmpty($result->postgis_version);
        $this->assertGreaterThan(110, (float) $result->distance_m);
        $this->assertLessThan(113, (float) $result->distance_m);
    }
}
