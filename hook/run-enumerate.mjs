#!/usr/bin/env node
/**
 * Run the verify-class enumeration against the live app.
 */
import frida from 'frida';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'enumerate-verify-classes.js');
const PACKAGE = 'com.ss.android.ugc.livelite';

async function main() {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const devices = await frida.enumerateDevices();
  const device = devices.find(d => d.id === 'emulator-5554' || d.type === 'usb');
  if (!device) throw new Error('No device');

  const processes = await device.enumerateProcesses({ scope: 'full' });
  const proc = processes.find(p =>
    (p.parameters?.applications || []).includes(PACKAGE)
  ) || processes.find(p => (p.name || '').includes('livelite'));
  if (!proc) throw new Error('App not running');

  console.log(`Attaching to ${proc.name} (PID ${proc.pid})...`);
  const session = await device.attach(proc.pid);
  const script = await session.createScript(source);

  const output = [];
  script.message.connect((message) => {
    if (message.type === 'send') {
      output.push(message.payload);
    }
    console.log('[Frida]', message.type, message.payload || '');
  });

  await script.load();
  console.log('Script loaded. Waiting for enumeration...');

  // Wait for completion
  await new Promise(resolve => setTimeout(resolve, 30000));

  // Save results
  const outPath = path.join(__dirname, '..', 'output', 'direct-search', 'verify-classes.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Saved to ${outPath}`);

  await script.unload();
  await session.detach();
}

main().catch(e => { console.error(e); process.exit(1); });
