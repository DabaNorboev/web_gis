#!/usr/bin/env python3
"""Bound browser setup on the disposable Ubuntu 24.04 GitHub-hosted runner."""
import os
from pathlib import Path
import re
import subprocess
import sys
import time

AZURE = 'http://azure.archive.ubuntu.com/ubuntu/'
ARCHIVE = 'https://archive.ubuntu.com/ubuntu/'
APT_LIMITS = '''Acquire::Retries "1";
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
APT::Update::Error-Mode "any";
'''


def probe(base):
    result = subprocess.run([
        'curl', '--fail', '--silent', '--show-error', '--location',
        '--connect-timeout', '5', '--max-time', '15', '--retry', '1',
        '--retry-all-errors', '--retry-max-time', '35', '--output', '/dev/null',
        base + 'dists/noble/InRelease',
    ], timeout=50)
    print(f'Mirror probe {base}: curl exit {result.returncode}', flush=True)
    return result.returncode == 0


def write_root(path, content):
    subprocess.run(['sudo', '-n', 'tee', str(path)], input=content, text=True,
                   stdout=subprocess.DEVNULL, check=True, timeout=10)


def prepare_apt(root=Path('/etc/apt')):
    sources = (root / 'sources.list.d/ubuntu.sources').read_text()
    if not re.search(r'^URIs:\s*mirror\+file:/etc/apt/apt-mirrors\.txt\s*$', sources, re.M):
        raise RuntimeError('Unsupported runner APT layout: expected deb822 mirror+file URI.')
    path = root / 'apt-mirrors.txt'
    mirrors = path.read_text()
    print('APT deb822 source: sources.list.d/ubuntu.sources; mirror list: apt-mirrors.txt', flush=True)
    lines = mirrors.splitlines(keepends=True)
    urls = [line.split()[0] for line in lines if line.strip() and not line.lstrip().startswith('#')]
    if AZURE in urls and not probe(AZURE):
        if ARCHIVE not in urls or not probe(ARCHIVE):
            raise RuntimeError('Azure unavailable; official Ubuntu archive unavailable. No mirror change.')
        # Only remove this exact Azure entry from the referenced mirror list.
        # Deb822 suites/components/Signed-By, security and other sources stay intact.
        write_root(path, ''.join(line for line in lines if not line.split() or line.split()[0] != AZURE))
        print('Azure unavailable; using the reachable official Ubuntu archive.', flush=True)
    write_root(root / 'apt.conf.d/zzz-placelens-browser', APT_LIMITS)


def install_browser():
    for attempt in range(1, 4):
        prepare_apt()
        print(f'Chromium and all system dependencies: attempt {attempt}/3 (240s limit)', flush=True)
        result = subprocess.run([
            'timeout', '--kill-after=10s', '240s',
            'npx', '--no-install', 'playwright', 'install', '--with-deps', 'chromium',
        ])
        if result.returncode == 0:
            return
        print(f'Browser setup failed with exit {result.returncode}.', flush=True)
        if attempt < 3:
            time.sleep(10)
    raise RuntimeError('Browser setup exhausted 3 attempts; mandatory smoke cannot run.')


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise RuntimeError('Browser APT setup is restricted to disposable GitHub-hosted runners.')
    release = Path('/etc/os-release').read_text()
    if not re.search(r'^ID=ubuntu$', release, re.M) or not re.search(r'^VERSION_ID="24\.04"$', release, re.M):
        raise RuntimeError('Unsupported runner OS: expected Ubuntu 24.04.')
    print('Browser setup: Ubuntu 24.04 GitHub-hosted runner', flush=True)
    install_browser()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f'Browser setup error: {error}', file=sys.stderr)
        sys.exit(1)
