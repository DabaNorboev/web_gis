#!/bin/sh
set -eu
trap 'if test -f /tmp/g3-fpm.log; then cp /tmp/g3-fpm.log /evidence/fpm-process.log; fi' EXIT
php -r 'echo json_encode(["php"=>PHP_VERSION,"curl"=>curl_version(),"extensions"=>get_loaded_extensions()], JSON_PRETTY_PRINT),"\n";' > /evidence/runtime.json
cat /evidence/runtime.json
apk info -v > /evidence/apk-manifest.txt
composer check-platform-reqs --no-interaction
for step in ${G3_RUNTIME_CHECKS:-cli backend state fpm}; do
case "$step" in
cli)
php -d curl.cainfo=/tmp/placelens-g3-ca.pem vendor/bin/phpunit --do-not-cache-result --no-logging --no-coverage \
    --log-junit /evidence/cli.xml --testdox tests/Feature/GeocodingTransportTest.php
;;
backend)
php vendor/bin/phpunit --do-not-cache-result --no-logging --no-coverage \
    --log-junit /evidence/backend.xml tests/Unit tests/Feature/GeocodingApiTest.php tests/Feature/GeocodingTokensTest.php tests/Feature/PlaceAnalysisApiTest.php
;;
state)
php vendor/bin/phpunit -c phpunit.postgis.xml --do-not-cache-result --no-logging --no-coverage \
    --log-junit /evidence/state.xml --filter GeocodingStateTest
;;
fpm)
# The transport suite removes its temporary certificate; generate a fresh synthetic CA for FPM.
php -r '
$cfg="/tmp/g3-fpm-ssl.cnf";
file_put_contents($cfg,"[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
$key=openssl_pkey_new(["private_key_bits"=>2048]);
$csr=openssl_csr_new(["commonName"=>"localhost"],$key,["config"=>$cfg]);
$cert=openssl_csr_sign($csr,null,$key,1,["config"=>$cfg,"x509_extensions"=>"ext"]);
openssl_x509_export_to_file($cert,"/tmp/placelens-g3-ca.pem");
openssl_pkey_export_to_file($key,"/tmp/g3-fpm-key.pem");
chmod("/tmp/g3-fpm-key.pem",0600);
'
php vendor/bin/phpunit -c phpunit.postgis.xml --do-not-cache-result --no-logging --no-coverage \
    --log-junit /evidence/fpm.xml --filter GeocodingFpmRuntimeTest

;;
esac
done
