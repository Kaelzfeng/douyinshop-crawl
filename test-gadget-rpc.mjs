/**
 * Test: Connect to Frida Gadget in listen mode, load native-signer-agent
 * WITHOUT device.attach(). If this works, we get sign() RPC without ptrace.
 */
import frida from 'frida';
import fs from 'fs';

// Connect to gadget TCP port
const device = await frida.getDeviceManager().addRemoteDevice('127.0.0.1:27042');
console.log('Device:', device.id, device.type);

// List processes that the gadget can see
const procs = await device.enumerateProcesses({ scope: 'full' });
const douyin = procs.find(x => x.name === '抖音商城');
console.log('Douyin:', douyin ? `PID=${douyin.pid}` : 'NOT FOUND');

// ── TRY 1: Attach by name ──
console.log('\n--- TRY 1: attach("抖音商城") ---');
try {
  const session = await device.attach('抖音商城');
  console.log('ATTACHED! Loading script...');
  const bundle = fs.readFileSync('hook/native-signer-agent.bundle.js', 'utf8');
  const script = await session.createScript(bundle);
  await script.load();
  const status = await script.exports.status();
  console.log('Status:', JSON.stringify(status));
  await script.unload();
  await session.detach();
  process.exit(0);
} catch (e) {
  console.log('Failed:', e.message.slice(0, 150));
}

// ── TRY 2: Spawn the app ──
console.log('\n--- TRY 2: spawn("com.ss.android.ugc.livelite") ---');
try {
  const pid = await device.spawn(['com.ss.android.ugc.livelite']);
  console.log('Spawned PID:', pid);
  const session = await device.attach(pid);
  console.log('ATTACHED! Loading script...');
  const bundle = fs.readFileSync('hook/native-signer-agent.bundle.js', 'utf8');
  const script = await session.createScript(bundle);
  script.message.connect(m => {
    if (m.type === 'send') console.log('[FRIDA]', m.payload.event || m.payload.type);
  });
  await script.load();
  await device.resume(pid);
  const status = await script.exports.status();
  console.log('Status:', JSON.stringify(status));
  await script.unload();
  await session.detach();
  process.exit(0);
} catch (e) {
  console.log('Failed:', e.message.slice(0, 150));
}

// ── TRY 3: Resume existing app then try attach ──
console.log('\n--- TRY 3: resume then attach ---');
try {
  // The gadget might allow attaching after app is in foreground
  const pid = douyin.pid;
  await device.resume(pid);
  await new Promise(r => setTimeout(r, 2000));
  const session = await device.attach(pid);
  console.log('ATTACHED!');
  await session.detach();
  process.exit(0);
} catch (e) {
  console.log('Failed:', e.message.slice(0, 150));
}

console.log('\n❌ ALL METHODS FAILED. Gadget listen mode cannot bypass ptrace.');
console.log('Need: rebuild APK with script-mode config.');
