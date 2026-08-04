#!/usr/bin/env node
/**
 * Inject the bypass agent into the running Douyin Mall app.
 * The agent hooks captcha/face/risk and stays resident until Ctrl+C.
 *
 * Usage:
 *   npm run build:bypass && node hook/run-bypass.mjs
 */
import frida from 'frida';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(__dirname, 'bypass-agent.bundle.js');
const PACKAGE = 'com.ss.android.ugc.livelite';

async function main() {
  if (!fs.existsSync(BUNDLE)) {
    console.error('Bundle not found. Run: npm run build:bypass');
    process.exit(1);
  }

  const source = fs.readFileSync(BUNDLE, 'utf8');
  const devices = await frida.enumerateDevices();
  const device = devices.find(d => d.id === 'emulator-5554' || d.type === 'usb');
  if (!device) throw new Error('No device found. Is emulator running?');

  const processes = await device.enumerateProcesses({ scope: 'full' });
  const proc = processes.find(p =>
    (p.parameters?.applications || []).includes(PACKAGE),
  );
  if (!proc) throw new Error(`${PACKAGE} not running. Start Douyin Mall first.`);

  console.log(`[bypass] Attaching to ${proc.name} (PID ${proc.pid})...`);
  const session = await device.attach(proc.pid);
  const script = await session.createScript(source);

  script.message.connect((message) => {
    if (message.type === 'send' && message.payload) {
      const p = message.payload;
      const ts = new Date(p.ts).toISOString().split('T')[1].slice(0, 12);
      console.log(`[${ts}] ${p.event}:`, JSON.stringify(
        Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'ts' && k !== 'event')),
      ));
    } else if (message.type === 'error') {
      console.error('[bypass] Script error:', message.description || message.stack);
    }
  });

  await script.load();
  console.log('[bypass] Agent loaded. Hooks active. Press Ctrl+C to stop.\n');

  // Print status every 30 seconds
  const statusInterval = setInterval(async () => {
    try {
      const status = await script.exports.status();
      const report = await script.exports.bypassReport();
      console.log(`[bypass] Status: turing=${report.turingBypassed} face=${report.faceBypassed} identity=${report.identityBypassed} risk=${report.riskLowered} uptime=${Math.round(report.uptime / 1000)}s`);
    } catch (e) {
      console.error('[bypass] Status check failed:', e.message);
    }
  }, 30000);

  // Keep alive until Ctrl+C
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  clearInterval(statusInterval);
  const finalReport = await script.exports.bypassReport();
  console.log('\n[bypass] Final report:', JSON.stringify(finalReport, null, 2));

  await script.unload();
  await session.detach();
  console.log('[bypass] Detached.');
}

main().catch(e => { console.error(e); process.exit(1); });
