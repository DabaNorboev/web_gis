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
            $this->reject('SERVICE_AREA_UNAVAILABLE', 'Не удалось проверить границу Красноярска. Попробуйте ещё раз.', 503);
        }

        if (! $covered) {
            $this->reject('OUTSIDE_SERVICE_AREA', 'Точку для анализа можно выбрать только в пределах Красноярска.', 422);
        }
    }

    private function reject(string $code, string $message, int $status): never
    {
        throw new HttpResponseException(response()->json(['code' => $code, 'message' => $message], $status)
            ->header('Cache-Control', 'no-store')
            ->header('Referrer-Policy', 'no-referrer'));
    }
}
