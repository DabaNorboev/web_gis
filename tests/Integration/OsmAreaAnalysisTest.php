<?php

namespace Tests\Integration;

use App\Services\Osm\Analysis\OsmAreaAnalysisService;
use App\Services\Osm\Import\OsmAreaDataset;
use App\Services\Osm\Import\OsmAreaImporter;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class OsmAreaAnalysisTest extends TestCase
{
    // Absolute percentage points after clipping/union, not a tolerance on source accuracy.
    // At r=500 m this is <8e-6 m2, well below the 0.01 m2 area output precision.
    private const FULL_COVERAGE_SHARE_DELTA = 1e-9;

    private string $directory;

    private float $x;

    private float $y;

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || DB::connection()->getDatabaseName() !== 'web_gis_test') {
            throw new RuntimeException('Area analysis tests require web_gis_test.');
        }
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        $this->directory = sys_get_temp_dir().'/web-gis-area-analysis-'.bin2hex(random_bytes(8));
        mkdir($this->directory);
        file_put_contents($this->directory.'/boundary.json', '{"type":"Polygon","coordinates":[[[92,55],[94,55],[94,57],[92,57],[92,55]]]}');
        $origin = DB::selectOne('SELECT ST_X(p) x,ST_Y(p) y FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(92.9,56),4326),32646) p) a');
        $this->x = (float) $origin->x;
        $this->y = (float) $origin->y;
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

    public function test_flags_are_independent_preserve_tags_and_do_not_make_gardens_public_parks(): void
    {
        $this->import(OsmAreaDataset::GreenAreas, [
            $this->polygon(1, ['leisure' => 'park']), $this->polygon(2, ['natural' => 'wood']),
            $this->polygon(3, ['leisure' => 'park', 'natural' => 'grassland']),
            $this->polygon(4, ['leisure' => 'garden']), $this->polygon(5, ['leisure' => 'garden', 'landuse' => 'orchard']),
        ]);
        $rows = DB::table('osm_green_areas')->orderBy('osm_id')->get()->keyBy('osm_id');
        $expected = [1 => [true, false, false], 2 => [false, false, true], 3 => [true, false, true], 4 => [false, true, false], 5 => [false, true, true]];
        foreach ($expected as $id => $flags) {
            $row = $rows[$id];
            $this->assertSame($flags, [$row->is_park, $row->is_garden, $row->is_vegetation]);
        }
        $this->assertSame('vegetation_landuse', $rows[3]->representation); // Legacy primary tag remains unchanged.
        $this->assertSame('park', json_decode($rows[3]->raw_data, true)['tags']['leisure']);
        try {
            DB::transaction(fn () => DB::table('osm_green_areas')->where('id', $rows[1]->id)->update(['is_vegetation' => true]));
            $this->fail('A source-derived flag cannot be assigned manually');
        } catch (QueryException $error) {
            $this->assertSame('428C9', $error->errorInfo[0]);
        }
    }

    public function test_park_only_is_not_vegetation_and_missing_water_is_not_zero(): void
    {
        $this->import(OsmAreaDataset::GreenAreas, [$this->polygon(1, ['leisure' => 'park', 'access' => 'private'])]);
        $result = $this->analyze();
        $this->assertIsFloat($result['categories']['parks']['metrics']['share']['value']);
        $this->assertEqualsWithDelta(100.0, $result['categories']['parks']['metrics']['share']['value'], self::FULL_COVERAGE_SHARE_DELTA);
        $this->assertSame(0.0, $result['categories']['vegetation']['metrics']['share']['value']);
        $this->assertNull($result['categories']['water']['metrics']['share']['value']);
        $this->assertSame('UNAVAILABLE', $result['categories']['water']['metrics']['share']['quality']['availability']);
        $this->assertSame('private', $result['categories']['parks']['nearest']['access']);
        $this->assertStringContainsString('не подтверждает общественный доступ', $result['categories']['parks']['metrics']['area']['quality']['reason']);
        $this->assertSame('private', json_decode(DB::table('osm_green_areas')->value('raw_data'), true)['tags']['access']);
    }

    public function test_overlaps_and_duplicates_count_once_and_park_boundary_does_not_enlarge_vegetation(): void
    {
        // Two 100x200 m rectangles, overlap 50x200 m: union = 30,000 m2.
        $a = $this->ring(-100, -100, 0, 100);
        $b = $this->ring(-50, -100, 50, 100);
        $this->import(OsmAreaDataset::GreenAreas, [$this->polygon(1, ['natural' => 'wood'], [$a]),
            $this->polygon(2, ['landuse' => 'grass'], [$b]), $this->polygon(3, ['natural' => 'wood'], [$a]),
            $this->polygon(4, ['leisure' => 'park'])]);
        $water = $this->ring(-50, -50, 50, 50);
        $this->import(OsmAreaDataset::Water, [$this->polygon(10, ['natural' => 'water'], [$water]), $this->polygon(11, ['natural' => 'water'], [$water])]);
        $r = $this->analyze()['categories'];
        $this->assertEqualsWithDelta(30000, $r['vegetation']['metrics']['area']['value'], 0.02);
        $this->assertEqualsWithDelta(10000, $r['water']['metrics']['area']['value'], 0.02);
        $this->assertIsFloat($r['parks']['metrics']['share']['value']);
        $this->assertEqualsWithDelta(100.0, $r['parks']['metrics']['share']['value'], self::FULL_COVERAGE_SHARE_DELTA);
        $this->assertEqualsWithDelta(100 * 30000 / (M_PI * 500 ** 2), $r['vegetation']['metrics']['share']['value'], 0.002);
        $this->assertSame(4, DB::table('osm_green_areas')->count());
        $this->assertSame(2, DB::table('osm_water')->count());
    }

    public function test_both_flags_can_cover_the_circle_without_summing_categories_and_radius_clips_large_polygons(): void
    {
        $this->import(OsmAreaDataset::GreenAreas, [$this->polygon(1, ['natural' => 'wood', 'leisure' => 'park']),
            $this->polygon(2, ['natural' => 'wood', 'leisure' => 'park'])]);
        foreach ([300, 500] as $radius) {
            $r = $this->analyze($radius)['categories'];
            foreach (['parks', 'vegetation'] as $kind) {
                $this->assertSame(100.0, $r[$kind]['metrics']['share']['value']);
                $this->assertEqualsWithDelta(M_PI * $radius ** 2, $r[$kind]['metrics']['area']['value'], M_PI * $radius ** 2 * 0.0002);
            }
        }
    }

    public function test_holes_remain_empty_and_distance_to_the_geometry_is_not_distance_to_an_entrance(): void
    {
        $this->import(OsmAreaDataset::GreenAreas, [$this->polygon(1, ['natural' => 'wood'], [
            $this->ring(-2000, -2000, 2000, 2000), $this->ring(-100, -100, 100, 100),
        ])]);
        $r = $this->analyze()['categories']['vegetation'];
        $this->assertEqualsWithDelta(M_PI * 500 ** 2 - 40000, $r['metrics']['area']['value'], 100);
        $this->assertEqualsWithDelta(100, $r['metrics']['nearest_distance']['value'], 1);
        $this->assertStringContainsString('не маршрут до входа', $r['metrics']['nearest_distance']['quality']['reason']);
    }

    public function test_full_coverage_tolerance_does_not_hide_a_hundredth_square_metre_gap(): void
    {
        // Duplicate polygons with the same 0.1 x 0.1 m hole: union must retain the gap.
        $rings = [$this->ring(-2000, -2000, 2000, 2000), $this->ring(-0.05, -0.05, 0.05, 0.05)];
        $this->import(OsmAreaDataset::GreenAreas, [
            $this->polygon(1, ['leisure' => 'park'], $rings), $this->polygon(2, ['leisure' => 'park'], $rings),
        ]);
        foreach ([300, 500] as $radius) {
            $metric = $this->analyze($radius)['categories']['parks']['metrics']['share'];
            $this->assertSame('AVAILABLE', $metric['quality']['availability']);
            $this->assertIsFloat($metric['value']);
            $missingShare = 100.0 - $metric['value'];
            $this->assertGreaterThan(self::FULL_COVERAGE_SHARE_DELTA, $missingShare);
            // Independent area formula for the regular 256-gon (quad_segs=64).
            $circleArea = 128 * $radius ** 2 * sin(2 * M_PI / 256);
            $this->assertEqualsWithDelta(0.01, $missingShare * $circleArea / 100, 1e-6);
        }
    }

    public function test_no_intersection_is_zero_but_partial_and_outside_coverage_are_null(): void
    {
        $this->import(OsmAreaDataset::GreenAreas, [$this->polygon(1, ['natural' => 'wood'], [$this->ring(1000, 1000, 1100, 1100)])]);
        $r = $this->analyze()['categories']['vegetation'];
        $this->assertSame(0.0, $r['metrics']['area']['value']);
        $this->assertSame(0.0, $r['metrics']['share']['value']);
        $this->assertSame('AVAILABLE', $r['metrics']['share']['quality']['availability']);
        $this->assertGreaterThan(500, $r['metrics']['nearest_distance']['value']);
        file_put_contents($this->directory.'/boundary.json', '{"type":"Polygon","coordinates":[[[92.899,55.999],[92.901,55.999],[92.901,56.001],[92.899,56.001],[92.899,55.999]]]}');
        $this->import(OsmAreaDataset::GreenAreas, [$this->polygon(2, ['natural' => 'wood'])]);
        $partial = $this->analyze()['categories']['vegetation'];
        $this->assertSame('PARTIAL', $partial['coverage']['status']);
        $this->assertNull($partial['metrics']['share']['value']);
        $this->assertSame('INSUFFICIENT_DATA', $partial['metrics']['share']['quality']['availability']);
        $outside = app(OsmAreaAnalysisService::class)->analyze(37.62, 55.75)['categories']['vegetation'];
        $this->assertSame('OUTSIDE_SERVICE_AREA', $outside['coverage']['status']);
        foreach ($outside['metrics'] as $metric) {
            $this->assertNull($metric['value']);
            $this->assertNull($metric['quality']['method']);
            $this->assertSame('UNAVAILABLE', $metric['quality']['availability']);
        }
    }

    public function test_active_snapshot_metadata_and_independent_missing_sources_are_preserved(): void
    {
        $old = $this->import(OsmAreaDataset::GreenAreas, [$this->polygon(1, ['leisure' => 'park'])]);
        $active = $this->import(OsmAreaDataset::GreenAreas, [$this->polygon(2, ['natural' => 'wood'])]);
        $r = $this->analyze();
        foreach (['parks', 'vegetation'] as $kind) {
            $metric = $r['categories'][$kind]['metrics']['share'];
            $this->assertSame($active['import_id'], $metric['dataset_import_id']);
            $this->assertSame('OpenStreetMap', $metric['source']);
            $this->assertNull($metric['observed_at']);
            $this->assertSame('UNKNOWN', $metric['quality']['freshness']);
            $this->assertSame('DERIVED', $metric['quality']['method']);
            $this->assertSame(OsmAreaAnalysisService::METHOD_VERSION, $metric['method_version']);
        }
        $this->assertSame(0.0, $r['categories']['parks']['metrics']['share']['value']);
        $this->assertIsFloat($r['categories']['vegetation']['metrics']['share']['value']);
        $this->assertEqualsWithDelta(100.0, $r['categories']['vegetation']['metrics']['share']['value'], self::FULL_COVERAGE_SHARE_DELTA);
        $this->assertFalse(DB::table('dataset_imports')->find($old['import_id'])->is_active);
        $this->assertNull($r['categories']['water']['metrics']['share']['value']);
    }

    public function test_generated_flags_backfill_and_rollback_only_in_an_isolated_schema(): void
    {
        DB::statement('CREATE SCHEMA area_flags_migration_test');
        DB::statement('SET LOCAL search_path TO area_flags_migration_test,public');
        DB::statement('CREATE TABLE osm_green_areas (id bigint PRIMARY KEY,raw_data jsonb NOT NULL)');
        DB::statement('INSERT INTO osm_green_areas VALUES (1,?::jsonb)', [json_encode(['tags' => ['natural' => 'wood', 'leisure' => 'park']])]);
        $migration = require database_path('migrations/2026_10_20_000003_add_independent_green_area_flags.php');
        $migration->up();
        $this->assertTrue(DB::table('area_flags_migration_test.osm_green_areas')->first()->is_park);
        $this->assertTrue(DB::table('area_flags_migration_test.osm_green_areas')->first()->is_vegetation);
        $migration->down();
        $this->assertSame('wood', json_decode(DB::table('area_flags_migration_test.osm_green_areas')->value('raw_data'), true)['tags']['natural']);
        $this->assertSame(1, DB::table('area_flags_migration_test.osm_green_areas')->count());
        $migration->up();
    }

    private function analyze(int $radius = 500): array
    {
        return app(OsmAreaAnalysisService::class)->analyze(92.9, 56, $radius);
    }

    private function import(OsmAreaDataset $dataset, array $elements): array
    {
        file_put_contents($this->directory.'/areas.json', json_encode(['elements' => $elements], JSON_THROW_ON_ERROR));

        return app(OsmAreaImporter::class)->import($dataset, $this->directory.'/areas.json', $this->directory.'/boundary.json', ['allow_large_drop' => true]);
    }

    private function ring(float $west, float $south, float $east, float $north): array
    {
        return array_map(fn ($p) => [$p[0] + $this->x, $p[1] + $this->y], [[$west, $south], [$east, $south], [$east, $north], [$west, $north], [$west, $south]]);
    }

    private function polygon(int $id, array $tags, ?array $rings = null): array
    {
        $rings ??= [$this->ring(-2000, -2000, 2000, 2000)];
        $g = DB::selectOne('SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),32646),4326),15) g', [json_encode(['type' => 'Polygon', 'coordinates' => $rings])])->g;
        $coordinates = json_decode($g, true)['coordinates'];
        $geometry = fn ($ring) => array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], $ring);
        if (count($coordinates) === 1) {
            return ['type' => 'way', 'id' => $id, 'tags' => $tags, 'geometry' => $geometry($coordinates[0])];
        }

        return ['type' => 'relation', 'id' => $id, 'tags' => $tags + ['type' => 'multipolygon'],
            'members' => array_map(fn ($ring, $i) => ['type' => 'way', 'ref' => $id * 100 + $i, 'role' => $i === 0 ? 'outer' : 'inner', 'geometry' => $geometry($ring)], $coordinates, array_keys($coordinates))];
    }
}
