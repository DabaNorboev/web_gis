# Executed only in the disposable container; all diagnostics are fixed labels.
set -eu
stage='temporary files'
trap 'code=$?; if [ "$code" -ne 0 ]; then printf "FAIL: %s (exit %s)\n" "$stage" "$code"; fi' EXIT
audit_dir=$(mktemp -d /tmp/placelens-nginx-privacy.XXXXXX)
chmod 755 "$audit_dir"
cleanup() {
 code=$?
 trap - EXIT
 if [ -f "$audit_dir/nginx.pid" ]; then
  nginx -p "$audit_dir/" -c "$audit_dir/main.conf" -s quit >/dev/null 2>&1 || :
 fi
 if [ "$code" -ne 0 ]; then printf 'FAIL: %s (exit %s)\n' "$stage" "$code"; fi
 exit "$code"
}
trap cleanup EXIT
mkdir "$audit_dir/www" "$audit_dir/body" "$audit_dir/fastcgi"
printf 'synthetic page' > "$audit_dir/www/trips"
sed \
 -e 's/listen 80;/listen 127.0.0.1:28080;/' \
 -e "s@root /var/www/html/public;@root $audit_dir/www;@" \
 -e "s@/var/log/nginx/access.log@$audit_dir/access.log@" \
 -e 's@include fastcgi_params;@include /etc/nginx/fastcgi_params;@g' \
 -e 's/fastcgi_pass php:9000;/fastcgi_pass 127.0.0.1:9;/g' /privacy/nginx.conf > "$audit_dir/server.conf"
cat > "$audit_dir/main.conf" <<EOF
pid $audit_dir/nginx.pid;
error_log $audit_dir/global.log notice;
worker_processes 1;
events { worker_connections 32; }
http {
 client_body_temp_path $audit_dir/body;
 fastcgi_temp_path $audit_dir/fastcgi;
 proxy_temp_path $audit_dir/proxy;
 uwsgi_temp_path $audit_dir/uwsgi;
 scgi_temp_path $audit_dir/scgi;
 include /etc/nginx/mime.types;
 include $audit_dir/server.conf;
}
EOF
stage='configuration validation'
nginx -p "$audit_dir/" -c "$audit_dir/main.conf" -t > "$audit_dir/config-check.txt" 2>&1
printf 'STAGE: config validated\n'
stage='Nginx startup'
nginx -p "$audit_dir/" -c "$audit_dir/main.conf" > "$audit_dir/startup.txt" 2>&1
printf 'STAGE: isolated process started\n'
stage='GET privacy header'
# A synthetic old query and a full synthetic Referer must both be discarded.
wget -S -O /dev/null --header='Referer: http://synthetic.invalid/?trip=SYNTHETIC_PRIVATE_CANARY' \
 'http://127.0.0.1:28080/trips?trip=SYNTHETIC_PRIVATE_CANARY' > "$audit_dir/client.txt" 2>&1
grep -qi 'Referrer-Policy: no-referrer' "$audit_dir/client.txt"
printf 'STAGE: synthetic GET and header checked\n'
stage='trip upstream status'
# Exercise upstream failure and body handling, without invoking PHP or OSRM.
wget -S -O /dev/null --header='Content-Type: application/json' \
 --post-data='{"mode":"driving","start":{"lon":0,"lat":0},"places":[{"lon":0.001,"lat":0.001,"label":"SYNTHETIC_PRIVATE_CANARY"}]}' \
 'http://127.0.0.1:28080/api/v1/trips/analyze?trip=SYNTHETIC_PRIVATE_CANARY' > "$audit_dir/upstream-client.txt" 2>&1 || true
grep -Eq 'HTTP/[0-9.]+ 502( |\r|$)' "$audit_dir/upstream-client.txt"
printf 'STAGE: synthetic upstream failure checked\n'
stage='trip body limit'
payload=$(head -c 9000 /dev/zero | tr '\0' x)
wget -S -O /dev/null --post-data="$payload" 'http://127.0.0.1:28080/api/v1/trips/analyze' > "$audit_dir/large-client.txt" 2>&1 || true
grep -Eq 'HTTP/[0-9.]+ 413( |\r|$)' "$audit_dir/large-client.txt"
printf 'STAGE: synthetic oversized body checked\n'
stage='point upstream status and privacy headers'
# Point labels use the same privacy boundary with a smaller in-memory body.
point_body='{"lon":0,"lat":0,"label":"SYNTHETIC_PRIVATE_CANARY"}'
{ printf 'POST /api/v1/addresses/resolve-point?point=SYNTHETIC_PRIVATE_CANARY HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nReferer: http://synthetic.invalid/?point=SYNTHETIC_PRIVATE_CANARY\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "${#point_body}" "$point_body"; sleep .2; } | nc -w 2 127.0.0.1 28080 > "$audit_dir/point-client.txt"
grep -Eq 'HTTP/[0-9.]+ 502( |\r|$)' "$audit_dir/point-client.txt"
grep -qi 'Cache-Control: no-store' "$audit_dir/point-client.txt"
grep -qi 'Referrer-Policy: no-referrer' "$audit_dir/point-client.txt"
stage='point body limit and no-store'
payload=$(head -c 1100 /dev/zero | tr '\0' x)
{ printf 'POST /api/v1/addresses/resolve-point HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1100\r\nConnection: close\r\n\r\n%s' "$payload"; sleep .2; } | nc -w 2 127.0.0.1 28080 > "$audit_dir/point-large.txt"
grep -Eq 'HTTP/[0-9.]+ 413( |\r|$)' "$audit_dir/point-large.txt"
grep -qi 'Cache-Control: no-store' "$audit_dir/point-large.txt"
printf 'STAGE: point label privacy, no-store and size limit checked\n'
stage='Nginx graceful shutdown'
nginx -p "$audit_dir/" -c "$audit_dir/main.conf" -s quit > /dev/null 2>&1
for audit_attempt in 1 2 3 4 5; do [ ! -f "$audit_dir/nginx.pid" ] && break; sleep .1; done
test ! -f "$audit_dir/nginx.pid"
stage='fixed access route classes'
grep -q 'GET trips HTTP' "$audit_dir/access.log"
grep -q 'POST trip_analysis HTTP' "$audit_dir/access.log"
grep -q 'POST point_address HTTP' "$audit_dir/access.log"
stage='server log privacy'
if grep -Eq 'SYNTHETIC_PRIVATE_CANARY|synthetic.invalid|[?&]|"lon"|"places"' "$audit_dir/access.log" "$audit_dir/global.log" "$audit_dir/startup.txt" "$audit_dir/config-check.txt"; then exit 41; else test "$?" -eq 1; fi
stage='fixed access route classes'
# Every access record must use a fixed route class, not just the checked rows.
if grep -Ev '^[0-9.]+ \[[^]]+\] "(GET|POST) (other|trips|trip_analysis|point_address|health) HTTP/[0-9.]+" [0-9]{3} [0-9]+$' "$audit_dir/access.log" > /dev/null; then exit 42; else test "$?" -eq 1; fi
stage='request body spool'
test -z "$(ls -A "$audit_dir/body")"
printf 'PASS: safe access format, no-referrer, 502, 413, no request spool; isolated PID exited\n'
