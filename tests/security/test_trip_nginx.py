"""Run the real Nginx privacy probe in a disposable, networkless container."""
import argparse
import pathlib
import re
import signal
import shutil
import subprocess
import time
import unittest
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROBE = pathlib.Path(__file__).with_name('trip_nginx_probe.sh')


def nginx_image():
    # Read the literal project image without Compose interpolation or loading .env.
    compose = (ROOT / 'docker-compose.yml').read_text()
    match = re.search(r'^    nginx:\n        image: ([a-zA-Z0-9./:_-]+)\s*$', compose, re.M)
    if not match:
        raise AssertionError('image selection: expected a literal Nginx image in Compose')
    return match[1]


def docker_failure(stderr):
    """Classify errors without disclosing Docker output, paths or registry URLs."""
    for fragment, reason in (
        ('permission denied', 'Docker permission denied'),
        ('cannot connect', 'Docker daemon unavailable'),
        ('failed to connect', 'Docker daemon unavailable'),
        ('no such file or directory', 'Docker executable or input unavailable'),
        ('pull access denied', 'image unavailable or registry access denied'),
        ('manifest unknown', 'image unavailable'),
        ('network', 'Docker network or image retrieval failure'),
    ):
        if fragment in stderr.lower():
            return reason
    return 'Docker command failed (details suppressed for privacy)'


class ProbeInterrupted(Exception):
    """Signal cancellation that subprocess must not retry as an interrupted syscall."""


def run_probe(config, timeout):
    config = config.resolve(strict=True)
    image = nginx_image()
    if shutil.which('docker') is None:
        raise AssertionError('container creation: Docker executable unavailable')
    name = 'placelens-nginx-privacy-' + uuid.uuid4().hex
    deadline = time.monotonic() + timeout
    stage = 'container creation / image retrieval'
    # Only fixed labels from our probe can reach failure diagnostics.
    safe_stages = set(re.findall(r"^stage='([^']+)'$", PROBE.read_text(), re.M))

    def interrupted(signum, frame):
        raise ProbeInterrupted

    previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}
    attempted = False
    try:
        attempted = True
        result = subprocess.run([
            'docker', 'create', '--name', name, '--network=none', '--read-only',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
            '--mount', f'type=bind,src={config},dst=/privacy/nginx.conf,readonly',
            '--mount', f'type=bind,src={PROBE},dst=/privacy/probe.sh,readonly',
            '--entrypoint', '/bin/sh', image, '/privacy/probe.sh',
        ], capture_output=True, text=True, timeout=max(.001, deadline - time.monotonic()))
        if result.returncode:
            raise AssertionError(f'{stage}: {docker_failure(result.stderr)} (exit {result.returncode})')
        stage = 'Nginx privacy probe'
        result = subprocess.run(['docker', 'start', '--attach', name], capture_output=True,
                                text=True, timeout=max(.001, deadline - time.monotonic()))
        if result.returncode:
            reason = docker_failure(result.stderr)
            for line in result.stdout.splitlines():
                match = re.fullmatch(r'FAIL: (.+) \(exit ([0-9]+)\)', line)
                if match and match[1] in safe_stages:
                    reason = f'{match[1]} (probe exit {match[2]})'
            raise AssertionError(f'{stage}: {reason} (exit {result.returncode})')
        if 'PASS: safe access format, no-referrer, 502, 413, no request spool; isolated PID exited' not in result.stdout.splitlines():
            raise AssertionError(f'{stage}: missing completion marker')
    except subprocess.TimeoutExpired:
        raise AssertionError(f'{stage}: timeout after {timeout:g}s') from None
    except ProbeInterrupted:
        raise AssertionError(f'{stage}: interrupted; removing owned container') from None
    except OSError:
        raise AssertionError(f'{stage}: Docker executable or input unavailable') from None
    finally:
        # SIGTERM (including CI cancellation) must not interrupt owned-container cleanup.
        for sig in previous:
            signal.signal(sig, signal.SIG_IGN)
        try:
            if attempted:
                try:
                    cleanup = subprocess.run(['docker', 'rm', '--force', name],
                                             capture_output=True, text=True, timeout=15)
                    if cleanup.returncode and 'No such container' not in cleanup.stderr:
                        raise AssertionError('container cleanup: ' + docker_failure(cleanup.stderr))
                except (OSError, subprocess.TimeoutExpired):
                    raise AssertionError('container cleanup: Docker unavailable or cleanup timeout') from None
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)


class TripNginxPrivacyTest(unittest.TestCase):
    config = ROOT / 'docker/nginx/nginx.conf'
    timeout = 120.0

    def test_synthetic_uri_referer_and_body_are_absent_from_server_logs(self):
        run_probe(self.config, self.timeout)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=pathlib.Path, default=TripNginxPrivacyTest.config,
                        help='temporary config copy for negative controls; default: production config')
    parser.add_argument('--timeout', type=float, default=TripNginxPrivacyTest.timeout,
                        help='total Docker create/start budget in seconds (default: 120; cleanup: +15)')
    args, remaining = parser.parse_known_args()
    if not 0 < args.timeout <= 240:
        parser.error('--timeout must be greater than 0 and at most 240 seconds')
    TripNginxPrivacyTest.config = args.config
    TripNginxPrivacyTest.timeout = args.timeout
    unittest.main(argv=[__file__, *remaining])
