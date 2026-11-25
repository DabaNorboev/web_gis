<?php

namespace App\Services\Analysis;

use App\Services\Geocoding\GeocodingScope;
use Illuminate\Http\Exceptions\HttpResponseException;
use Throwable;

class PlaceServiceArea
{
    public function __construct(private GeocodingScope $scope) {}

    public function requireCovered(array $point): void
    {
        try {
            $covered = $this->scope->covers($point);
        } catch (Throwable) {
            throw new HttpResponseException(response()->json([
                'code' => 'SERVICE_AREA_UNAVAILABLE',
                'message' => 'Не удалось проверить границу Красноярска. Попробуйте ещё раз.',
            ], 503));
        }

        if (! $covered) {
            throw new HttpResponseException(response()->json([
                'code' => 'OUTSIDE_SERVICE_AREA',
                'message' => 'Точку для анализа можно выбрать только в пределах Красноярска.',
            ], 422));
        }
    }
}
