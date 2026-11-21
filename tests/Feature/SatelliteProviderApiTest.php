<?php

namespace Tests\Feature;

use App\Services\Analysis\RetailPoiProvider;
use App\Services\Analysis\SatelliteProvider;
use App\Services\Gis\AnalysisArea;
use App\Services\Satellite\SatelliteCatalogReader;
use Tests\TestCase;

class SatelliteProviderApiTest extends TestCase
{
    private string $root;

    private array $catalog;

    protected function setUp(): void
    {
        parent::setUp();
        $this->root = sys_get_temp_dir().'/a10-api-'.bin2hex(random_bytes(6));
        mkdir($this->root);
        $this->catalog = ['schema_version' => 1, 'format' => 'placelens-satellite-cells-v1', 'status' => 'verified_offline_runtime',
            'method_version' => 'placelens-s2-date-v1', 'mask_version' => 'scl456-dn-city-v1', 'legend_version' => 'ndvi-fixed-v2',
            'source_index' => ['sha256' => str_repeat('a', 64)], 'grid' => ['crs' => 'EPSG:32646', 'transform' => [10, 0, 494000, 0, -10, 6214000], 'width' => 128, 'height' => 128],
            'tile_side' => 256, 'record_bytes' => 8,
            'reason_codes' => ['valid', 'nodata', 'ambiguous_COG_DN1', 'saturated', 'cloud_shadow', 'cloud_or_cirrus', 'unclassified', 'SCL2_dark_or_shadow', 'snow', 'defective', 'numerical', 'unsupported_SCL', 'outside_target', 'outside_source_footprints'], 'releases' => []];
        foreach (['2024-05-07', '2026-06-06'] as $date) {
            mkdir($this->root.'/cells/'.$date, 0777, true);
            $raw = str_repeat(pack('gCCCC', 0, 0, 1, 1, 1), 128 * 128);
            file_put_contents($this->root.'/cells/'.$date.'/0-0.bin', $raw);
            $scene = ['product_uri' => 'synthetic.SAFE', 'tile' => '46VDH', 'platform' => 'sentinel-2a', 'baseline' => '05.10',
                'datatake' => 'synthetic', 'acquired_at_catalog' => $date.'T00:00:00Z', 'acquired_at_granule' => $date.'T00:00:00Z'];
            $this->catalog['releases'][] = ['date' => $date, 'release_id' => 'fixture-'.$date, 'manifest_sha256' => str_repeat('b', 64),
                'scenes' => [['scene_id' => 'synthetic-left'] + $scene, ['scene_id' => 'synthetic-right'] + $scene],
                'source_footprints' => array_fill(0, 2, ['type' => 'Polygon', 'coordinates' => [[[493000, 6212000], [496000, 6212000], [496000, 6215000], [493000, 6212000]]]]),
                'warnings' => $date === '2024-05-07' ? [['code' => 'EARLY_SPRING_SNOW', 'message' => 'Synthetic snow warning']] : [], 'limitations' => ['Synthetic'],
                'tiles' => ['0-0' => ['path' => 'cells/'.$date.'/0-0.bin', 'bytes' => strlen($raw), 'sha256' => hash('sha256', $raw)]]];
        }
        $this->pin();
        $this->mock(AnalysisArea::class, fn ($m) => $m->shouldReceive('forPoint')->andReturn([
            'analysis_area' => ['type' => 'Polygon', 'coordinates' => [[[92.89, 55.99], [92.91, 55.99], [92.91, 56.01], [92.89, 56.01], [92.89, 55.99]]]],
            'analysis_bounds' => [92.89, 55.99, 92.91, 56.01],
        ]));
        $this->app->instance(SatelliteProvider::class, new class extends SatelliteProvider
        {
            protected function read(array $point, int $radius): array
            {
                return (new SatelliteCatalogReader(config('satellite.runtime'), config('satellite.sha256')))->forProjectedPoint(494640, 6213360, $radius);
            }
        });
    }

    private function pin(): void
    {
        file_put_contents($this->root.'/catalog.json', json_encode($this->catalog));
        config(['satellite.runtime' => $this->root, 'satellite.sha256' => hash_file('sha256', $this->root.'/catalog.json'), 'satellite.delivery' => null]);
    }

