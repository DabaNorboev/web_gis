#!/bin/sh
set -eu
case "${FRONTEND_ASSETS_MODE:-dev}" in
    dev|build) ;;
    *) echo 'FRONTEND_ASSETS_MODE must be dev or build.' >&2; exit 1 ;;
esac
if [ -n "${SATELLITE_RUNTIME:-}${SATELLITE_RUNTIME_SHA256:-}${SATELLITE_DELIVERY:-}${SATELLITE_DELIVERY_SHA256:-}" ]; then
    for key in SATELLITE_RUNTIME SATELLITE_RUNTIME_SHA256 SATELLITE_DELIVERY SATELLITE_DELIVERY_SHA256; do
        eval 'value=${'"$key"':-}'
        test -n "$value" || { echo "Satellite activation requires both SATELLITE_*_DIR paths and both trusted SHA256 pins (missing $key)." >&2; exit 1; }
    done
    for key in SATELLITE_RUNTIME_SHA256 SATELLITE_DELIVERY_SHA256; do
        eval 'value=${'"$key"'}'
        printf '%s\n' "$value" | LC_ALL=C grep -Eq '^[a-f0-9]{64}$' || { echo "$key must be a trusted lowercase SHA-256." >&2; exit 1; }
    done
fi
exec docker-php-entrypoint php-fpm
