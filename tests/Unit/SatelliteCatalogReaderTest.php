<?php

namespace Tests\Unit;

use App\Services\Satellite\SatelliteCatalogReader;
use InvalidArgumentException;
use PHPUnit\Framework\TestCase;

class SatelliteCatalogReaderTest extends TestCase
{
    private string $root;

    private array $catalog;

    private string $hash;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir().'/satellite-fixture-'.bin2hex(random_bytes(8));
        mkdir($this->root);
        $reasons = ['valid', 'nodata', 'ambiguous_COG_DN1', 'saturated', 'cloud_shadow', 'cloud_or_cirrus', 'unclassified', 'SCL2_dark_or_shadow', 'snow', 'defective', 'numerical', 'unsupported_SCL', 'outside_target', 'outside_source_footprints'];
        $this->catalog = ['schema_version' => 1, 'format' => 'placelens-satellite-cells-v1', 'status' => 'verified_offline_runtime',
            'method_version' => 'placelens-s2-date-v1', 'mask_version' => 'scl456-dn-city-v1', 'legend_version' => 'ndvi-fixed-v2',
            'source_index' => ['sha256' => str_repeat('a', 64)], 'grid' => ['crs' => 'EPSG:32646', 'transform' => [10, 0, 494000, 0, -10, 6214000], 'width' => 128, 'height' => 128],
            'tile_side' => 256, 'record_bytes' => 8, 'reason_codes' => $reasons, 'releases' => []];
        foreach (['2024-05-07', '2026-06-06'] as $date) {
            mkdir($this->root.'/cells/'.$date, 0777, true);
            $raw = '';
            for ($row = 0; $row < 128; $row++) {
                for ($col = 0; $col < 128; $col++) {
                    $reason = $row < 4 ? 12 : (($row >= 30 && $row < 40 && $col >= 30 && $col < 40) ? 5 : 0);
                    if ($row === 50 && $col === 50) {
                        $reason = 1;
                    }
                    if ($row === 51 && $col === 50) {
                        $reason = 2;
                    }
                    if ($row === 52 && $col === 50) {
                        $reason = 8;
                    }
                    $raw .= pack('gCCCC', $reason === 0 ? 0.0 : -9999.0, $reason, $reason === 12 ? 0 : ($col < 64 ? 1 : 2), $reason === 12 ? 0 : 1, in_array($reason, [1, 12], true) ? 0 : 1);
                }
            }
            $path = 'cells/'.$date.'/0-0.bin';
            file_put_contents($this->root.'/'.$path, $raw);
            $this->catalog['releases'][] = ['date' => $date, 'release_id' => $date.'-fixture', 'manifest_sha256' => str_repeat('b', 64),
                'scenes' => [['scene_id' => 'left'], ['scene_id' => 'right']], 'source_footprints' => [
                    ['type' => 'Polygon', 'coordinates' => [[[493000, 6212000], [494640, 6212000], [494640, 6215000], [493000, 6215000], [493000, 6212000]]]],
                    ['type' => 'MultiPolygon', 'coordinates' => [[[[494640, 6212000], [496000, 6212000], [496000, 6215000], [494640, 6215000], [494640, 6212000]]]]]],
                'warnings' => $date === '2024-05-07' ? [['code' => 'EARLY_SPRING_SNOW', 'message' => 'Synthetic warning']] : [], 'limitations' => ['Fixture only'],
                'tiles' => ['0-0' => ['path' => $path, 'bytes' => strlen($raw), 'sha256' => hash('sha256', $raw)]]];
        }
        $this->writeCatalog();
    }

    private function writeCatalog(): void
    {
        file_put_contents($this->root.'/catalog.json', json_encode($this->catalog, JSON_THROW_ON_ERROR));
        $this->hash = hash_file('sha256', $this->root.'/catalog.json');
    }

    protected function tearDown(): void
    {
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $p) {
            $p->isDir() ? rmdir($p->getPathname()) : unlink($p->getPathname());
        } rmdir($this->root);
    }

    public function test_zero_ndvi_provenance_and_date_warning(): void
    {
        $r = (new SatelliteCatalogReader($this->root, $this->hash))->forProjectedPoint(494900, 6213100, 200);
        self::assertSame('READY', $r['status']);
        self::assertCount(2, $r['available_dates']);
        self::assertSame(0.0, $r['releases'][0]['mean_ndvi']);
        self::assertEquals(1.0, $r['releases'][0]['coverage']['usable_fraction']);
        self::assertCount(2, $r['releases'][0]['scenes']);
        self::assertSame('EARLY_SPRING_SNOW', $r['releases'][0]['warnings'][0]['code']);
        self::assertLessThan(16 * 1024 * 1024, $r['metrics']['read_bytes']);
    }

    public function test_full_circle_denominator_edge_outside_masks_and_seam(): void
    {
        $reader = new SatelliteCatalogReader($this->root, $this->hash);
        foreach ([200, 1000] as $radius) {
            $r = $reader->forProjectedPoint(494640, 6213360, $radius)['releases'][0];
            $c = $r['coverage'];
            self::assertEquals($c['prepared_pixels'], array_sum((array) $c['source_pixels']));
            self::assertCount(2, (array) $c['source_pixels']);
            self::assertSame($c['circle_pixels'], $c['prepared_pixels'] + $c['outside_rectangle_pixels'] + $c['inside_rectangle_outside_target_pixels']);
            $outside = $reader->forProjectedPoint(490000, 6213360, $radius);
            self::assertSame([], $outside['available_dates']);
            self::assertNull($outside['releases'][0]['mean_ndvi']);
            self::assertSame('NO_PREPARED_DATA', $outside['releases'][0]['reason']);
        }
        $edge = $reader->forProjectedPoint(494000, 6213360, 200)['releases'][0]['coverage'];
        self::assertGreaterThan(0, $edge['prepared_fraction']);
        self::assertLessThan(1, $edge['prepared_fraction']);
        $masked = $reader->forProjectedPoint(494500, 6213500, 200)['releases'][0]['coverage'];
        self::assertSame(1, $masked['reason_counts']['nodata']);
        self::assertSame(1, $masked['reason_counts']['ambiguous_COG_DN1']);
        self::assertSame(1, $masked['reason_counts']['snow']);
        self::assertLessThan($masked['prepared_pixels'], $masked['usable_pixels']);
    }

    public function test_no_usable_date_is_unavailable_with_null_not_zero(): void
    {
        $path = $this->root.'/cells/2024-05-07/0-0.bin';
        foreach ([[8, 1, 'NO_USABLE_NDVI'], [1, 0, 'NO_GEOGRAPHIC_DATA'], [2, 1, 'NO_USABLE_NDVI']] as [$reason, $geographic, $expected]) {
            $raw = str_repeat(pack('gCCCC', -9999.0, $reason, 1, 1, $geographic), 128 * 128);
            file_put_contents($path, $raw);
            $this->catalog['releases'][0]['tiles']['0-0']['sha256'] = hash('sha256', $raw);
            $this->writeCatalog();
            $r = (new SatelliteCatalogReader($this->root, $this->hash))->forProjectedPoint(494900, 6213100, 200);
            self::assertCount(1, $r['available_dates']);
            self::assertSame($expected, $r['releases'][0]['reason']);
            self::assertNull($r['releases'][0]['mean_ndvi']);
        }
    }

    public function test_corruption_with_same_size_and_mtime_invalidates_next_read(): void
    {
        $reader = new SatelliteCatalogReader($this->root, $this->hash);
        self::assertCount(2, $reader->forProjectedPoint(494900, 6213100, 200)['available_dates']);
        $path = $this->root.'/cells/2024-05-07/0-0.bin';
        $time = filemtime($path);
        $f = fopen($path, 'r+b');
        fwrite($f, 'X');
        fclose($f);
        touch($path, $time);
        $r = $reader->forProjectedPoint(494900, 6213100, 200);
        self::assertCount(1, $r['available_dates']);
        self::assertSame('SATELLITE_RELEASE_UNTRUSTED', $r['releases'][0]['reason']);
        self::assertNull($r['releases'][0]['coverage']);
        file_put_contents($this->root.'/catalog.json', '{}');
        self::assertSame('SATELLITE_CATALOG_UNTRUSTED', $reader->forProjectedPoint(494900, 6213100, 200)['reason']);
    }

    public function test_incompatible_or_incomplete_catalog_fails_closed(): void
    {
        foreach (['method', 'tiles', 'reasons', 'path'] as $case) {
            $original = $this->catalog;
            if ($case === 'method') {
                $this->catalog['method_version'] = 'unknown';
            }
            if ($case === 'tiles') {
                $this->catalog['releases'][0]['tiles'] = [];
            }
            if ($case === 'reasons') {
                unset($this->catalog['reason_codes']);
            }
            if ($case === 'path') {
                $this->catalog['releases'][0]['tiles']['0-0']['path'] = '../secret';
            }
            $this->writeCatalog();
            $r = (new SatelliteCatalogReader($this->root, $this->hash))->forProjectedPoint(494900, 6213100, 200);
            self::assertSame('SATELLITE_CATALOG_UNTRUSTED', $r['reason']);
            $this->catalog = $original;
        }
    }

    public function test_radius_is_bounded(): void
    {
        $this->expectException(InvalidArgumentException::class);
        (new SatelliteCatalogReader($this->root, $this->hash))->forProjectedPoint(494900, 6213100, 1001);
    }
}
