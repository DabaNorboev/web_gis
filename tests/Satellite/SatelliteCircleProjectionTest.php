<?php

namespace Tests\Satellite;

use App\Services\Satellite\SatelliteCatalogReader;
use Illuminate\Support\Facades\DB;
use Tests\PostgisTestCase;

/** Explicit read-only PostGIS invocation; not part of the ordinary sqlite suite. */
class SatelliteCircleProjectionTest extends PostgisTestCase
{
    protected const READ_ONLY = true;

    public function test_public_wgs_point_uses_same_native_circle_as_postgis_projection(): void
    {
        $root = base_path('data/satellite/runtime/krasnoyarsk-2024-2026-a10-1-v1');
        $sha = getenv('SATELLITE_RUNTIME_SHA256');
        if (! $sha || ! is_file($root.'/catalog.json')) {
            $this->markTestSkipped('Explicit real runtime pin required.');
        }
        $reader = new SatelliteCatalogReader($root, $sha);
        $expected = $reader->forProjectedPoint(497230, 6209920, 1000);
        $point = DB::selectOne('SELECT ST_X(p) AS lon, ST_Y(p) AS lat FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(497230,6209920),32646),4326) AS p) AS point');
        $actual = $reader->forPoint((float) $point->lon, (float) $point->lat, 1000);
        $this->assertSame($expected['available_dates'], $actual['available_dates']);
        foreach ($expected['releases'] as $i => $release) {
            $this->assertEquals($release['coverage'], $actual['releases'][$i]['coverage']);
            $this->assertEqualsWithDelta($release['mean_ndvi'], $actual['releases'][$i]['mean_ndvi'], 1e-12);
        }
        $this->assertSame('web_gis_test', DB::selectOne('SELECT current_database() AS name')->name);
        $this->assertSame('on', DB::selectOne("SELECT current_setting('default_transaction_read_only') AS mode")->mode);
    }
}
