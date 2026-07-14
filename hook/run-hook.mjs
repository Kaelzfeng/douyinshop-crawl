/**
 * Run Frida hook against Douyin Mall on MuMu.
 *
 * Prerequisites:
 *   frida-server running on MuMu
 *
 * Usage:
 *   node hook/run-hook.mjs
 */

import frida from 'frida';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, 'shop-api.js');
const script = readFileSync(scriptPath, 'utf8');

async function main() {
  console.log('[Hook] Enumerating Frida devices...');

  // List all available devices
  const deviceManager = frida.getDeviceManager();
  const allDevices = await deviceManager.enumerateDevices();
  console.log('[Hook] Available devices:');
  for (const d of allDevices) {
    console.log('  -', d.id, '(' + d.type + ',', d.name + ')');
  }

  // Look for a USB device first (Android via ADB), then remote
  let device = allDevices.find(d => d.type === 'usb');
  if (!device) {
    console.log('[Hook] No USB device found, trying remote...');
    try {
      device = await deviceManager.addRemoteDevice('127.0.0.1:27042');
      console.log('[Hook] Connected via remote:', device.name);
    } catch (e) {
      console.error('[Hook] Remote connection failed:', e.message);
      process.exit(1);
    }
  } else {
    console.log('[Hook] Using USB device:', device.name);
  }

  // Find the Douyin Mall app
  const processes = await device.enumerateProcesses();
  const douyinProc = processes.find(p =>
    p.name.toLowerCase().includes('livelite') ||
    (p.name.includes('抖音') && p.name.includes('商城'))
  );

  const pid = douyinProc ? douyinProc.pid : null;
  if (pid) {
    console.log('[Hook] Attaching to running process PID:', pid);
  } else {
    console.log('[Hook] App not running, spawning fresh...');
  }

  // Spawn fresh if not running, otherwise attach
  let sessionPid;
  if (douyinProc) {
    console.log('[Hook] Attaching to running PID:', douyinProc.pid);
    sessionPid = douyinProc.pid;
  } else {
    console.log('[Hook] Spawning fresh...');
    sessionPid = await device.spawn(['com.ss.android.ugc.livelite']);
    console.log('[Hook] Spawned PID:', sessionPid);
  }

  const session = await device.attach(sessionPid);

  session.detached.connect(() => {
    console.log('[Hook] Session detached. Exiting.');
    process.exit(1);
  });

  const scriptObj = await session.createScript(script);
  scriptObj.message.connect((message) => {
    if (message.type === 'send') {
      console.log(message.payload);
    } else if (message.type === 'error') {
      console.error('[Error]', message.stack || message.description);
    }
  });

  await scriptObj.load();
  if (!douyinProc) {
    await device.resume(sessionPid);
    console.log('[Hook] App resumed.');
  }
  console.log('[Hook] Script injected. Go use Douyin Mall now!\n');
  process.stdin.resume();
}

main().catch(e => {
  console.error('[Hook] Fatal:', e.message);
  process.exit(1);
});
