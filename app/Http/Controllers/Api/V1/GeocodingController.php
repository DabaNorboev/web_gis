<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\GeocodingRequest;
use App\Services\Geocoding\GeocodingService;
use Illuminate\Http\JsonResponse;

class GeocodingController extends Controller
{
    public function __invoke(GeocodingRequest $request, GeocodingService $service): JsonResponse
    {
        return response()->json($service->execute($request->route('operation'), $request->validated(), $request->ip()))
            ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
    }
}
