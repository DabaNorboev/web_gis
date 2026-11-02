<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\AddressProfileRequest;
use App\Services\Addresses\AddressProfileService;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;

class AddressProfileController extends Controller
{
    public function __invoke(AddressProfileRequest $request, string $id, AddressProfileService $service): JsonResponse
    {
        $data = $request->validated();

        $selected = ($data['scope'] ?? null) === 'selected';
        try {
            $profile = $service->profile($id, (int) ($data['radius_m'] ?? 500), $selected ? $data['blocks'] : null);
        } catch (HttpResponseException|HttpExceptionInterface $error) {
            throw $error;
        } catch (Throwable $error) {
            if (! $selected) {
                throw $error;
            }
            Log::error('Selected profile request failed.', ['exception_type' => get_class($error)]);

            return response()->json(['code' => 'SERVICE_UNAVAILABLE', 'message' => 'Профиль временно недоступен. Повторите позже.'], 503)
                ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
        }

        return response()->json($profile)->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
    }
}
