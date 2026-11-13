<?php

namespace App\Services\Analysis;

use App\Services\Addresses\AddressResolverService;
use App\Services\Gis\AnalysisArea;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

class PlaceAnalysisService
{
    public const BLOCKS = ['poi', 'satellite', 'air'];

    public function __construct(private AddressResolverService $resolver, private AnalysisArea $area, private RetailPoiProvider $poi) {}

    public function analyze(array $input): array
    {
        $radius = $input['radius_m'] ?? 500;
        $place = $input['place'];
        // Address identity is checked before any source read.
        if ($place['kind'] === 'address') {
            $this->resolver->validateId($place['address_id']);
        }
        [$address, $point, $map] = DB::transaction(function () use ($place, $radius) {
            if (DB::getDriverName() === 'pgsql') {
                // Transaction-local budgets do not change pooled connection defaults.
                DB::statement("SET LOCAL statement_timeout = '2s'");
                DB::statement("SET LOCAL lock_timeout = '500ms'");
            }
            $address = $place['kind'] === 'address'
                ? $this->resolver->resolve($place['address_id'], $this->resolver->snapshots(true)) : null;
            $point = $address ? ['lon' => $address['object']['lon'], 'lat' => $address['object']['lat']]
                : ['lon' => $place['lon'], 'lat' => $place['lat']];

            return [$address, $point, $this->area->forPoint($point['lon'], $point['lat'], $radius)];
        });

        $blocks = [];
        foreach ($input['blocks'] ?? self::BLOCKS as $key) {
            try {
                $blocks[$key] = $this->calculateBlock($key, $key === 'satellite' ? $point + ['satellite_date' => $input['date'] ?? null] : $point, $radius);
            } catch (Throwable $error) {
                Log::error('Place analysis block failed.', ['exception_type' => get_class($error), 'block' => $key]);
                $blocks[$key] = ['status' => 'ERROR', 'code' => 'BLOCK_CALCULATION_FAILED',
                    'message' => 'Не удалось рассчитать блок.', 'data' => null,
                    'coverage' => null, 'completeness' => $key === 'satellite' ? null : ['status' => 'UNKNOWN', 'reason' => 'Расчёт блока завершился ошибкой.'],
                    'calculated_at' => CarbonImmutable::now('UTC')->toISOString()];
            }
        }

        return ['analysis_version' => 1, 'place' => ['kind' => $place['kind'], 'label' => $address['label'] ?? null,
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
        $reason = match ($key) {
            'air' => 'Provider справочника и наблюдений станций анализа места ещё не реализован (А11–А12).',
        };

        $completeness = ['status' => 'UNKNOWN', 'reason' => $reason];

        return ['status' => 'UNAVAILABLE', 'code' => 'BLOCK_NOT_AVAILABLE', 'message' => $reason,
            'calculated_at' => CarbonImmutable::now('UTC')->toISOString(),
            'coverage' => null,
            'completeness' => $key === 'satellite' ? null : $completeness, 'data' => null];
    }
}
