import frida from 'frida';
import fs from 'fs';

const appPid = process.argv[2] || (await (await import('node:child_process')).execSync(
  'adb -s emulator-5554 shell pidof com.ss.android.ugc.livelite'
).toString().trim());

console.log('App PID:', appPid);

const device = await frida.getDeviceManager().addRemoteDevice('127.0.0.1:27042');
const session = await device.attach(Number(appPid));
const bundle = fs.readFileSync('hook/capture-semi.bundle.js', 'utf8');
const script = await session.createScript(bundle);

let count = 0;
script.message.connect(m => {
  if (m.type === 'send') {
    count++;
    const p = m.payload;
    if (['ready', 'hooked', 'agent-loaded'].includes(p.type)) {
      console.log(p.type + ':', p.target || '');
    } else {
      console.log('EVENT[' + count + ']:', p.type, JSON.stringify(p).slice(0, 200));
    }
  }
});

await script.load();
console.log('Script loaded. Move around in the app to trigger events...');
console.log('Waiting 20 seconds...');
await new Promise(r => setTimeout(r, 20000));
console.log('Total events captured:', count);
await script.unload();
await session.detach();
