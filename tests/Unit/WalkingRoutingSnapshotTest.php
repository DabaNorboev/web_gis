<?php

namespace Tests\Unit;

use App\Services\Routing\RoutingDataException;
use App\Services\Routing\WalkingRoutingSnapshot;
use Tests\TestCase;

class WalkingRoutingSnapshotTest extends TestCase
{
    private string $folder;

    private array $manifest;

    private array $start = ['lon' => 92.8601, 'lat' => 56.0101];

    private array $target = ['lon' => 92.8602, 'lat' => 56.0102];

    protected function setUp(): void
    {
        parent::setUp();
        $this->folder = sys_get_temp_dir().'/walking-snapshot-'.bin2hex(random_bytes(6));
        mkdir($this->folder.'/guards', recursive: true);
        mkdir($this->folder.'/ways');
        $way = ['id' => 7, 'nodes' => [1, 2], 'coordinates' => [array_values($this->start), array_values($this->target)],
            'tags' => ['highway' => 'footway', 'access' => 'private']];
        $rows = [['id' => 'way/7', 'kind' => 'line', 'nodes' => $way['nodes'], 'tags' => $way['tags'],
            'geometry' => ['type' => 'LineString', 'coordinates' => $way['coordinates']]],
            ['id' => 'way/8', 'kind' => 'building', 'geometry' => ['type' => 'Polygon', 'coordinates' => []]]];
        $cell = 'guards/18572-11202.json';
        $this->manifest = ['mode' => 'walking', 'engine' => 'ORS', 'engine_version' => '10.1.0', 'profile' => 'foot-walking',
            'version' => 'walking-test', 'bbox' => [92.7, 55.9, 93.2, 56.2], 'guard_cell_degrees' => .005,
            'guard_hashes' => [$cell => $this->write($cell, $rows)], 'way_hashes' => ['ways/7.json' => $this->write('ways/7.json', $way)]];
        config(['routing.walking.snapshot_path' => $this->folder, 'routing.walking.version' => 'walking-test']);
        $this->pinManifest();
    }

    protected function tearDown(): void
    {
        foreach (['guards', 'ways'] as $directory) {
            foreach (glob($this->folder.'/'.$directory.'/*') as $file) {
                unlink($file);
            }
            rmdir($this->folder.'/'.$directory);
        }
        unlink($this->folder.'/manifest.json');
        rmdir($this->folder);
        parent::tearDown();
    }

    private function write(string $name, array $value): string
    {
        $raw = json_encode($value, JSON_THROW_ON_ERROR);
        file_put_contents($this->folder.'/'.$name, $raw);

        return hash('sha256', $raw);
    }

    private function pinManifest(): void
    {
        config(['routing.walking.manifest_sha256' => $this->write('manifest.json', $this->manifest)]);
    }

    private function features(?WalkingRoutingSnapshot $snapshot = null): array
    {
        return ($snapshot ?? new WalkingRoutingSnapshot)->features([array_values($this->start), array_values($this->target)], $this->start, $this->target);
    }

    public function test_original_way_identity_and_local_features_are_loaded(): void
    {
        $snapshot = new WalkingRoutingSnapshot;
        $this->assertTrue($snapshot->contains($this->start));
        $this->assertFalse($snapshot->contains(['lon' => 92.6, 'lat' => 56.0]));
        $this->assertSame([1, 2], $snapshot->ways([7, '7'])[7]['nodes']);
        $this->assertCount(2, $this->features($snapshot));
    }

    public function test_endpoint_snap_neighborhood_loads_roads_across_a_cell_boundary(): void
    {
        $cell = 'guards/18571-11202.json';
        $this->manifest['guard_hashes'][$cell] = $this->write($cell, [['id' => 'way/9', 'kind' => 'line',
            'tags' => ['highway' => 'footway'], 'nodes' => [3, 4],
            'geometry' => ['type' => 'LineString', 'coordinates' => [[92.8599, 56.0101], [92.8599, 56.0102]]]]]);
        $this->pinManifest();
        $this->assertCount(3, $this->features());
    }

    public function test_changed_manifest_is_rejected(): void
    {
        file_put_contents($this->folder.'/manifest.json', '{}');
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->manifest();
    }

    public function test_invalid_manifest_json_is_a_bounded_data_error(): void
    {
        file_put_contents($this->folder.'/manifest.json', '{');
        config(['routing.walking.manifest_sha256' => hash('sha256', '{')]);
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->manifest();
    }

    public function test_engine_mode_cannot_be_substituted_with_car(): void
    {
        $this->manifest['mode'] = 'driving';
        $this->pinManifest();
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->manifest();
    }

    public function test_missing_indexed_cell_fails_instead_of_becoming_empty(): void
    {
        unlink($this->folder.'/guards/18572-11202.json');
        $this->expectException(RoutingDataException::class);
        $this->features();
    }

    public function test_changed_cell_is_rejected(): void
    {
        file_put_contents($this->folder.'/guards/18572-11202.json', '[]');
        $this->expectException(RoutingDataException::class);
        $this->features();
    }

    public function test_way_index_must_contain_requested_original_id(): void
    {
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->ways([8]);
    }

    public function test_missing_original_way_is_rejected(): void
    {
        unlink($this->folder.'/ways/7.json');
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->ways([7]);
    }

    public function test_way_path_traversal_is_rejected(): void
    {
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->ways(['../manifest']);
    }

    public function test_way_id_budget_is_checked_before_disk_reads(): void
    {
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->ways(array_fill(0, 2001, 7));
    }

    public function test_changed_original_way_is_rejected(): void
    {
        file_put_contents($this->folder.'/ways/7.json', '{}');
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->ways([7]);
    }

    public function test_oversized_way_is_rejected_even_when_hash_matches(): void
    {
        $raw = str_repeat(' ', 1_000_001);
        file_put_contents($this->folder.'/ways/7.json', $raw);
        $this->manifest['way_hashes']['ways/7.json'] = hash('sha256', $raw);
        $this->pinManifest();
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->ways([7]);
    }

    public function test_nonfinite_coordinates_fail_without_cell_loop(): void
    {
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->features([[INF, 56.0]], $this->start, $this->target);
    }

    public function test_long_segment_is_rejected_before_citywide_cell_loop(): void
    {
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->features([[0, 0]], $this->start, $this->target);
    }

    public function test_coordinate_count_is_bounded_before_cell_lookup(): void
    {
        $this->expectException(RoutingDataException::class);
        (new WalkingRoutingSnapshot)->features(array_fill(0, 20_001, [92.86, 56.01]), $this->start, $this->target);
    }
}
