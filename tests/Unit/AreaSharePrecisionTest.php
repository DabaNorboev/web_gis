<?php

namespace Tests\Unit;

use App\Services\Gis\DatasetCoverage;
use App\Services\Osm\Analysis\OsmAreaAnalysisService;
use App\Services\Osm\Analysis\OsmAreaKind;
use Illuminate\Support\Facades\DB;
use Mockery;
use Tests\TestCase;

class AreaSharePrecisionTest extends TestCase
{
    public function test_a_positive_sql_area_is_not_rounded_to_a_zero_share(): void
    {
        $coverage = Mockery::mock(DatasetCoverage::class);
        $coverage->shouldReceive('assess')->twice()->andReturn(['status' => 'COVERED', 'available_radius_m' => 1000]);
        DB::shouldReceive('selectOne')->times(4)->andReturn(
            (object) ['area_m2' => 0.00001, 'circle_m2' => 785319.31], null,
            (object) ['area_m2' => 0, 'circle_m2' => 785319.31], null,
        );
        $service = new OsmAreaAnalysisService($coverage);
        $import = (object) ['id' => 1, 'observed_at' => null, 'source_updated_at' => null];
        $small = $service->forKind(OsmAreaKind::Parks, $import, 92.9, 56, 500);
        $zero = $service->forKind(OsmAreaKind::Parks, $import, 92.9, 56, 500);
        $this->assertGreaterThan(0, $small['metrics']['share']['value']);
        $this->assertLessThan(0.00005, $small['metrics']['share']['value']);
        $this->assertSame(0.0, $zero['metrics']['share']['value']);
    }
}
