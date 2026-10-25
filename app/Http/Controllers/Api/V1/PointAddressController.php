<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\PointAddressRequest;
use App\Services\Addresses\PointAddressService;
use Illuminate\Http\JsonResponse;

class PointAddressController extends Controller
{
    public function __invoke(PointAddressRequest $request, PointAddressService $service): JsonResponse
    {
        return response()->json($service->resolve((float) $request->validated('lon'), (float) $request->validated('lat')))
            ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
    }
}
