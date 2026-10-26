<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\TransportAnalysisRequest;
use App\Services\Transport\TransportAnalysisService;
use Illuminate\Http\JsonResponse;

class TransportAnalysisController extends Controller
{
    public function __invoke(TransportAnalysisRequest $request, TransportAnalysisService $service): JsonResponse
    {
        $coordinates = $request->validated();

        return response()->json($service->analyze((float) $coordinates['lon'], (float) $coordinates['lat'], (int) ($coordinates['radius_m'] ?? 500)));
    }
}
