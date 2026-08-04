#!/usr/bin/env node
/**
 * Deep enumerate: list ALL loaded classes, search classloaders for unloaded ones.
 * Then filter for verification-related classes in Node.js.
 */
import frida from 'frida';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'output', 'direct-search', 'all-classes.txt');
const FILTERED = path.join(ROOT, 'output', 'direct-search', 'verify-classes.txt');
const PACKAGE = 'com.ss.android.ugc.livelite';

const KEYWORDS = [
  'turing', 'captcha', 'verify', 'face', 'identity',
  'liveness', 'risk', 'security', 'challenge', 'antibot',
  'realname', 'real_name', 'auth', 'check', 'guard',
  'fingerprint', 'devicecheck', 'safetynet',
  'bdturing', 'metasec', 'antifraud', 'spam', 'abuse',
  'account', 'login', 'credential', 'biometric',
];

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

  // Strategy 1: Enumerate loaded classes
  const script1 = await session.createScript(`
    Java.perform(() => {
      const all = [];
      Java.enumerateLoadedClasses({
        onMatch: (c) => all.push(c),
        onComplete: () => {
          send({ phase: 'loaded', count: all.length, classes: all });
        },
      });
    });
  `);

  const loadedClasses = [];
  script1.message.connect(msg => {
    if (msg.type === 'send' && msg.payload?.phase === 'loaded') {
      loadedClasses.push(...msg.payload.classes);
    }
  });

  await script1.load();
  await new Promise(r => setTimeout(r, 20000));
  await script1.unload();

  console.log(`[enum] Loaded classes: ${loadedClasses.length}`);

  // Strategy 2: Try classloader enumeration for specific packages
  const script2 = await session.createScript(`
    Java.perform(() => {
      const allLoaders = Java.enumerateClassLoadersSync();
      send({ phase: 'loaders', count: allLoaders.length });

      // Try to find classes from key packages via each classloader
      const prefixes = [
        'com.bytedance.android.turingverify',
        'com.bytedance.turingverify',
        'com.bytedance.android.identity',
        'com.ss.android.ugc.aweme.turing',
        'com.ss.android.ugc.aweme.identity',
        'com.ss.android.ugc.aweme.risk',
        'com.bytedance.frameworks.baselib.network.http.risk',
      ];

      const found = [];
      for (const prefix of prefixes) {
        for (const loader of allLoaders) {
          try {
            const classes = loader.listAllClasses();
            for (const cls of classes) {
              const name = cls.getName();
              if (name.startsWith(prefix)) {
                found.push(name);
              }
            }
          } catch (_) {}
        }
      }
      send({ phase: 'prefix', count: found.length, classes: found });

      send({ phase: 'done' });
    });
  `);

  const prefixClasses = [];
  script2.message.connect(msg => {
    if (msg.type === 'send' && msg.payload) {
      console.log(`[enum] ${msg.payload.phase}: ${msg.payload.count || 0}`);
      if (msg.payload.classes) prefixClasses.push(...msg.payload.classes);
    }
  });

  await script2.load();
  await new Promise(r => setTimeout(r, 15000));
  await script2.unload();

  // Filter for verification-related
  const allFound = [...new Set([...loadedClasses, ...prefixClasses])];
  const matched = allFound.filter(cls => {
    const lower = cls.toLowerCase();
    return KEYWORDS.some(kw => lower.includes(kw));
  });

  // Group
  const groups = {};
  for (const cls of matched.sort()) {
    const lower = cls.toLowerCase();
    let cat = 'other';
    if (lower.includes('turing') || lower.includes('captcha')) cat = '1_captcha_turing';
    else if (lower.includes('face') || lower.includes('liveness') || lower.includes('biometric')) cat = '2_face_liveness';
    else if (lower.includes('identity') || lower.includes('realname')) cat = '3_identity';
    else if (lower.includes('risk') || lower.includes('security') || lower.includes('spam') || lower.includes('abuse')) cat = '4_risk_security';
    else if (lower.includes('verify') || lower.includes('check')) cat = '5_verify_check';
    else if (lower.includes('auth') || lower.includes('login') || lower.includes('credential')) cat = '6_auth_login';
    else if (lower.includes('fingerprint') || lower.includes('devicecheck')) cat = '7_fingerprint';
    else cat = '8_other';
    (groups[cat] ||= []).push(cls);
  }

  const lines = [
    `# Verification Classes in ${PACKAGE}`,
    `Total loaded: ${loadedClasses.length}`,
    `Prefix-found: ${prefixClasses.length}`,
    `Matched: ${matched.length}`,
    '',
  ];
  for (const [cat, classes] of Object.entries(groups).sort()) {
    lines.push(`## ${cat} (${classes.length})`);
    for (const cls of classes) lines.push(`  ${cls}`);
  }

  const output = lines.join('\n');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(FILTERED, output, 'utf8');
  fs.writeFileSync(OUT, [...new Set(allFound)].sort().join('\n'), 'utf8');

  console.log(output);
  console.log(`\nAll classes: ${OUT}`);
  console.log(`Filtered: ${FILTERED}`);

  await session.detach();
}

main().catch(e => { console.error(e); process.exit(1); });
