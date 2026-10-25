<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\AddressProfileRequest;
use App\Services\Addresses\AddressProfileService;
use Illuminate\Http\JsonResponse;

class AddressProfileController extends Controller
{
    public function __invoke(AddressProfileRequest $request, string $id, AddressProfileService $service): JsonResponse
    {
        return response()->json($service->profile($id, (int) ($request->validated()['radius_m'] ?? 500)));
    }
}
