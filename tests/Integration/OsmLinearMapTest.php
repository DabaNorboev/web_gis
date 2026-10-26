<?php

namespace Tests\Integration;

use App\Services\Addresses\AddressProfileService;
use App\Services\Osm\Analysis\OsmLinearAnalysisService;
use App\Services\Osm\Analysis\OsmLinearMapService;
use App\Services\Osm\Import\OsmLinearDataset;
use Illuminate\Support\Facades\DB;
use Mockery;
use RuntimeException;
use Tests\PostgisTestCase as TestCase;

class OsmLinearMapTest extends TestCase
{
    private array $imports;

    protected function setUp(): void
    {
        parent::setUp();
        if (DB::getDriverName() !== 'pgsql' || ! preg_match('/^(web_gis_test|placelens_linear_layers_test_[0-9]+)$/D', DB::connection()->getDatabaseName())) {
            throw new RuntimeException('Linear map tests require an isolated test database with the existing schema.');
        }
        DB::beginTransaction();
        DB::table('dataset_imports')->where('is_active', true)->update(['is_active' => false]);
        foreach (['roads', 'railways', 'addresses'] as $key) {
            $id = DB::table('dataset_imports')->insertGetId(['source' => 'OpenStreetMap', 'dataset_key' => $key,
                'checksum_sha256' => hash('sha256', $key), 'configuration_sha256' => hash('sha256', 'linear-map-test'),
                'configuration' => '{}', 'status' => 'succeeded', 'is_active' => true,
                'started_at' => '2026-10-19T00:00:00Z', 'finished_at' => '2026-10-19T00:00:01Z',
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

    public function test_bounded_fragments_preserve_ids_parallel_duplicate_and_crossing_lines_without_merging(): void
    {
        $this->line(OsmLinearDataset::Roads, 1, [[-2000, 0], [2000, 0]], 'primary');
        $this->line(OsmLinearDataset::Roads, 2, [[-2000, 0], [2000, 0]], 'secondary');
        $this->line(OsmLinearDataset::Roads, 3, [[-2000, 40], [2000, 40]], 'trunk');
        $this->line(OsmLinearDataset::Roads, 4, [[-2000, 1000], [2000, 1000]], 'motorway');
        $this->line(OsmLinearDataset::Roads, 5, [[-2000, -50], [2000, -50], [2000, 50], [-2000, 50]], 'primary');
        $this->line(OsmLinearDataset::Railways, 11, [[0, -2000], [0, 2000]], 'rail');
        $this->line(OsmLinearDataset::Railways, 12, [[40, -2000], [40, 2000]], 'narrow_gauge');
        foreach ([300, 500] as $radius) {
            $roads = $this->layer(OsmLinearDataset::Roads, $radius);
            $rails = $this->layer(OsmLinearDataset::Railways, $radius);
            $this->assertSame(['osm:way:1', 'osm:way:2', 'osm:way:3', 'osm:way:5'], array_column($roads['features'], 'id'));
            $this->assertSame(['osm:way:11', 'osm:way:12'], array_column($rails['features'], 'id'));
            $this->assertSame('MultiLineString', $roads['features'][3]['geometry']['type']);
            $this->assertCount(2, $roads['features'][3]['geometry']['coordinates']);
            foreach ([$roads, $rails] as $layer) {
                $this->assertNull($layer['observed_at']);
                $this->assertSame('2026-10-18T20:25:06+00:00', $layer['source_updated_at']);
                $this->assertArrayNotHasKey('length', $layer);
                $this->assertSame('COVERED', $layer['coverage']['status']);
                foreach ($layer['features'] as $feature) {
                    $distance = DB::selectOne('SELECT ST_MaxDistance(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646),ST_Transform(ST_SetSRID(ST_MakePoint(92.9,56),4326),32646)) d', [json_encode($feature['geometry'])])->d;
                    $this->assertLessThanOrEqual($radius + 0.002, $distance);
                    // Buffer has 256 sides; oblique endpoints can fall slightly inside its circular arc.
                    $this->assertEqualsWithDelta($radius, $distance, 0.05);
                    $this->assertSame(['id', 'name', 'feature_type'], array_keys($feature['properties']));
                }
            }
        }
    }

    public function test_empty_partial_missing_outside_and_unknown_data_do_not_leak_full_lines(): void
    {
        $empty = $this->layer(OsmLinearDataset::Roads);
        $this->assertSame([], $empty['features']);
        $this->assertSame('AVAILABLE', $empty['quality']['availability']);
        $this->line(OsmLinearDataset::Roads, 1, [[-2000, 0], [2000, 0]], 'primary');
        $id = $this->imports['roads']->id;
        DB::statement('UPDATE dataset_coverages SET service_geom=ST_Buffer(ST_SetSRID(ST_MakePoint(92.9,56),4326)::geography,100)::geometry,data_geom=ST_Buffer(ST_SetSRID(ST_MakePoint(92.9,56),4326)::geography,100)::geometry WHERE dataset_import_id=?', [$id]);
        $partial = $this->layer(OsmLinearDataset::Roads);
        $this->assertSame('PARTIAL', $partial['coverage']['status']);
        $this->assertSame('INSUFFICIENT_DATA', $partial['quality']['availability']);
        $this->assertCount(1, $partial['features']);
        $outside = DB::selectOne('SELECT ST_Length(ST_Difference(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),data_geom)::geography) d FROM dataset_coverages WHERE dataset_import_id=?', [json_encode($partial['features'][0]['geometry']), $id])->d;
        $this->assertLessThan(0.01, $outside);
        $outside = $this->layer(OsmLinearDataset::Roads, 500, 93, 56);
        $this->assertSame('OUTSIDE_SERVICE_AREA', $outside['coverage']['status']);
        $this->assertSame([], $outside['features']);
        DB::table('dataset_coverages')->where('dataset_import_id', $id)->delete();
        $unknown = $this->layer(OsmLinearDataset::Roads);
        $this->assertSame('UNKNOWN', $unknown['coverage']['status']);
        $this->assertSame('UNAVAILABLE', $unknown['quality']['availability']);
        $this->assertSame([], $unknown['features']);
        $category = app(OsmLinearAnalysisService::class)->forDataset(OsmLinearDataset::Railways, null, 92.9, 56, 500);
        $missing = app(OsmLinearMapService::class)->forDataset(OsmLinearDataset::Railways, null, $category, 92.9, 56, 500);
        $this->assertNull($missing['dataset_import_id']);
        $this->assertSame('UNAVAILABLE', $missing['quality']['availability']);
        $this->assertSame([], $missing['features']);
    }

    public function test_linear_sql_failure_preserves_metrics_area_and_other_linear_layer_and_caller_transaction(): void
    {
        $this->line(OsmLinearDataset::Roads, 1, [[-2000, 0], [2000, 0]], 'primary');
        $this->line(OsmLinearDataset::Railways, 11, [[0, -2000], [0, 2000]], 'rail');
        DB::statement("INSERT INTO osm_addresses (dataset_import_id,osm_type,osm_id,street,house_number,label,source_geom,geom,point_method,raw_data) VALUES (?,'node',1,'Тестовая','1','Тестовая, 1',ST_SetSRID(ST_MakePoint(92.9,56),4326),ST_SetSRID(ST_MakePoint(92.9,56),4326),'osm_node','{}')", [$this->imports['addresses']->id]);
        $before = app(AddressProfileService::class)->profile('osm:node:1');
        $fake = Mockery::mock(OsmLinearMapService::class)->makePartial();
        $fake->shouldReceive('forDataset')->withArgs(fn ($dataset) => $dataset === OsmLinearDataset::Roads)->andReturnUsing(function () {
            DB::statement('SELECT nonexistent_linear_map_test_function()');
        });
        $this->app->instance(OsmLinearMapService::class, $fake);
        $after = app(AddressProfileService::class)->profile('osm:node:1');
        $this->assertSame('ERROR', $after['map']['linear_layers']['roads']['status']);
        $this->assertSame('READY', $after['map']['linear_layers']['railways']['status']);
        $this->assertCount(1, $after['map']['linear_layers']['railways']['data']['features']);
        foreach ($before['blocks'] as $key => $block) {
            $this->assertSame($block['status'], $after['blocks'][$key]['status']);
            foreach ($block['data']['metrics'] as $name => $metric) {
                $this->assertSame($metric['value'], $after['blocks'][$key]['data']['metrics'][$name]['value']);
            }
        }
        foreach ($before['map']['area_layers'] as $key => $block) {
            $this->assertSame($block['status'], $after['map']['area_layers'][$key]['status']);
            $this->assertSame($block['data']['features'], $after['map']['area_layers'][$key]['data']['features']);
        }
        $this->assertSame(1, DB::selectOne('SELECT 1 n')->n);
    }

    private function layer(OsmLinearDataset $dataset, int $radius = 500, float $lon = 92.9, float $lat = 56): array
    {
        $import = $this->imports[$dataset->value];
        $category = app(OsmLinearAnalysisService::class)->forDataset($dataset, $import, $lon, $lat, $radius);

        return app(OsmLinearMapService::class)->forDataset($dataset, $import, $category, $lon, $lat, $radius);
    }

    private function line(OsmLinearDataset $dataset, int $id, array $coordinates, string $type): void
    {
        $geom = json_encode(['type' => 'LineString', 'coordinates' => $coordinates]);
        $table = $dataset->table();
        DB::statement("INSERT INTO {$table} (dataset_import_id,osm_type,osm_id,feature_type,geom,crosses_boundary,raw_data)
            SELECT ?,'way',?,?,ST_Transform(ST_Translate(ST_SetSRID(ST_GeomFromGeoJSON(?),32646),ST_X(p),ST_Y(p)),4326),false,?::jsonb
            FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(92.9,56),4326),32646) p) a",
            [$this->imports[$dataset->value]->id, $id, $type, $geom, json_encode(['tags' => [$dataset->tag() => $type, 'bridge' => 'yes', 'layer' => '1']])]);
    }
}
