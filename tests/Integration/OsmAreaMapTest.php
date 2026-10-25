<?php

namespace Tests\Integration;

use App\Services\Addresses\AddressProfileService;
use App\Services\Osm\Analysis\OsmAreaAnalysisService;
use App\Services\Osm\Analysis\OsmAreaKind;
use App\Services\Osm\Analysis\OsmAreaMapService;
use Illuminate\Support\Facades\DB;
use Mockery;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class OsmAreaMapTest extends TestCase
{
    private array $imports;

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || ! preg_match('/^(web_gis_test|placelens_area_layers_test_[0-9]+)$/D', DB::connection()->getDatabaseName())) {
            throw new RuntimeException('Area map tests require an isolated test database with the existing schema.');
        }
        DB::beginTransaction();
        DB::table('dataset_imports')->where('is_active', true)->update(['is_active' => false]);
        foreach (['green_areas', 'water', 'addresses'] as $key) {
            $id = DB::table('dataset_imports')->insertGetId(['source' => 'OpenStreetMap', 'dataset_key' => $key,
                'checksum_sha256' => hash('sha256', $key), 'configuration_sha256' => hash('sha256', 'area-map-test'),
                'configuration' => '{}', 'status' => 'succeeded', 'is_active' => true, 'started_at' => '2026-10-19T00:00:00Z', 'finished_at' => '2026-10-19T00:00:01Z',
                'source_updated_at' => '2026-10-18T20:25:06Z']);
            $this->imports[$key] = DB::table('dataset_imports')->find($id);
            DB::statement('INSERT INTO dataset_coverages VALUES (?,ST_MakeEnvelope(92,55,94,57,4326),ST_MakeEnvelope(92,55,94,57,4326),0,?,?)', [$id, str_repeat('a', 64), str_repeat('b', 64)]);
        }
    }

    protected function tearDown(): void
    {
        while (DB::transactionLevel() > 0) {
            DB::rollBack();
        }
        parent::tearDown();
    }

    public function test_independent_flags_original_ids_overlaps_and_holes_survive_both_radii(): void
    {
        $this->polygon(1, ['leisure' => 'park', 'natural' => 'wood'], 2000, 100);
        $this->polygon(2, ['leisure' => 'park'], 2000, 100); // Same geometry, separate OSM element.
        $this->polygon(3, ['natural' => 'wood'], 2000, 100);
        $this->polygon(4, ['leisure' => 'garden'], 2000);
        $this->polygon(5, ['natural' => 'wood'], 20, 0, 2000); // Outside the radius.
        $this->polygon(6, ['natural' => 'water'], 2000, 100);
        foreach ([300, 500] as $radius) {
            $parks = $this->layer(OsmAreaKind::Parks, $radius);
            $vegetation = $this->layer(OsmAreaKind::Vegetation, $radius);
            $water = $this->layer(OsmAreaKind::Water, $radius);
            $this->assertSame(['osm:way:1', 'osm:way:2'], array_column($parks['features'], 'id'));
            $this->assertSame(['osm:way:1', 'osm:way:3'], array_column($vegetation['features'], 'id'));
            $this->assertSame(['osm:way:6'], array_column($water['features'], 'id'));
            foreach ([$parks, $vegetation, $water] as $layer) {
                $this->assertSame('COVERED', $layer['coverage']['status']);
                $this->assertNull($layer['observed_at']);
                $this->assertSame('2026-10-18T20:25:06+00:00', $layer['source_updated_at']);
                foreach ($layer['features'] as $feature) {
                    $row = DB::selectOne('SELECT ST_Area(g) area,ST_Covers(g,p) center,ST_MaxDistance(g,p) distance FROM (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) g,ST_Transform(ST_SetSRID(ST_MakePoint(92.9,56),4326),32646) p) a', [json_encode($feature['geometry'])]);
                    $this->assertFalse($row->center); // Hole retained.
                    $this->assertEqualsWithDelta($radius, $row->distance, 0.002);
                    $this->assertEqualsWithDelta(M_PI * $radius ** 2 - 40000, $row->area, 100);
                }
            }
        }
    }

    public function test_empty_missing_unknown_outside_and_partial_are_distinct_and_partial_clips_to_data(): void
    {
        $empty = $this->layer(OsmAreaKind::Parks);
        $this->assertSame([], $empty['features']);
        $this->assertSame('AVAILABLE', $empty['quality']['availability']);
        $this->polygon(1, ['leisure' => 'park'], 2000);
        $import = $this->imports['green_areas'];
        DB::statement('UPDATE dataset_coverages SET service_geom=ST_Buffer(ST_SetSRID(ST_MakePoint(92.9,56),4326)::geography,100)::geometry,data_geom=ST_Buffer(ST_SetSRID(ST_MakePoint(92.9,56),4326)::geography,100)::geometry WHERE dataset_import_id=?', [$import->id]);
        $partial = $this->layer(OsmAreaKind::Parks);
        $this->assertSame('PARTIAL', $partial['coverage']['status']);
        $this->assertSame('INSUFFICIENT_DATA', $partial['quality']['availability']);
        $this->assertCount(1, $partial['features']);
        $outsideArea = DB::selectOne('SELECT ST_Area(ST_Difference(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),data_geom)::geography) area FROM dataset_coverages WHERE dataset_import_id=?', [json_encode($partial['features'][0]['geometry']), $import->id])->area;
        $this->assertLessThan(0.01, $outsideArea);
        $outside = $this->layer(OsmAreaKind::Parks, 500, 93.5, 56.5);
        $this->assertSame('OUTSIDE_SERVICE_AREA', $outside['coverage']['status']);
        $this->assertSame([], $outside['features']);
        DB::table('dataset_coverages')->where('dataset_import_id', $import->id)->delete();
        $unknown = $this->layer(OsmAreaKind::Parks);
        $this->assertSame('UNKNOWN', $unknown['coverage']['status']);
        $this->assertSame('UNAVAILABLE', $unknown['quality']['availability']);
        $this->assertSame([], $unknown['features']);
        $category = app(OsmAreaAnalysisService::class)->forKind(OsmAreaKind::Water, null, 92.9, 56, 500);
        $missing = app(OsmAreaMapService::class)->forKind(OsmAreaKind::Water, null, $category, 92.9, 56, 500);
        $this->assertNull($missing['dataset_import_id']);
        $this->assertSame('UNAVAILABLE', $missing['quality']['availability']);
        $this->assertSame([], $missing['features']);
    }

    public function test_geometry_failure_preserves_metrics_and_other_map_layers(): void
    {
        $this->polygon(1, ['leisure' => 'park', 'natural' => 'wood'], 2000);
        DB::statement("INSERT INTO osm_addresses (dataset_import_id,osm_type,osm_id,street,house_number,label,source_geom,geom,point_method,raw_data) VALUES (?,'node',1,'Тестовая','1','Тестовая, 1',ST_SetSRID(ST_MakePoint(92.9,56),4326),ST_SetSRID(ST_MakePoint(92.9,56),4326),'osm_node','{}')", [$this->imports['addresses']->id]);
        $before = app(AddressProfileService::class)->profile('osm:node:1');
        $fake = Mockery::mock(OsmAreaMapService::class)->makePartial();
        $fake->shouldReceive('forKind')->withArgs(fn ($kind) => $kind === OsmAreaKind::Parks)->andReturnUsing(function () {
            DB::statement('SELECT nonexistent_area_map_test_function()');
        });
        $this->app->instance(OsmAreaMapService::class, $fake);
        $after = app(AddressProfileService::class)->profile('osm:node:1');
        $this->assertSame('ERROR', $after['map']['area_layers']['parks']['status']);
        $this->assertSame('READY', $after['map']['area_layers']['vegetation']['status']);
        $this->assertSame('READY', $after['map']['area_layers']['water']['status']);
        foreach ($before['blocks'] as $key => $block) {
            $this->assertSame($block['status'], $after['blocks'][$key]['status']);
            foreach ($block['data']['metrics'] as $name => $metric) {
                $this->assertSame($metric['value'], $after['blocks'][$key]['data']['metrics'][$name]['value']);
            }
        }
        $this->assertSame(1, DB::selectOne('SELECT 1 n')->n); // Failed query did not poison caller transaction.
    }

    private function layer(OsmAreaKind $kind, int $radius = 500, float $lon = 92.9, float $lat = 56): array
    {
        $import = $this->imports[$kind->dataset()];
        $category = app(OsmAreaAnalysisService::class)->forKind($kind, $import, $lon, $lat, $radius);

        return app(OsmAreaMapService::class)->forKind($kind, $import, $category, $lon, $lat, $radius);
    }

    private function polygon(int $id, array $tags, float $half, float $hole = 0, float $offset = 0): void
    {
        $water = isset($tags['natural']) && $tags['natural'] === 'water';
        $key = $water ? 'water' : 'green_areas';
        $feature = isset($tags['leisure']) ? 'leisure:'.$tags['leisure'] : 'natural:'.$tags['natural'];
        $representation = $water ? 'water_area' : (isset($tags['leisure']) ? 'recreation_boundary' : 'vegetation_landuse');
        DB::statement("INSERT INTO osm_{$key} (dataset_import_id,osm_type,osm_id,feature_type,representation,geom,crosses_boundary,raw_data)
            SELECT ?,'way',?,?,?,ST_Transform(CASE WHEN ?::float8>0 THEN ST_Difference(g,ST_MakeEnvelope(x-?,y-?,x+?,y+?,32646)) ELSE g END,4326),false,?::jsonb
            FROM (SELECT ST_MakeEnvelope(x-?+?,y-?,x+?+?,y+?,32646) g,x,y FROM (SELECT ST_X(p) x,ST_Y(p) y FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(92.9,56),4326),32646) p) a) b) c",
            [$this->imports[$key]->id, $id, $feature, $representation, $hole, $hole, $hole, $hole, $hole, json_encode(['tags' => $tags]), $half, $offset, $half, $half, $offset, $half]);
    }
}
