<?php

namespace App\Services\Analysis;

use App\Services\Addresses\AddressResolverService;
use App\Services\Air\AirProvider;
use App\Services\Geocoding\GeocodingTokens;
use App\Services\Gis\AnalysisArea;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

class PlaceAnalysisService
{
    public const BLOCKS = ['poi', 'satellite', 'air'];

    public function __construct(
        private AddressResolverService $resolver,
        private AnalysisArea $area,
        private RetailPoiProvider $poi,
        private PlaceServiceArea $serviceArea,
    ) {}

    public function analyze(array $input): array
    {
        $radius = $input['radius_m'] ?? 500;
        $place = $input['place'];
        $version = $input['analysis_version'] ?? 1;
        $selection = $version === 2 ? app(GeocodingTokens::class)->selection($place['selection_token'])['place'] : null;
        // Address identity is checked before any source read.
        if ($place['kind'] === 'address' && $version === 1) {
            $this->resolver->validateId($place['address_id']);
        }
        [$address, $point, $map] = DB::transaction(function () use ($place, $radius, $version, $selection) {
            if (DB::getDriverName() === 'pgsql') {
                // Transaction-local budgets do not change pooled connection defaults.
                DB::statement("SET LOCAL statement_timeout = '2s'");
                DB::statement("SET LOCAL lock_timeout = '500ms'");
            }
            $address = $place['kind'] === 'address' && $version === 1
                ? $this->resolver->resolve($place['address_id'], $this->resolver->snapshots(true)) : null;
            $point = $selection !== null ? $selection['point'] : ($address ? ['lon' => $address['object']['lon'], 'lat' => $address['object']['lat']]
                : ['lon' => $place['lon'], 'lat' => $place['lat']]);

            $this->serviceArea->requireCovered($point);

            return [$address, $point, $this->area->forPoint($point['lon'], $point['lat'], $radius)];
        });

        $blocks = [];
        foreach ($input['blocks'] ?? self::BLOCKS as $key) {
            try {
                $blockInput = match ($key) {
                    'satellite' => $point + ['satellite_date' => $input['date'] ?? null],
                    'air' => $point + ['selected_station_ids' => $input['stations']['selected_ids'] ?? []],
                    default => $point,
                };
                $blocks[$key] = $this->calculateBlock($key, $blockInput, $radius);
            } catch (Throwable $error) {
                Log::error('Place analysis block failed.', ['exception_type' => get_class($error), 'block' => $key]);
                $blocks[$key] = ['status' => 'ERROR', 'code' => 'BLOCK_CALCULATION_FAILED',
                    'message' => 'Не удалось рассчитать блок.', 'data' => null,
                    'coverage' => null, 'completeness' => $key === 'satellite' ? null : ['status' => 'UNKNOWN', 'reason' => 'Расчёт блока завершился ошибкой.'],
                    'calculated_at' => CarbonImmutable::now('UTC')->toISOString()];
            }
        }

        return ['analysis_version' => $version, 'place' => $selection ?? ['kind' => $place['kind'], 'label' => $address['label'] ?? null,
            'address' => $address, 'point' => $point], 'radius_m' => $radius] + $map + [
                'date' => $input['date'] ?? null,
                'station_selection' => ['selected_ids' => $input['stations']['selected_ids'] ?? [], 'radius_m' => $input['stations']['radius_m'] ?? 5000],
                'calculated_at' => CarbonImmutable::now('UTC')->toISOString(), 'blocks' => $blocks,
            ];
    }

    protected function calculateBlock(string $key, array $point, int $radius): array
    {
        if ($key === 'poi') {
            return $this->poi->analyze($point, $radius);
        }
        if ($key === 'satellite') {
            return app(SatelliteProvider::class)->analyze($point, $radius, $point['satellite_date'] ?? null);
        }

        return app(AirProvider::class)->analyze($point['selected_station_ids'], $point);
    }
}
