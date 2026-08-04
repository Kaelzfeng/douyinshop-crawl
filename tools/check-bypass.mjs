#!/usr/bin/env node
import frida from 'frida';

const PACKAGE = 'com.ss.android.ugc.livelite';

async function main() {
  const devices = await frida.enumerateDevices();
  const device = devices.find(d => d.id === 'emulator-5554');
  if (!device) throw new Error('No device');

  const processes = await device.enumerateProcesses({ scope: 'full' });
  const proc = processes.find(p =>
    (p.parameters?.applications || []).includes(PACKAGE));
  if (!proc) throw new Error('App not running');

  console.log('Attaching to PID', proc.pid);
  const session = await device.attach(proc.pid);

  // Use compiled direct-search-agent bundle (has Java bridge)
  const fs = await import('node:fs');
  const bundle = fs.readFileSync('hook/direct-search-agent.bundle.js', 'utf8');
  const script = await session.createScript(bundle);
  await script.load();

  // Call the enumerate RPC that was added to the agent
  const result = await script.exports.enumerateVerifyClasses();
  console.log(`\n=== ${result.total} verification-related classes ===\n`);
  for (const [group, classes] of Object.entries(result.groups)) {
    if (classes.length === 0) continue;
    console.log(`--- ${group} (${classes.length}) ---`);
    for (const cls of classes) console.log(`  ${cls}`);
  }

  console.log('\nDone.');
  await script.unload();
  await session.detach();
}

main().catch(e => { console.error(e.message); process.exit(1); });
