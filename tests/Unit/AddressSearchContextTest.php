<?php

namespace Tests\Unit;

use App\Services\Osm\Search\AddressSearchService;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;
use Mockery;
use Tests\TestCase;

class AddressSearchContextTest extends TestCase
{
    public function test_unknown_locality_permission_is_explicit_only_for_city_context(): void
    {
        $imports = Mockery::mock(Builder::class);
        $imports->shouldReceive('where')->andReturnSelf();
        $imports->shouldReceive('first')->andReturn((object) ['id' => 1, 'observed_at' => null, 'source_updated_at' => null]);
        $entries = Mockery::mock(Builder::class);
        foreach (['where', 'whereIn', 'selectRaw', 'groupBy', 'orderByDesc', 'orderBy', 'limit'] as $method) {
            $entries->shouldReceive($method)->andReturnSelf();
        }
        $entries->shouldReceive('whereRaw')->withArgs(fn ($sql, $bindings) => ! str_contains(implode(' ', $bindings), 'красноярск'))->andReturnSelf();
        $entries->shouldReceive('get')->andReturn(collect());
        DB::shouldReceive('table')->with('dataset_imports')->andReturn($imports);
        DB::shouldReceive('table')->with('osm_address_search_entries as e')->andReturn($entries);
        DB::shouldReceive('transaction')->andReturnUsing(fn ($callback) => $callback());
        DB::shouldReceive('statement')->andReturn(true);
        DB::shouldReceive('selectOne')->with('SELECT osm_address_normalize(?) AS text', ['г. Красноярск Мира 10'])->once()->andReturn((object) ['text' => 'г красноярск мира 10']);
        DB::shouldReceive('selectOne')->with('SELECT osm_address_normalize(?) AS text', ['Мира 10'])->once()->andReturn((object) ['text' => 'мира 10']);
        $service = new AddressSearchService;
        $this->assertTrue($service->search('г. Красноярск Мира 10')['meta']['unknown_locality_allowed']);
        $this->assertFalse($service->search('Мира 10')['meta']['unknown_locality_allowed']);
    }
}
