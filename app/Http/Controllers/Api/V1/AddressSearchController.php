<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\AddressSearchRequest;
use App\Services\Osm\Search\AddressSearchService;
use Illuminate\Http\JsonResponse;

class AddressSearchController extends Controller
{
    public function __invoke(AddressSearchRequest $request, AddressSearchService $service): JsonResponse
    {
        return response()->json($service->search($request->validated('q')));
    }
}
