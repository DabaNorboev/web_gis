<?php

// Intentionally never answer: tests the actual asynchronous resolver deadline, without external DNS.
$server = stream_socket_server('udp://127.0.0.1:53', $errno, $error, STREAM_SERVER_BIND);
if (! $server) {
    exit(1);
}
echo "READY\n";
flush();
sleep(20);
