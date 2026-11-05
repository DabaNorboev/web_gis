<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Exception messages / SQL bindings / stack arguments may contain personal points.
        $exceptions->report(function (Throwable $error) {
            if (app()->bound('request') && request()->is('api/v1/place-analysis')) {
                Log::error('Place analysis request failed.', ['exception_type' => get_class($error)]);

                return false;
            }
            if (app()->bound('request') && request()->is('trips', 'api/v1/trips/*', 'api/v1/addresses/resolve-point')) {
                Log::error(request()->is('api/v1/addresses/resolve-point') ? 'Point address request failed.' : 'Trip request failed.', ['exception_type' => get_class($error)]);

                return false;
            }
        });
        $exceptions->render(function (Throwable $error, Request $request) {
            if ($request->is('api/v1/place-analysis')) {
                if ($error instanceof \Illuminate\Http\Exceptions\HttpResponseException) {
                    return null; // Fixed validation and address resolver responses.
                }
                $status = $error instanceof \Symfony\Component\HttpKernel\Exception\HttpExceptionInterface ? $error->getStatusCode() : 503;
                $status = $error instanceof \Illuminate\Validation\ValidationException ? 422 : $status;
                $status = $status >= 500 ? 503 : $status;
                $code = match ($status) {
                    413 => 'REQUEST_TOO_LARGE', 415 => 'UNSUPPORTED_MEDIA_TYPE', 422 => 'INVALID_REQUEST',
                    429 => 'TOO_MANY_REQUESTS', 404 => 'NOT_FOUND', 405 => 'METHOD_NOT_ALLOWED',
                    default => $status >= 500 ? 'SERVICE_UNAVAILABLE' : 'REQUEST_REJECTED',
                };

                return response()->json(['code' => $code, 'message' => $status >= 500
                    ? 'Анализ места временно недоступен.' : 'Запрос анализа места отклонён.'], $status,
                    $error instanceof \Symfony\Component\HttpKernel\Exception\HttpExceptionInterface ? $error->getHeaders() : []);
            }
            if ($request->is('trips', 'api/v1/trips/*', 'api/v1/addresses/resolve-point')
                && ! $error instanceof \Illuminate\Validation\ValidationException
                && (! $error instanceof \Symfony\Component\HttpKernel\Exception\HttpExceptionInterface || $error->getStatusCode() >= 500)) {
                return response()->json(['message' => $request->is('api/v1/addresses/resolve-point') ? 'Подпись точки временно недоступна.' : 'Расчёт поездок временно недоступен.'], 500)
                    ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
            }
        });
        $exceptions->respond(function ($response) {
            if (request()->is('api/v1/addresses/resolve-point', 'api/v1/place-analysis')) {
                $response->headers->set('Cache-Control', 'no-store');
                $response->headers->set('Referrer-Policy', 'no-referrer');
            }

            return $response;
        });
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
