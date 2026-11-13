#!/bin/sh
set -eu
case "${FRONTEND_ASSETS_MODE:-dev}" in
    dev) exec npm run dev -- --strictPort ;;
    build)
        test -s public/build/manifest.json || { echo 'build mode requires public/build/manifest.json; run npm run build explicitly.' >&2; exit 1; }
        exec sleep infinity ;;
    *) echo 'FRONTEND_ASSETS_MODE must be dev or build.' >&2; exit 1 ;;
esac
