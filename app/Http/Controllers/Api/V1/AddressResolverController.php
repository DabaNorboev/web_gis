<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Services\Addresses\AddressResolverService;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Log;
use Throwable;

class AddressResolverController extends Controller
{
    public function __invoke(string $id, AddressResolverService $service): JsonResponse
    {
        try {
            $address = $service->resolve($id);
        } catch (HttpResponseException $error) {
            throw $error;
        } catch (Throwable $error) {
            Log::error('Address resolver failed.', ['exception_type' => get_class($error)]);
            $service->unavailable();
        }

        return response()->json(['address' => $address, 'capabilities' => AddressResolverService::CAPABILITIES])
            ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
    }
}
