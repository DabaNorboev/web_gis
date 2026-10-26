<?php

namespace Tests\Unit;

use App\Services\Routing\RoutingSnapshot;
use RuntimeException;
use Tests\TestCase;

class RoutingSnapshotTest extends TestCase
{
    private string $folder;

    protected function setUp(): void
    {
        parent::setUp();
        $this->folder = sys_get_temp_dir().'/routing-snapshot-'.bin2hex(random_bytes(6));
        mkdir($this->folder.'/guards', recursive: true);
        $tile = 'guards/18572-11202.json';
        $raw = json_encode([['id' => 'way/1', 'kind' => 'line', 'tags' => ['highway' => 'residential'], 'nodes' => [1, 2],
            'geometry' => ['type' => 'LineString', 'coordinates' => [[92.86, 56.01], [92.8601, 56.0101]]]]]);
        file_put_contents($this->folder.'/'.$tile, $raw);
        $m = json_encode(['mode' => 'driving', 'engine_version' => '5.27.1', 'version' => 'test', 'bbox' => [92.7, 55.9, 93.2, 56.2],
            'guard_cell_degrees' => .005, 'guard_hashes' => [$tile => hash('sha256', $raw)]]);
        file_put_contents($this->folder.'/manifest.json', $m);
        config(['routing.snapshot_path' => $this->folder, 'routing.version' => 'test', 'routing.manifest_sha256' => hash('sha256', $m)]);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->folder.'/guards/*') as $path) {
            unlink($path);
        }
        rmdir($this->folder.'/guards');
        unlink($this->folder.'/manifest.json');
        rmdir($this->folder);
        parent::tearDown();
    }

    public function test_tiles_are_loaded_from_the_pinned_snapshot_and_changed_data_is_rejected(): void
    {
        $a = ['lon' => 92.8601, 'lat' => 56.0101];
        $b = ['lon' => 92.8602, 'lat' => 56.0102];
        $snapshot = app(RoutingSnapshot::class);
        $this->assertCount(1, $snapshot->features([array_values($a), array_values($b)], $a, $b));
        file_put_contents($this->folder.'/guards/18572-11202.json', '[]');
        $this->expectException(RuntimeException::class);
        $snapshot->features([array_values($a), array_values($b)], $a, $b);
    }

    public function test_a_missing_prepared_tile_is_not_treated_as_an_empty_area(): void
    {
        unlink($this->folder.'/guards/18572-11202.json');
        $this->expectException(RuntimeException::class);
        app(RoutingSnapshot::class)->features([[92.8601, 56.0101], [92.8602, 56.0102]], ['lon' => 92.8601, 'lat' => 56.0101], ['lon' => 92.8602, 'lat' => 56.0102]);
    }
}