    protected function tearDown(): void
    {
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $p) {
            $p->isDir() ? rmdir($p->getPathname()) : unlink($p->getPathname());
        }
        rmdir($this->root);
        parent::tearDown();
    }

    private function requestDate(?string $date = null)
    {
        return $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'point', 'lon' => 92.9, 'lat' => 56], 'radius_m' => 1000] + ($date === null ? [] : ['date' => $date]));
    }

    public function test_catalog_selection_warning_null_and_independent_blocks(): void
    {
        $r = $this->requestDate('2024-05-07')->assertOk()->assertJsonPath('blocks.satellite.status', 'READY')
            ->assertJsonCount(2, 'blocks.satellite.data.available_dates')->assertJsonCount(2, 'blocks.satellite.data.selected.scenes')
            ->assertJsonPath('blocks.satellite.data.selected.warnings.0.code', 'EARLY_SPRING_SNOW')
            ->assertJsonPath('blocks.satellite.data.selected.mean_ndvi', 0)->assertJsonPath('blocks.satellite.data.selected.layers', null)
            ->assertJsonPath('blocks.satellite.data.delivery_status', 'UNAVAILABLE')->assertJsonPath('blocks.satellite.coverage', null)
            ->assertJsonPath('blocks.poi.status', 'UNAVAILABLE')->assertJsonPath('blocks.air.status', 'UNAVAILABLE')
            ->assertDontSee($this->root)->assertDontSee('cells/')->assertDontSee('read_bytes');
        $this->assertLessThan(256 * 1024, strlen($r->getContent()));
        $this->requestDate()->assertJsonPath('blocks.satellite.data.selected.reason', 'DATE_NOT_SELECTED');
        $this->requestDate('2020-01-01')->assertJsonPath('blocks.satellite.data.selected.reason', 'DATE_NOT_IN_CATALOG');
        $this->requestDate('2026-02-30')->assertUnprocessable()->assertDontSee('2026-02-30');
    }

    public function test_corrupt_release_unknown_date_and_runtime_refusal(): void
    {
        file_put_contents($this->root.'/cells/2024-05-07/0-0.bin', 'corrupt');
        $this->requestDate('2024-05-07')->assertOk()->assertJsonPath('blocks.satellite.status', 'READY')
            ->assertJsonCount(1, 'blocks.satellite.data.available_dates')->assertJsonPath('blocks.satellite.data.selected.reason', 'SATELLITE_RELEASE_UNTRUSTED')
            ->assertJsonPath('blocks.satellite.data.selected.coverage', null)->assertJsonPath('blocks.satellite.data.selected.mean_ndvi', null)
            ->assertJsonPath('blocks.poi.status', 'UNAVAILABLE')->assertJsonPath('blocks.air.status', 'UNAVAILABLE');
        file_put_contents($this->root.'/catalog.json', 'corrupt');
        $this->requestDate()->assertJsonPath('blocks.satellite.code', 'SATELLITE_CATALOG_UNTRUSTED')->assertJsonPath('blocks.satellite.data', null);
        config(['satellite.runtime' => null]);
        $this->requestDate()->assertJsonPath('blocks.satellite.code', 'SATELLITE_NOT_CONFIGURED');
        config(['satellite.runtime' => $this->root.'/missing']);
        $this->requestDate()->assertJsonPath('blocks.satellite.status', 'ERROR')->assertDontSee($this->root);
    }

    public function test_satellite_failure_preserves_ready_poi_and_safe_air(): void
    {
        config(['app.debug' => true]);
        $this->mock(RetailPoiProvider::class, fn ($m) => $m->shouldReceive('analyze')->once()->andReturn(['status' => 'READY', 'data' => ['synthetic' => true]]));
        config(['satellite.runtime' => $this->root.'/missing']);
        $this->requestDate('2024-05-07')->assertOk()->assertJsonPath('blocks.poi.status', 'READY')
            ->assertJsonPath('blocks.satellite.status', 'ERROR')->assertJsonPath('blocks.satellite.code', 'SATELLITE_READ_FAILED')
            ->assertJsonPath('blocks.satellite.data', null)->assertJsonPath('blocks.air.status', 'UNAVAILABLE')->assertDontSee($this->root);
    }

    public function test_catalog_and_public_response_have_finite_size_limits(): void
    {
        $this->catalog['releases'][0]['limitations'] = [str_repeat('x', 270000)];
        $this->pin();
        $r = $this->requestDate('2024-05-07')->assertOk()->assertJsonPath('blocks.satellite.status', 'ERROR')
            ->assertJsonPath('blocks.satellite.data', null);
        $this->assertLessThan(4096, strlen(json_encode($r->json('blocks.satellite'))));
        file_put_contents($this->root.'/catalog.json', str_repeat('x', 2 * 1024 * 1024 + 1));
        config(['satellite.sha256' => hash_file('sha256', $this->root.'/catalog.json')]);
        $this->requestDate()->assertJsonPath('blocks.satellite.code', 'SATELLITE_CATALOG_UNTRUSTED')
            ->assertJsonPath('blocks.satellite.data', null);
    }

    public function test_unusable_date_is_not_a_zero_or_a_catalog_failure(): void
    {
        $raw = str_repeat(pack('gCCCC', -9999, 5, 1, 1, 1), 128 * 128);
        file_put_contents($this->root.'/cells/2024-05-07/0-0.bin', $raw);
        $this->catalog['releases'][0]['tiles']['0-0']['sha256'] = hash('sha256', $raw);
        $this->pin();
        $date = '2024-05-07';
        $withoutDelivery = $this->requestDate($date)->assertOk()->assertJsonPath('blocks.satellite.status', 'READY')
            ->assertJsonPath('blocks.satellite.data.selected.status', 'UNAVAILABLE')->assertJsonPath('blocks.satellite.data.selected.reason', 'NO_USABLE_NDVI')
            ->assertJsonPath('blocks.satellite.data.selected.mean_ndvi', null)->assertJsonPath('blocks.satellite.data.selected.mean_ndvi_reason', 'NO_USABLE_NDVI')
            ->assertJsonPath('blocks.satellite.data.selected.coverage.usable_pixels', 0)
            ->assertJsonPath('blocks.satellite.data.delivery_status', 'UNAVAILABLE')->assertJsonPath('blocks.satellite.data.selected.layers', null);

        $delivery = ['schema_version' => 1, 'reader_sha256' => config('satellite.sha256'), 'legend_version' => 'ndvi-fixed-v2',
            'legend' => config('satellite.legend'), 'bounds' => [92.8, 55.9, 93.0, 56.1],
            'releases' => array_column($this->catalog['releases'], null, 'date')];
        $path = $this->root.'/delivery';
        mkdir($path);
        file_put_contents($path.'/catalog.json', json_encode($delivery));
        $pin = hash_file('sha256', $path.'/catalog.json');
        config(['satellite.delivery' => $path, 'satellite.delivery_sha256' => $pin]);
        $withDelivery = $this->requestDate($date)->assertOk()->assertJsonPath('blocks.satellite.data.delivery_status', 'READY')
            ->assertJsonPath('blocks.satellite.data.selected.reason', 'NO_USABLE_NDVI')
            ->assertJsonPath('blocks.satellite.data.selected.mean_ndvi', null);
        foreach (['true-color', 'ndvi'] as $layer) {
            $withDelivery->assertJsonPath("blocks.satellite.data.selected.layers.$layer.tiles.0", "/api/v1/satellite/$pin/$date/$layer/{z}/{x}/{y}.png");
        }
        $ready = $this->requestDate('2026-06-06')->assertOk()
            ->assertJsonPath('blocks.satellite.data.selected.status', 'READY')
            ->assertJsonPath('blocks.satellite.data.selected.mean_ndvi', 0);
        config(['satellite.runtime' => $this->root.'/missing']);
        $error = $this->requestDate($date)->assertOk()->assertJsonPath('blocks.satellite.code', 'SATELLITE_READ_FAILED');

        if ($file = getenv('SATELLITE_API_FIXTURES_FILE')) {
            $stream = fopen($file, 'x');
            fwrite($stream, json_encode([
                'unusable' => $withDelivery->getContent(), 'withoutDelivery' => $withoutDelivery->getContent(),
                'ready' => $ready->getContent(), 'readError' => $error->getContent(),
            ], JSON_THROW_ON_ERROR));
            fclose($stream);
        }
    }
}
