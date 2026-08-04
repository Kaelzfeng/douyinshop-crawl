import frida from 'frida';
import fs from 'fs';

// Connect to Frida Gadget TCP port
const device = await frida.getDeviceManager().addRemoteDevice('127.0.0.1:27042');
console.log('Connected:', device.id);

// Try attaching by NAME instead of PID (gadget resolves this internally)
let session;
try {
  session = await device.attach('抖音商城');
  console.log('Attached by name!');
} catch (e) {
  console.log('Name attach failed:', e.message.slice(0,100));
  // Try spawn approach - the gadget might need to spawn a process
  try {
    const pid = await device.spawn(['com.ss.android.ugc.livelite']);
    console.log('Spawned PID:', pid);
    session = await device.attach(pid);
    await device.resume(pid);
  } catch (e2) {
    console.log('Spawn also failed:', e2.message.slice(0,100));
    process.exit(1);
  }
}

const bundle = fs.readFileSync('hook/native-signer-agent.bundle.js', 'utf8');
const script = await session.createScript(bundle);
script.message.connect(m => {
  if (m.type === 'send') console.log('[FRIDA]', m.payload.event || m.payload.type);
});
await script.load();
console.log('Script loaded!');

const status = await script.exports.status();
console.log('Signer:', JSON.stringify(status));

if (status.networkParamsLoaded) {
  const signed = await script.exports.sign('https://lf.snssdk.com/shorten/', {});
  console.log('Sign OK. Keys:', Object.keys(signed || {}));
  console.log('\n✅ FRIDA SIGNER WORKING!');
}

await script.unload();
await session.detach();
