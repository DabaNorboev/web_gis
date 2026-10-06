<?php

namespace Tests\Integration;

use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class PostgisConnectionTest extends TestCase
{
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
