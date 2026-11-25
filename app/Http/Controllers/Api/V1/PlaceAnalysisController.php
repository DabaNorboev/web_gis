<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\PlaceAnalysisRequest;
use App\Http\Requests\PlaceSelectionRequest;
use App\Services\Analysis\PlaceAnalysisService;
use App\Services\Analysis\PlaceServiceArea;
use Illuminate\Http\JsonResponse;

class PlaceAnalysisController extends Controller
{
    public function selection(PlaceSelectionRequest $request, PlaceServiceArea $serviceArea): JsonResponse
    {
        $serviceArea->requireCovered($request->validated());

        return response()->json(['status' => 'INSIDE'])->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
    }

    public function __invoke(PlaceAnalysisRequest $request, PlaceAnalysisService $service): JsonResponse
    {
        return response()->json($service->analyze($request->validated()))
            ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
    }
}
