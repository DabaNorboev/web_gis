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
            $this->catalog['releases'][] = ['date' => $date, 'release_id' => 'fixture-'.$date, 'manifest_sha256' => str_repeat('b', 64),
                'scenes' => [['scene_id' => 'synthetic-left'], ['scene_id' => 'synthetic-right']],
                'source_footprints' => array_fill(0, 2, ['type' => 'Polygon', 'coordinates' => [[[493000, 6212000], [496000, 6212000], [496000, 6215000], [493000, 6212000]]]]),
                'warnings' => $date === '2024-05-07' ? [['code' => 'EARLY_SPRING_SNOW']] : [], 'limitations' => ['Synthetic'],
                'tiles' => ['0-0' => ['path' => 'cells/'.$date.'/0-0.bin', 'bytes' => strlen($raw), 'sha256' => hash('sha256', $raw)]]];
        }
        $this->pin();
        $this->mock(AnalysisArea::class, fn ($m) => $m->shouldReceive('forPoint')->andReturn(['analysis_area' => null, 'analysis_bounds' => null]));
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
        file_put_contents($this->root.'/catalog.json', 'corrupt');
        $this->requestDate('2024-05-07')->assertOk()->assertJsonPath('blocks.poi.status', 'READY')
            ->assertJsonPath('blocks.satellite.status', 'UNAVAILABLE')->assertJsonPath('blocks.air.status', 'UNAVAILABLE')->assertDontSee($this->root);
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
        $this->requestDate('2024-05-07')->assertJsonPath('blocks.satellite.status', 'READY')->assertJsonPath('blocks.satellite.data.selected.reason', 'NO_USABLE_NDVI')
            ->assertJsonPath('blocks.satellite.data.selected.mean_ndvi', null)->assertJsonPath('blocks.satellite.data.selected.coverage.usable_pixels', 0);
    }
}
