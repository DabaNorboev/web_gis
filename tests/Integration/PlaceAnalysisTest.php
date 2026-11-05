<?php

namespace Tests\Integration;

use Illuminate\Support\Facades\DB;
use Tests\PostgisTestCase;

class PlaceAnalysisTest extends PostgisTestCase
{
    protected const READ_ONLY = true;

    public function test_read_budget_expires_safely_and_does_not_leak_to_the_next_transaction(): void
    {
        config(['app.debug' => true]);
        $before = DB::selectOne("SELECT current_setting('statement_timeout') AS timeout");
        $this->mock(\App\Services\Addresses\AddressResolverService::class, function ($m) {
            $m->shouldReceive('validateId')->once()->with('osm:node:1')->andReturn([]);
            $m->shouldReceive('snapshots')->once()->with(true)->andReturnUsing(function () {
                DB::select('SELECT pg_sleep(3) /* synthetic private canary */');
            });
            $m->shouldNotReceive('resolve');
        });
        \Illuminate\Support\Facades\Log::shouldReceive('error')->once()->with('Place analysis request failed.',
            ['exception_type' => \Illuminate\Database\QueryException::class]);
        $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'address', 'address_id' => 'osm:node:1']])
            ->assertStatus(503)->assertJsonPath('code', 'SERVICE_UNAVAILABLE')->assertDontSee('canary')
            ->assertHeader('Cache-Control', 'no-store, private');
        $this->assertEquals($before, DB::selectOne("SELECT current_setting('statement_timeout') AS timeout"));
    }

    public function test_real_geography_circle_at_both_limits_without_any_provider_coverage(): void
    {
        $before = DB::selectOne("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock");
        // Synthetic points, including a point far outside the service territory. No imports or fixtures.
        foreach ([[92.9, 56.0], [0.0, 0.0]] as [$lon, $lat]) {
            foreach ([200, 1000] as $radius) {
                $r = $this->postJson('/api/v1/place-analysis', [
                    'place' => ['kind' => 'point', 'lon' => $lon, 'lat' => $lat], 'radius_m' => $radius,
                ])->assertOk()->assertJsonPath('radius_m', $radius)
                    ->assertJsonPath('blocks.poi.coverage.status', 'UNKNOWN')->assertJsonPath('blocks.poi.data', null);
                $geometry = $r->json('analysis_area');
                $this->assertSame('Polygon', $geometry['type']);
                $ring = $geometry['coordinates'][0];
                $this->assertSame($ring[0], $ring[count($ring) - 1]);
                $this->assertGreaterThanOrEqual(32, count($ring));
                $shape = DB::selectOne(<<<'SQL'
                    WITH shape AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(?),4326) AS geom),
                    vertices AS (SELECT (ST_DumpPoints(geom)).geom AS vertex FROM shape)
                    SELECT ST_IsValid(geom) AS valid,
                        ST_Covers(geom, ST_SetSRID(ST_MakePoint(?,?),4326)) AS covers,
                        ST_XMin(Box3D(geom)) west, ST_YMin(Box3D(geom)) south,
                        ST_XMax(Box3D(geom)) east, ST_YMax(Box3D(geom)) north,
                        (SELECT min(ST_Distance(vertex::geography, ST_SetSRID(ST_MakePoint(?,?),4326)::geography)) FROM vertices) AS min_m,
                        (SELECT max(ST_Distance(vertex::geography, ST_SetSRID(ST_MakePoint(?,?),4326)::geography)) FROM vertices) AS max_m
                    FROM shape
                    SQL, [json_encode($geometry), $lon, $lat, $lon, $lat, $lon, $lat]);
                $this->assertTrue($shape->valid);
                $this->assertTrue($shape->covers);
                // ST_Buffer uses a local projection; check the geography radius within 0.3%.
                $this->assertEqualsWithDelta($radius, (float) $shape->min_m, $radius * .003);
                $this->assertEqualsWithDelta($radius, (float) $shape->max_m, $radius * .003);
                foreach (['west', 'south', 'east', 'north'] as $i => $axis) {
                    $this->assertEqualsWithDelta((float) $shape->$axis, $r->json('analysis_bounds')[$i], 1e-8);
                }
                foreach (['poi', 'satellite', 'air'] as $block) {
                    $r->assertJsonPath("blocks.$block.status", 'UNAVAILABLE')->assertJsonPath("blocks.$block.data", null);
                }
            }
        }
        $this->assertEquals($before, DB::selectOne("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock"));
    }
}
