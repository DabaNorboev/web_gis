<?php

use App\Http\Middleware\LimitGeocodingRequest;
use App\Http\Middleware\PrivateGeocodingCors;
use App\Services\Geocoding\GeocodingFailure;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withSchedule(function (Schedule $schedule): void {
        if (config('air.schedule_enabled') && config('air.schedule_cron')) {
            $schedule->command('air:refresh')->cron(config('air.schedule_cron'))->timezone('UTC');
        }
    })
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->prepend(PrivateGeocodingCors::class);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Exception messages / SQL bindings / stack arguments may contain personal points.
        $exceptions->report(function (Throwable $error) {
            if (app()->bound('request') && request()->is('api/v1/geocoding/*')) {
                // No exception object, arguments, message, query or body in diagnostics.
                return false;
            }
            if (app()->bound('request') && request()->is('api/v1/satellite/*')) {
                return false;
            }
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
            if ($error instanceof GeocodingFailure) {
                return $error->response(LimitGeocodingRequest::requestId($request), $request->is('api/v1/place-analysis'));
            }
            if ($request->is('api/v1/geocoding/*')) {
                $status = $error instanceof HttpExceptionInterface ? $error->getStatusCode() : 503;
                $code = match ($status) {
                    405 => 'METHOD_NOT_ALLOWED', 413 => 'REQUEST_TOO_LARGE', 415 => 'UNSUPPORTED_MEDIA_TYPE', 422 => 'INVALID_REQUEST',
                    default => 'GEOCODING_UNAVAILABLE',
                };

                return (new GeocodingFailure($code, in_array($status, [405, 413, 415, 422], true) ? $status : 503))
                    ->response(LimitGeocodingRequest::requestId($request));
            }
            if ($request->is('api/v1/satellite/*')) {
                return response()->json(['code' => 'SATELLITE_TILE_UNAVAILABLE'], 404)
                    ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
            }
            if ($request->is('api/v1/place-analysis')) {
                if ($error instanceof HttpResponseException) {
                    return null; // Fixed validation and address resolver responses.
                }
                $status = $error instanceof HttpExceptionInterface ? $error->getStatusCode() : 503;
                $status = $error instanceof ValidationException ? 422 : $status;
                $status = $status >= 500 ? 503 : $status;
                $code = match ($status) {
                    413 => 'REQUEST_TOO_LARGE', 415 => 'UNSUPPORTED_MEDIA_TYPE', 422 => 'INVALID_REQUEST',
                    429 => 'TOO_MANY_REQUESTS', 404 => 'NOT_FOUND', 405 => 'METHOD_NOT_ALLOWED',
                    default => $status >= 500 ? 'SERVICE_UNAVAILABLE' : 'REQUEST_REJECTED',
                };

                return response()->json(['code' => $code, 'message' => $status >= 500
                    ? 'Анализ места временно недоступен.' : 'Запрос анализа места отклонён.'], $status,
                    $error instanceof HttpExceptionInterface ? $error->getHeaders() : []);
            }
            if ($request->is('trips', 'api/v1/trips/*', 'api/v1/addresses/resolve-point')
                && ! $error instanceof ValidationException
                && (! $error instanceof HttpExceptionInterface || $error->getStatusCode() >= 500)) {
                return response()->json(['message' => $request->is('api/v1/addresses/resolve-point') ? 'Подпись точки временно недоступна.' : 'Расчёт поездок временно недоступен.'], 500)
                    ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer');
            }
        });
        $exceptions->respond(function ($response) {
            if (request()->is('api/v1/addresses/resolve-point', 'api/v1/place-analysis', 'api/v1/geocoding/*')) {
                $response->headers->set('Cache-Control', 'no-store');
                $response->headers->set('Referrer-Policy', 'no-referrer');
            }

            return $response;
        });
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
