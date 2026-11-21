<?php

namespace Tests\Support\Geocoding;

use App\Services\Geocoding\GeoapifyNormalizer;
use App\Services\Geocoding\GeocodingScope;
use Carbon\CarbonImmutable;

trait Fixtures
{
    private function scopeFixture(): void
    {
        config(['geocoding.scope_id' => 'synthetic-scope', 'geocoding.scope_sha256' => str_repeat('a', 64)]);
        $this->mock(GeocodingScope::class, function ($m) {
            $m->shouldReceive('identity')->andReturnUsing(fn () => ['scope_id' => config('geocoding.scope_id'), 'scope_sha256' => config('geocoding.scope_sha256')]);
            $m->shouldReceive('bounds')->andReturn([0, 0, 10, 10]);
            $m->shouldReceive('nearby')->andReturnUsing(fn ($origin, $candidates) => array_map(fn ($c) => $c + ['reference_distance_m' => 0.0], $candidates));
            $m->shouldReceive('covers')->andReturnUsing(fn ($p) => $p['lon'] >= 0 && $p['lon'] <= 10 && $p['lat'] >= 0 && $p['lat'] <= 10);
        });
    }

    private function row(array $override = []): array
    {
        return $override + ['place_id' => 'synthetic-provider-id', 'formatted' => 'Синтетическая улица, 10/2А к3 стр4',
            'country_code' => 'ru', 'city' => 'Синтетический', 'street' => 'Синтетическая улица', 'housenumber' => '10/2А к3 стр4',
            'lon' => 1.2, 'lat' => 2.3, 'result_type' => 'building'];
    }

    private function candidateFixture(): array
    {
        return app(GeoapifyNormalizer::class)->normalize([$this->row()], null, CarbonImmutable::now('UTC')->toISOString())['candidates'][0];
    }
}
