<?php

namespace App\Services\Analysis;

use App\Services\Satellite\SatelliteCatalogReader;
use App\Services\Satellite\SatelliteDelivery;
use Carbon\CarbonImmutable;
use Throwable;

class SatelliteProvider
{
    public function analyze(array $point, int $radius, ?string $date): array
    {
        $block = ['status' => 'UNAVAILABLE', 'code' => 'SATELLITE_NOT_CONFIGURED', 'message' => 'Спутниковый источник недоступен.',
            'coverage' => null, 'completeness' => null, 'data' => null, 'calculated_at' => CarbonImmutable::now('UTC')->toISOString()];
        if (! config('satellite.runtime') || ! config('satellite.sha256')) {
            return $block;
        }
        try {
            $result = $this->read($point, $radius);
            if ($result['status'] !== 'READY') {
                $block['code'] = $result['reason'];

                return $block;
            }
            unset($result['metrics']); // Operational timings are not public place metadata.
            $selected = ['date' => $date, 'status' => 'UNAVAILABLE', 'reason' => $date === null ? 'DATE_NOT_SELECTED' : 'DATE_NOT_IN_CATALOG', 'coverage' => null, 'mean_ndvi' => null,
                'mean_ndvi_reason' => $date === null ? 'DATE_NOT_SELECTED' : 'DATE_NOT_IN_CATALOG', 'layers' => null];
            foreach ($result['releases'] as $row) {
                if ($row['date'] === $date) {
                    $selected = $row + ['layers' => null];
                }
            }
            $delivery = new SatelliteDelivery;
            $result['delivery_status'] = 'UNAVAILABLE';
            $result['legend'] = config('satellite.legend');
            try {
                $c = $delivery->catalog();
                $result['delivery_status'] = 'READY';
                if (isset($selected['manifest_sha256']) && ($selected['coverage']['prepared_pixels'] ?? 0) > 0) {
                    $selected['layers'] = $delivery->sources($c, $selected);
                }
            } catch (Throwable) {
                // Image delivery has its own availability; local circle results survive.
            }
            $result['selected'] = $selected;
            if (strlen(json_encode($result, JSON_THROW_ON_ERROR)) > 256 * 1024) {
                throw new \RuntimeException('RESPONSE_BUDGET_EXCEEDED');
            }
            $block['data'] = $result;
            $block['status'] = 'READY';
            $block['code'] = null;
            $block['message'] = null;
        } catch (Throwable) {
            $block['status'] = 'ERROR';
            $block['code'] = 'SATELLITE_READ_FAILED';
        }

        return $block;
    }

    protected function read(array $point, int $radius): array
    {
        return (new SatelliteCatalogReader(config('satellite.runtime'), config('satellite.sha256')))->forPoint($point['lon'], $point['lat'], $radius);
    }
}
