#!/bin/sh
set -eu
case "${FRONTEND_ASSETS_MODE:-dev}" in
    dev) exec node -e "fetch('http://127.0.0.1:5173/@vite/client').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" ;;
    build) exec node -e "const fs = require('node:fs'); const m = JSON.parse(fs.readFileSync('public/build/manifest.json')); process.exit(Object.values(m).every(v => fs.existsSync('public/build/' + v.file)) ? 0 : 1)" ;;
    *) exit 1 ;;
esac
