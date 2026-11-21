<?php

// Isolated synthetic TLS peer. Never logs request lines, URLs or body.
$server = stream_socket_server('tcp://127.0.0.1:0', $errno, $error, STREAM_SERVER_BIND | STREAM_SERVER_LISTEN,
    stream_context_create(['ssl' => ['local_cert' => $argv[1], 'local_pk' => $argv[2], 'verify_peer' => false]]));
echo stream_socket_get_name($server, false)."\n";
flush();
$socket = stream_socket_accept($server, 20);
if (! $socket) {
    exit(1);
}
$mode = $argv[3];
if ($mode === 'connect') {
    sleep(4);
}
if (! @stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_SERVER)) {
    exit(0);
}
while (($line = fgets($socket)) !== false && trim($line) !== '') {
    // Discard request headers; no retention/diagnostics.
}
if ($mode === 'headers') {
    sleep(10);
}
if ($mode === 'redirect') {
    @fwrite($socket, "HTTP/1.1 302 Found\r\nLocation: https://synthetic.invalid/SECRET\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
} elseif ($mode === 'gzip') {
    $body = gzencode(str_repeat('x', 1048577));
    @fwrite($socket, "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ".strlen($body)."\r\nConnection: close\r\n\r\n".$body);
} elseif ($mode === 'quota') {
    $body = '{"code":"QUOTA_EXCEEDED"}';
    @fwrite($socket, "HTTP/1.1 403 Forbidden\r\nContent-Length: ".strlen($body)."\r\nConnection: close\r\n\r\n".$body);
} elseif ($mode === 'rate') {
    @fwrite($socket, "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 95\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
} else {
    $body = '{"results":[]}';
    @fwrite($socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ".strlen($body)."\r\nConnection: close\r\n\r\n");
    if ($mode === 'body') {
        sleep(10);
    }
    if ($mode === 'chunks') {
        foreach (str_split($body) as $byte) {
            @fwrite($socket, $byte);
            usleep(800000);
        }
    } else {
        @fwrite($socket, $body);
    }
}
fclose($socket);
fclose($server);
