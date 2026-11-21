#!/usr/bin/env python3
"""Opt-in Docker runtime acceptance. Only synthetic, disposable network-none resources.

Does not build, activate Compose, read .env, or use production volumes/networks.
Logs remain in the printed /tmp directory; only this invocation's containers are removed.
"""
import argparse
import base64
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]


def docker(*args, **kwargs):
    return subprocess.run(['docker', *map(str, args)], check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='Separate candidate image tag or ID')
    parser.add_argument('--checks', nargs='+', choices=['cli', 'backend', 'state', 'fpm'],
                        default=['cli', 'backend', 'state', 'fpm'])
    args = parser.parse_args()
    evidence = Path(tempfile.mkdtemp(prefix='placelens-g3-runtime-'))
    print(f'Evidence: {evidence}', flush=True)
    (evidence / 'empty.env').touch()
    (evidence / 'resolv.conf').write_text('nameserver 127.0.0.1\noptions timeout:10 attempts:1\n')
    (evidence / 'nginx.conf').write_text('''
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {}
http {
    access_log off;
    client_body_temp_path /tmp/client;
    fastcgi_temp_path /tmp/fastcgi;
    server {
        listen 127.0.0.1:8080;
        location = /synthetic {
            include /etc/nginx/fastcgi_params;
            fastcgi_param SCRIPT_FILENAME /var/www/html/tests/Support/Geocoding/runtime-fpm.php;
            fastcgi_pass 127.0.0.1:9000;
            fastcgi_read_timeout 12s;
            fastcgi_ignore_client_abort off;
        }
    }
}
''')
    suffix = uuid.uuid4().hex[:12]
    db, nginx, php = (f'placelens-g3-{service}-{suffix}' for service in ('db', 'nginx', 'php'))
    created = []
    try:
        docker('run', '-d', '--name', db, '--network', 'none', '--read-only',
               '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', '--tmpfs', '/var/run/postgresql',
               '--tmpfs', '/tmp', '-e', 'POSTGRES_DB=web_gis_test', '-e', 'POSTGRES_USER=synthetic',
               '-e', 'POSTGRES_PASSWORD=synthetic', 'postgis/postgis:16-3.4', stdout=subprocess.DEVNULL)
        created.append(db)
        for _ in range(60):
            ready = subprocess.run(['docker', 'exec', db, 'pg_isready', '-h', '127.0.0.1', '-U', 'synthetic', '-d', 'web_gis_test'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Disposable PostGIS did not become ready')
        docker('run', '-d', '--name', nginx, '--network', f'container:{db}', '--read-only',
               '--tmpfs', '/tmp', '--tmpfs', '/var/cache/nginx',
               '--mount', f'type=bind,src={evidence / "nginx.conf"},dst=/etc/nginx/nginx.conf,readonly',
               '--entrypoint', 'nginx', 'nginx:1.27-alpine', '-g', 'daemon off;', stdout=subprocess.DEVNULL)
        created.append(nginx)
        command = ['run', '--name', php, '--network', f'container:{db}', '--read-only', '--user', 'root',
                   '--tmpfs', '/tmp:rw,mode=1777', '--mount', f'type=bind,src={ROOT},dst=/var/www/html,readonly',
                   '--mount', f'type=bind,src={evidence / "empty.env"},dst=/var/www/html/.env,readonly',
                   '--mount', f'type=bind,src={evidence / "resolv.conf"},dst=/etc/resolv.conf,readonly',
                   '--mount', f'type=bind,src={evidence},dst=/evidence', '-w', '/var/www/html']
        env = dict(APP_ENV='testing', APP_DEBUG='false', APP_KEY='base64:' + base64.b64encode(b'a' * 32).decode(),
                   GEOAPIFY_API_KEY='synthetic', GEOCODING_ENABLED='false',
                   APP_CONFIG_CACHE='/tmp/config.php', APP_PACKAGES_CACHE='/tmp/packages.php',
                   APP_SERVICES_CACHE='/tmp/services.php', APP_ROUTES_CACHE='/tmp/routes.php',
                   APP_EVENTS_CACHE='/tmp/events.php', VIEW_COMPILED_PATH='/tmp/views', LOG_CHANNEL='stderr',
                   CACHE_STORE='array', SESSION_DRIVER='array', DB_HOST='127.0.0.1', DB_PORT='5432',
                   DB_USERNAME='synthetic', DB_PASSWORD='synthetic', DB_DATABASE=':memory:', DB_URL='',
                   G3_ISOLATED_DNS='1', G3_FPM_HTTP='1', G3_RUNTIME_CHECKS=' '.join(args.checks))
        for key, value in env.items():
            command.extend(['-e', f'{key}={value}'])
        command.extend([args.image, 'sh', 'tests/Support/Geocoding/check-runtime.sh'])
        created.append(php)
        with (evidence / 'checks.log').open('w') as log:
            result = subprocess.run(['docker', *command], stdout=log, stderr=subprocess.STDOUT, timeout=300)
        print((evidence / 'checks.log').read_text(), flush=True)
        if result.returncode:
            raise RuntimeError(f'Runtime checks failed ({result.returncode}); see evidence')
    finally:
        for name in reversed(created):
            with (evidence / f'{name}.log').open('w') as log:
                subprocess.run(['docker', 'logs', name], stdout=log, stderr=subprocess.STDOUT, check=False)
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, check=False)


if __name__ == '__main__':
    main()
