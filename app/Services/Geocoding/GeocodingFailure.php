<?php

namespace App\Services\Geocoding;

use Illuminate\Http\JsonResponse;
use RuntimeException;

class GeocodingFailure extends RuntimeException
{
    public function __construct(public readonly string $errorCode, public readonly int $status = 503, public readonly ?int $retryAfter = null)
    {
        parent::__construct('Geocoding operation rejected.');
    }

    public function response(?string $requestId = null, bool $analysis = false): JsonResponse
    {
        $body = ['code' => $this->errorCode, 'message' => 'Запрос отклонён.'];
        if (! $analysis) {
            $body += ['request_id' => $requestId, 'retry_after_s' => $this->retryAfter];
        }

        return response()->json($body, $this->status, $this->retryAfter === null ? [] : ['Retry-After' => (string) $this->retryAfter])
            ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
    }
}
