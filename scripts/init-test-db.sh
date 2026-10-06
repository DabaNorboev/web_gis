#!/bin/sh
set -eu

# A separate database keeps integration tests away from development data.
docker compose exec -T db sh -c 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres' <<'SQL'
SELECT 'CREATE DATABASE web_gis_test'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'web_gis_test')
\gexec
\connect web_gis_test
CREATE EXTENSION IF NOT EXISTS postgis;
SQL
