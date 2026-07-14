import frida
import sys
import time
from pathlib import Path

# Read the bypass script
script_path = Path(__file__).parent / 'ssl-bypass.js'
script_src = script_path.read_text(encoding='utf-8')

# Connect to frida-server on MuMu
device = frida.get_device_manager().add_remote_device('127.0.0.1:27042')

# Find the Douyin process
processes = device.enumerate_processes()
targets = [p for p in processes if 'livelite' in p.name.lower() or '商城' in p.name]
if not targets:
    print('Douyin not running. Start it first.')
    sys.exit(1)

target = targets[0]
print(f'Attaching to {target.name} (PID: {target.pid})...')

session = device.attach(target.pid)
script = session.create_script(script_src)

script.on('message', lambda msg, data: print(f'[Frida] {msg}'))
script.load()

print('SSL bypass injected! Proxy traffic should flow.')
print('Keep this running. Ctrl+C to stop.')
print()

try:
    sys.stdin.read()
except KeyboardInterrupt:
    print('\nDone.')
