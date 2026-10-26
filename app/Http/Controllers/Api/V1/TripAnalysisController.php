<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\TripAnalysisRequest;
use App\Services\Routing\LocalCarRouterProvider;
use App\Services\Routing\LocalWalkingRouterProvider;
use Illuminate\Http\JsonResponse;

class TripAnalysisController extends Controller
{
    public function __invoke(TripAnalysisRequest $request, LocalCarRouterProvider $provider, LocalWalkingRouterProvider $walking): JsonResponse
    {
        $data = $request->validated();

        $router = $data['mode'] === 'walking' ? $walking : $provider;

        return response()->json($router->analyze($data['start'], $data['places']))->header('Cache-Control', 'no-store');
    }
}
