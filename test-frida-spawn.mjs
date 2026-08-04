import frida from 'frida';
import { _android } from 'playwright';
import fs from 'node:fs';

const PACKAGE = 'com.ss.android.ugc.livelite';

// Kill app first
const adbDevices = await _android.devices({ host: '127.0.0.1', port: 5037 });
const adb = adbDevices.find(d => d.serial() === 'emulator-5554');
await adb.shell('am force-stop ' + PACKAGE).catch(() => {});
await new Promise(r => setTimeout(r, 1500));

const manager = frida.getDeviceManager();
const devices = await manager.enumerateDevices();
const device = devices.find(d => d.id === 'emulator-5554');

try {
  console.log('Frida spawn...');
  const pid = await device.spawn([PACKAGE]);
  console.log('Spawned PID:', pid);
  const session = await device.attach(pid);
  console.log('Attached!');

  const bundle = fs.readFileSync('hook/capture-share-api.bundle.js', 'utf8');
  const script = await session.createScript(bundle);

  script.message.connect(msg => {
    if (msg.type === 'send') {
      const p = msg.payload;
      if (['ready','hooked'].includes(p.type)) console.log('[' + p.type + '] ' + (p.target || ''));
      else if (p.type === 'clipboard') console.log('[CLIPBOARD] ' + (p.text||'').slice(0,120));
      else if (p.type === 'uri-parse') console.log('[URI] ' + (p.uri||'').slice(0,200));
    } else if (msg.type === 'error') console.log('[ERR] ' + (msg.description||'').slice(0,300));
  });

  await script.load();
  console.log('Script loaded!');
  await device.resume(pid);
  console.log('App resumed. Waiting 20s for events...');
  await new Promise(r => setTimeout(r, 20000));
  console.log('Test complete.');

  await script.unload().catch(() => {});
  await session.detach().catch(() => {});
} catch(e) {
  console.log('ERROR:', e.message?.slice(0,300));
}

await Promise.allSettled(adbDevices.map(d => d.close()));
