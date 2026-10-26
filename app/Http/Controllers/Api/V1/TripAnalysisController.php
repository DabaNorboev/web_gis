<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\TripAnalysisRequest;
use App\Services\Routing\LocalCarRouterProvider;
use Illuminate\Http\JsonResponse;

class TripAnalysisController extends Controller
{
    public function __invoke(TripAnalysisRequest $request, LocalCarRouterProvider $provider): JsonResponse
    {
        $data = $request->validated();

        return response()->json($provider->analyze($data['start'], $data['places']))->header('Cache-Control', 'no-store');
    }
}
