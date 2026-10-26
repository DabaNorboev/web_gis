"""Synthetic privacy regression in a separate /tmp Nginx process, no Laravel/DB.

Uses the existing nginx container, a private PID/config/port, and a closed upstream.
Never reads or truncates the live logs; never reloads/stops the live Nginx process.
"""
import base64
import pathlib
import secrets
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class TripNginxPrivacyTest(unittest.TestCase):
    def test_synthetic_uri_referer_and_body_are_absent_from_server_logs(self):
        source = (ROOT / 'docker/nginx/nginx.conf').read_text()
        config = base64.b64encode(source.encode()).decode()
        port = 20000 + secrets.randbelow(30000)
        script = r'''
set -eu
audit_dir=$(mktemp -d /tmp/placelens-nginx-privacy.XXXXXX)
chmod 755 "$audit_dir"
trap 'if [ -f "$audit_dir/nginx.pid" ]; then nginx -p "$audit_dir/" -c "$audit_dir/main.conf" -s quit >/dev/null 2>&1; fi' EXIT
mkdir "$audit_dir/www" "$audit_dir/body" "$audit_dir/fastcgi"
printf 'synthetic page' > "$audit_dir/www/trips"
printf '%s' '__CONFIG__' | base64 -d | sed \
 -e 's/listen 80;/listen 127.0.0.1:__PORT__;/' \
 -e "s@root /var/www/html/public;@root $audit_dir/www;@" \
 -e "s@/var/log/nginx/access.log@$audit_dir/access.log@" \
 -e 's@include fastcgi_params;@include /etc/nginx/fastcgi_params;@g' \
 -e 's/fastcgi_pass php:9000;/fastcgi_pass 127.0.0.1:9;/g' > "$audit_dir/server.conf"
cat > "$audit_dir/main.conf" <<EOF
pid $audit_dir/nginx.pid;
error_log $audit_dir/global.log notice;
worker_processes 1;
events { worker_connections 32; }
http {
 client_body_temp_path $audit_dir/body;
 fastcgi_temp_path $audit_dir/fastcgi;
 include /etc/nginx/mime.types;
 include $audit_dir/server.conf;
}
EOF
nginx -p "$audit_dir/" -c "$audit_dir/main.conf" -t > "$audit_dir/config-check.txt" 2>&1
printf 'STAGE: config validated\n'
nginx -p "$audit_dir/" -c "$audit_dir/main.conf"
printf 'STAGE: isolated process started\n'
# A synthetic old query and a full synthetic Referer must both be discarded.
wget -S -O /dev/null --header='Referer: http://synthetic.invalid/?trip=SYNTHETIC_PRIVATE_CANARY' \
 'http://127.0.0.1:__PORT__/trips?trip=SYNTHETIC_PRIVATE_CANARY' > "$audit_dir/client.txt" 2>&1
grep -qi 'Referrer-Policy: no-referrer' "$audit_dir/client.txt"
printf 'STAGE: synthetic GET and header checked\n'
# Exercise upstream failure and body handling, without invoking PHP or OSRM.
wget -S -O /dev/null --header='Content-Type: application/json' \
 --post-data='{"mode":"driving","start":{"lon":0,"lat":0},"places":[{"lon":0.001,"lat":0.001,"label":"SYNTHETIC_PRIVATE_CANARY"}]}' \
 'http://127.0.0.1:__PORT__/api/v1/trips/analyze?trip=SYNTHETIC_PRIVATE_CANARY' > "$audit_dir/upstream-client.txt" 2>&1 || true
grep -q '502' "$audit_dir/upstream-client.txt"
printf 'STAGE: synthetic upstream failure checked\n'
payload=$(head -c 9000 /dev/zero | tr '\0' x)
wget -S -O /dev/null --post-data="$payload" 'http://127.0.0.1:__PORT__/api/v1/trips/analyze' > "$audit_dir/large-client.txt" 2>&1 || true
grep -q '413' "$audit_dir/large-client.txt"
printf 'STAGE: synthetic oversized body checked\n'
# Point labels use the same privacy boundary with a smaller in-memory body.
point_body='{"lon":0,"lat":0,"label":"SYNTHETIC_PRIVATE_CANARY"}'
{ printf 'POST /api/v1/addresses/resolve-point?point=SYNTHETIC_PRIVATE_CANARY HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nReferer: http://synthetic.invalid/?point=SYNTHETIC_PRIVATE_CANARY\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "${#point_body}" "$point_body"; sleep .2; } | nc -w 2 127.0.0.1 __PORT__ > "$audit_dir/point-client.txt"
grep -q '502' "$audit_dir/point-client.txt"
grep -qi 'Cache-Control: no-store' "$audit_dir/point-client.txt"
grep -qi 'Referrer-Policy: no-referrer' "$audit_dir/point-client.txt"
payload=$(head -c 1100 /dev/zero | tr '\0' x)
{ printf 'POST /api/v1/addresses/resolve-point HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1100\r\nConnection: close\r\n\r\n%s' "$payload"; sleep .2; } | nc -w 2 127.0.0.1 __PORT__ > "$audit_dir/point-large.txt"
grep -q '413' "$audit_dir/point-large.txt"
grep -qi 'Cache-Control: no-store' "$audit_dir/point-large.txt"
printf 'STAGE: point label privacy, no-store and size limit checked\n'
nginx -p "$audit_dir/" -c "$audit_dir/main.conf" -s quit > /dev/null 2>&1
for audit_attempt in 1 2 3 4 5; do [ ! -f "$audit_dir/nginx.pid" ] && break; sleep .1; done
test ! -f "$audit_dir/nginx.pid"
grep -q 'GET trips HTTP' "$audit_dir/access.log"
grep -q 'POST point_address HTTP' "$audit_dir/access.log"
if grep -Eq 'SYNTHETIC_PRIVATE_CANARY|synthetic.invalid|[?&]|"lon"|"places"' "$audit_dir/access.log" "$audit_dir/global.log"; then exit 41; fi
test -z "$(ls -A "$audit_dir/body")"
printf 'PASS: safe access format, no-referrer, 502, 413, no request spool; isolated PID exited\n'
'''.replace('__CONFIG__', config).replace('__PORT__', str(port))
        result = subprocess.run(['docker', 'compose', 'exec', '-T', 'nginx', 'sh'],
                                input=script, text=True, capture_output=True, cwd=ROOT, timeout=20)
        # Do not echo client output, Nginx logs, URLs or request bodies even on failure.
        stages = [line for line in result.stdout.splitlines() if line.startswith('STAGE:')]
        self.assertEqual(result.returncode, 0, 'Isolated Nginx privacy regression failed; ' + '; '.join(stages))
        self.assertIn('PASS:', result.stdout)


if __name__ == '__main__':
    unittest.main()
