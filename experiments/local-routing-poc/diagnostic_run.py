"""Only new disconnection probes; existing graphs and main responses retained."""
import json
import subprocess
import sys

from run import BASE, CODE, OSRM, OUT, VAL

capability = len(sys.argv) > 1 and sys.argv[1] == 'capability'
for engine, image in ([('valhalla', VAL)] if capability else [('osrm', OSRM), ('valhalla', VAL)]):
    for mode in ['walking', 'driving']:
        destination = OUT / (engine + '-' + mode + ('-capability.json' if capability else '-disconnection.json'))
        if destination.exists():
            raise RuntimeError('Refusing to replace existing diagnostic result: ' + str(destination))
        name = 'placelens-routing-diagnostic-' + engine + '-' + mode
        folder = OUT / (engine + '-' + mode if engine == 'osrm' else 'valhalla')
        args = BASE.copy()
        args.remove('--rm')
        server = ['osrm-routed', '-t', '1', '--algorithm', 'mld', '/work/pilot.osrm'] if engine == 'osrm' else ['valhalla_service', '/work/valhalla.json', '1']
        subprocess.run(args + ['-d', '--name', name, '-v', f'{folder}:/work:ro', image] + server, capture_output=True, check=True)
        try:
            # Wait for actual listening socket, with a bounded loop inside the helper.
            check = 'import socket,time\nfor i in range(80):\n try:\n  socket.create_connection(("127.0.0.1",' + ('5000' if engine == 'osrm' else '8002') + '),.2).close();break\n except OSError: time.sleep(.1)\nelse: raise RuntimeError("not ready")'
            subprocess.run(['docker', 'run', '--rm', '--network=container:' + name, '--memory=128m', 'python:3.12-slim', 'python', '-c', check], capture_output=True, check=True, timeout=20)
            raw = subprocess.check_output(['docker', 'run', '--rm', '--network=container:' + name, '--read-only', '--memory=128m', '--memory-swap=128m',
                                          '-v', f'{CODE}:/experiment:ro', 'python:3.12-slim', 'python', '/experiment/' + ('capability_probe.py' if capability else 'diagnostic_probe.py'), engine, mode], text=True, timeout=30)
            result = json.loads(raw)
            destination.open('x').write(json.dumps(result, indent=2) + '\n')
            print(engine, mode, {k: v.get('body', {}).get('code', v.get('body', {}).get('error', v['status'])) for k, v in result.items() if k != 'pairs'}, flush=True)
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True, check=True)
