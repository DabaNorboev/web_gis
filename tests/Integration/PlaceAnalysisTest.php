<?php

namespace Tests\Integration;

use App\Services\Addresses\AddressResolverService;
use App\Services\Air\AirStationDistances;
use App\Services\Gis\GeoJsonBoundary;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Tests\PostgisTestCase;

class PlaceAnalysisTest extends PostgisTestCase
{
    protected const READ_ONLY = true;

    public function test_air_stations_are_ordered_by_geography_distance_from_the_analysis_point(): void
    {
        $stations = [
            ['id' => '1003', 'lon' => null, 'lat' => null, 'crs' => null],
            ['id' => '1001', 'lon' => 92.90, 'lat' => 56.00, 'crs' => 'EPSG:4326'],
            ['id' => '1002', 'lon' => 92.92, 'lat' => 56.04, 'crs' => 'EPSG:4326'],
        ];
        $distance = app(AirStationDistances::class);
        $first = $distance->nearestFirst($stations, ['lon' => 92.92, 'lat' => 56.04]);
        $second = $distance->nearestFirst($stations, ['lon' => 92.90, 'lat' => 56.00]);

        $this->assertSame(['1002', '1001', '1003'], array_column($first, 'id'));
        $this->assertSame(['1001', '1002', '1003'], array_column($second, 'id'));
        $this->assertSame(0.0, $first[0]['distance_m']);
        $this->assertGreaterThan(4000, $first[1]['distance_m']);
        $this->assertSame($first[1]['distance_m'], $second[1]['distance_m']);
        $this->assertNull($first[2]['distance_m']);
    }

    public function test_read_budget_expires_safely_and_does_not_leak_to_the_next_transaction(): void
    {
        config(['app.debug' => true]);
        $before = DB::selectOne("SELECT current_setting('statement_timeout') AS timeout");
        $this->mock(AddressResolverService::class, function ($m) {
            $m->shouldReceive('validateId')->once()->with('osm:node:1')->andReturn([]);
            $m->shouldReceive('snapshots')->once()->with(true)->andReturnUsing(function () {
                DB::select('SELECT pg_sleep(3) /* synthetic private canary */');
            });
            $m->shouldNotReceive('resolve');
        });
        Log::shouldReceive('error')->once()->with('Place analysis request failed.',
            ['exception_type' => QueryException::class]);
        $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'address', 'address_id' => 'osm:node:1']])
            ->assertStatus(503)->assertJsonPath('code', 'SERVICE_UNAVAILABLE')->assertDontSee('canary')
            ->assertHeader('Cache-Control', 'no-store, private');
        $this->assertEquals($before, DB::selectOne("SELECT current_setting('statement_timeout') AS timeout"));
    }

    public function test_area_accepts_its_real_boundary_and_rejects_the_outside_buffer(): void
    {
        $geometry = app(GeoJsonBoundary::class)->geometry(file_get_contents(config('geocoding.scope_path')));
        $samples = DB::selectOne(<<<'SQL'
            WITH city AS (SELECT ST_GeomFromGeoJSON(?) AS geom),
            western_vertex AS (
                SELECT d.geom AS point FROM city CROSS JOIN LATERAL ST_DumpPoints(city.geom) AS d(path, geom)
                ORDER BY ST_X(d.geom) LIMIT 1
            )
            SELECT ST_X(point) AS lon, ST_Y(point) AS lat,
                ST_X(ST_Project(point::geography, 50, radians(270))::geometry) AS outside_lon,
                ST_Y(ST_Project(point::geography, 50, radians(270))::geometry) AS outside_lat
            FROM western_vertex
            SQL, [$geometry]);
        $edge = ['lon' => $samples->lon, 'lat' => $samples->lat];
        $outside = ['lon' => $samples->outside_lon, 'lat' => $samples->outside_lat];
        $this->postJson('/api/v1/place-analysis/selection', $edge)->assertOk()->assertExactJson(['status' => 'INSIDE']);
        foreach ([$outside, ['lon' => 0, 'lat' => 0]] as $point) {
            $this->postJson('/api/v1/place-analysis/selection', $point)->assertUnprocessable()->assertJsonPath('code', 'OUTSIDE_SERVICE_AREA');
            $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'point'] + $point])
                ->assertUnprocessable()->assertJsonPath('code', 'OUTSIDE_SERVICE_AREA')->assertJsonMissingPath('analysis_area');
        }
        $outsideData = DB::selectOne('SELECT ST_DWithin(ST_GeomFromGeoJSON(?)::geography, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, 1000) AS within_buffer',
            [$geometry, $outside['lon'], $outside['lat']]);
        $this->assertTrue($outsideData->within_buffer);
        $response = $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'point'] + $edge, 'radius_m' => 1000])
            ->assertOk()->assertJsonPath('radius_m', 1000);
        $check = DB::selectOne('SELECT ST_Covers(ST_GeomFromGeoJSON(?), ST_SetSRID(ST_MakePoint(?, ?), 4326)) AS includes_outside',
            [json_encode($response->json('analysis_area')), $outside['lon'], $outside['lat']]);
        $this->assertTrue($check->includes_outside);
    }

    public function test_boundary_unavailability_is_an_explicit_server_error(): void
    {
        config(['geocoding.scope_path' => resource_path('gis/missing-test-boundary.geojson')]);
        $this->postJson('/api/v1/place-analysis/selection', ['lon' => 92.85, 'lat' => 56.01])
            ->assertStatus(503)->assertJsonPath('code', 'SERVICE_AREA_UNAVAILABLE')->assertDontSee('missing-test-boundary');
        $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'point', 'lon' => 92.85, 'lat' => 56.01]])
            ->assertStatus(503)->assertJsonPath('code', 'SERVICE_AREA_UNAVAILABLE');
    }

    public function test_real_geography_circle_at_both_limits_without_any_provider_coverage(): void
    {
        $before = DB::selectOne("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock");
        // Synthetic points inside the city. No provider imports or fixtures.
        foreach ([[92.9, 56.0], [92.8523, 56.0095]] as [$lon, $lat]) {
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
