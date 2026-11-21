<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class LimitPlaceAnalysisRequest
{
    public function handle(Request $request, Closure $next): mixed
    {
        abort_if(strlen($request->getContent()) > 8192, 413);
        abort_unless($request->isJson(), 415);
        try {
            $body = json_decode($request->getContent(), false, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            abort(422);
        }
        abort_unless($body instanceof \stdClass, 422);
        abort_if($request->query->count() !== 0, 422);
        if (isset($body->analysis_version)) {
            abort_unless(strtolower(trim(explode(';', $request->header('Content-Type', ''))[0])) === 'application/json'
                && in_array('application/json', $request->getAcceptableContentTypes(), true), 415);
        }

        return $next($request);
    }
}
