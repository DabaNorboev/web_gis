<?php

namespace Tests\Integration;

use App\Services\Analysis\PlaceServiceArea;
use Illuminate\Support\Facades\DB;
use Tests\PostgisTestCase;

class EducationPoiTest extends PostgisTestCase
{
    public function test_education_categories_are_independent_and_preserve_source_geometry(): void
    {
        $this->mock(PlaceServiceArea::class, fn ($mock) => $mock->shouldReceive('requireCovered'));
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        config(['place_analysis.education_enabled' => true]);
        $directory = sys_get_temp_dir().'/education-test-'.bin2hex(random_bytes(6));
        mkdir($directory);
        $polygon = ['type' => 'Polygon', 'coordinates' => [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]];
        $boundary = $directory.'/boundary.json';
        file_put_contents($boundary, json_encode($polygon, JSON_THROW_ON_ERROR));
        DB::beginTransaction();
        try {
            DB::table('dataset_imports')->whereIn('dataset_key', ['school', 'kindergarten'])->update(['is_active' => false]);
            foreach (['school' => 1, 'kindergarten' => 2] as $category => $id) {
                $counts = ['node' => 0, 'way' => 0, 'relation' => 0];
                $type = $category === 'school' ? 'way' : 'node';
                $counts[$type] = 1;
                $point = $type === 'way' ? ['geometry' => [
                    ['lon' => 92.999, 'lat' => 55.999], ['lon' => 93.001, 'lat' => 55.999],
                    ['lon' => 93.001, 'lat' => 56.001], ['lon' => 92.999, 'lat' => 56.001],
                    ['lon' => 92.999, 'lat' => 55.999],
                ]] : ['lon' => 93.0005, 'lat' => 56];
                $document = ['elements' => [['type' => $type, 'id' => $id, 'tags' => ['amenity' => $category]] + $point],
                    'preparation' => [
                        'schema_version' => 2, 'dataset_key' => $category, 'categories' => [$category], 'method' => 'complete_source_members_bbox_v2',
                        'object_types' => ['node', 'way', 'relation'], 'rules' => [$category => ['amenity' => [$category]]],
                        'pbf_sha256' => hash('sha256', 'fixture'), 'script_sha256' => hash('sha256', 'producer'),
                        'common_script_sha256' => hash('sha256', 'common'), 'boundary_sha256' => hash_file('sha256', $boundary),
                        'bbox' => [92, 55, 94, 57], 'extraction_geometry' => $polygon, 'emitted_counts' => $counts,
                        'relation_audit' => ['selected_count' => 0, 'outcomes' => []],
                    ]];
                $file = $directory.'/'.$category.'.json';
                file_put_contents($file, json_encode($document, JSON_THROW_ON_ERROR));
                $this->artisan('osm:import-education', ['category' => $category, 'file' => $file, '--boundary' => $boundary,
                    '--expected-sha256' => hash_file('sha256', $file)])->assertSuccessful();
            }
            $query = ['place' => ['kind' => 'point', 'lon' => 93, 'lat' => 56], 'radius_m' => 200, 'blocks' => ['poi']];
            $block = $this->postJson('/api/v1/place-analysis', $query)->assertOk()->json('blocks.poi');
            $this->assertSame('poi-v4-geography-source-geometry-education', $block['method_version']);
            $this->assertSame(1, $block['data']['counts_by_category']['school']);
            $this->assertSame(1, $block['data']['counts_by_category']['kindergarten']);
            $school = collect($block['data']['items'])->firstWhere('category', 'school');
            $this->assertSame('Polygon', $school['geometry']['type']);
            $this->assertEquals(0, $school['distance_m']);
            $this->assertNull($school['observed_at']);
            DB::table('dataset_imports')->where('dataset_key', 'kindergarten')->update(['is_active' => false]);
            $this->postJson('/api/v1/place-analysis', $query)->assertOk()
                ->assertJsonPath('blocks.poi.data.counts_by_category.school', 1)
                ->assertJsonPath('blocks.poi.data.counts_by_category.kindergarten', null)
                ->assertJsonPath('blocks.poi.availability_by_category.kindergarten.status', 'UNAVAILABLE');
        } finally {
            DB::rollBack();
            foreach (glob($directory.'/*') as $file) {
                unlink($file);
            }
            rmdir($directory);
        }
    }
}
