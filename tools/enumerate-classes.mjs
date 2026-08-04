#!/usr/bin/env node
/**
 * Enumerate all captcha/face/identity/risk verification classes.
 * Uses Node Frida API directly — no compilation needed.
 */
import frida from 'frida';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'output', 'direct-search', 'verify-classes.txt');
const PACKAGE = 'com.ss.android.ugc.livelite';

const SCRIPT = `
const KEYWORDS = [
  'turing', 'captcha', 'verify', 'face', 'identity',
  'liveness', 'risk', 'security', 'challenge', 'antibot',
  'realname', 'real_name', 'auth', 'check', 'guard',
  'fingerprint', 'devicecheck', 'safetynet',
  'bdturing', 'metasec',
];

Java.perform(() => {
  const found = [];
  Java.enumerateLoadedClasses({
    onMatch: (className) => {
      const lower = className.toLowerCase();
      for (const kw of KEYWORDS) {
        if (lower.includes(kw)) {
          found.push(className);
          break;
        }
      }
    },
    onComplete: () => {
      found.sort();
      send({ type: 'classes', count: found.length, classes: found });
      send({ type: 'done' });
    },
  });
});
`;

async function main() {
  const devices = await frida.enumerateDevices();
  const device = devices.find(d => d.id === 'emulator-5554' || d.type === 'usb');
  if (!device) throw new Error('No device');

  const processes = await device.enumerateProcesses({ scope: 'full' });
  const proc = processes.find(p =>
    (p.parameters?.applications || []).includes(PACKAGE)
  ) || processes.find(p => (p.name || '').includes('livelite'));
  if (!proc) throw new Error('App not running');

  console.log(`[enum] Attaching to ${proc.name} (PID ${proc.pid})...`);
  const session = await device.attach(proc.pid);
  const script = await session.createScript(SCRIPT);

  let allClasses = [];

  script.message.connect((message) => {
    if (message.type === 'send' && message.payload) {
      const p = message.payload;
      if (p.type === 'classes') {
        allClasses = p.classes;
        console.log(`[enum] Found ${p.count} classes`);
      } else if (p.type === 'done') {
        console.log('[enum] Done.\n');
      }
    }
  });

  await script.load();
  // Wait for enumeration to complete
  await new Promise(resolve => setTimeout(resolve, 15000));

  // Group by category
  const groups = {};
  for (const cls of allClasses) {
    const lower = cls.toLowerCase();
    let cat = 'other';
    if (lower.includes('turing') || lower.includes('captcha')) cat = 'captcha';
    else if (lower.includes('face') || lower.includes('liveness')) cat = 'face';
    else if (lower.includes('identity') || lower.includes('realname')) cat = 'identity';
    else if (lower.includes('risk') || lower.includes('security')) cat = 'risk';
    else if (lower.includes('verify') || lower.includes('check')) cat = 'verify';
    else if (lower.includes('fingerprint') || lower.includes('devicecheck')) cat = 'fingerprint';
    else if (lower.includes('auth')) cat = 'auth';
    (groups[cat] ||= []).push(cls);
  }

  const outLines = [];
  for (const [cat, classes] of Object.entries(groups).sort()) {
    outLines.push(`\n## ${cat} (${classes.length})`);
    for (const cls of classes.sort()) {
      outLines.push(`  ${cls}`);
    }
  }

  const output = [
    `# Verification Classes in ${PACKAGE}`,
    `Total: ${allClasses.length}`,
    ...outLines,
  ].join('\n');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, output, 'utf8');
  console.log(output);
  console.log(`\nSaved to ${OUT}`);

  await script.unload();
  await session.detach();
}

main().catch(e => { console.error(e); process.exit(1); });
