#!/usr/bin/env node
/**
 * Attach metasec-native-trace agent, optionally trigger a sign, dump JSON.
 *
 * Usage:
 *   npm run build:metasec-trace
 *   node tools/trace-metasec-native.mjs
 *   node tools/trace-metasec-native.mjs --sign --url "https://ecom.ecombdapi.com/x?aid=1"
 *   node tools/trace-metasec-native.mjs --wait-ms 15000
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import frida from 'frida';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'hook', 'metasec-native-trace.js');
const BUNDLE = path.join(ROOT, 'hook', 'metasec-native-trace.bundle.js');
const OUT_DIR = path.join(ROOT, 'output', 'direct-search');
const PACKAGE = 'com.ss.android.ugc.livelite';

function parseArgs(argv) {
  const opts = {
    serial: process.env.ANDROID_SERIAL || 'emulator-5554',
    fridaHost: process.env.FRIDA_HOST || '127.0.0.1:27042',
    waitMs: 3000,
    sign: false,
    url: 'https://ecom.ecombdapi.com/aweme/v3/shop/search/aggregate/shopping/stream/?aid=561124&device_platform=android',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--serial' && argv[i + 1]) opts.serial = argv[++i];
    else if (argv[i] === '--wait-ms' && argv[i + 1]) opts.waitMs = Number(argv[++i]) || 3000;
    else if (argv[i] === '--sign') opts.sign = true;
    else if (argv[i] === '--url' && argv[i + 1]) opts.url = argv[++i];
  }
  return opts;
}

function ensureBundle() {
  if (fs.existsSync(BUNDLE) && fs.statSync(BUNDLE).mtimeMs >= fs.statSync(SRC).mtimeMs) return;
  console.log('[trace] compiling agent…');
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['frida-compile', SRC, '-o', BUNDLE, '-B', 'iife', '-S'],
    { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' },
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  ensureBundle();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const devices = await frida.enumerateDevices();
  let device = devices.find((d) => d.id === opts.serial) || devices.find((d) => d.type === 'usb');
  if (!device) device = await frida.getDeviceManager().addRemoteDevice(opts.fridaHost);

  const processes = await device.enumerateProcesses({ scope: 'full' });
  const proc = processes.find((p) =>
    (p.parameters?.applications || []).includes(PACKAGE),
  ) || processes.find((p) => /livelite|抖音商城/.test(p.name || ''));
  if (!proc) throw new Error('Douyin Mall not running');

  console.log(`[trace] attach pid=${proc.pid}`);
  const session = await device.attach(proc.pid);
  const script = await session.createScript(fs.readFileSync(BUNDLE, 'utf8'));
  script.message.connect((msg) => {
    if (msg.type === 'send') {
      const p = msg.payload || {};
      if (p.event === 'f3.a') {
        console.log(`[f3.a] op=${p.op} handle=${p.handle} out=${(p.output_pairs || []).slice(0, 4).join('|')} native=${p.native_entry?.address || '-'}`);
      } else if (p.event === 'dlsym') {
        console.log(`[dlsym] ${p.symbol} -> ${p.address}`);
      } else if (p.event === 'RegisterNatives') {
        console.log(`[RegisterNatives] count=${p.count} via ${p.artSymbol}`);
        for (const m of (p.methods || []).slice(0, 8)) {
          console.log(`  ${m.name} ${m.sig} @ ${m.fnPtr}`);
        }
      } else if (p.event === 'dlopen') {
        console.log(`[dlopen] ${p.path}`);
      }
    } else if (msg.type === 'error') {
      console.error('[trace-error]', msg.stack || msg.description);
    }
  });
  await script.load();

  const installed = await script.exports.install();
  console.log('[trace] install', JSON.stringify(installed));

  if (opts.sign) {
    try {
      const probe = await script.exports.signProbe(opts.url, JSON.stringify({
        'User-Agent': 'com.ss.android.ugc.livelite/390600',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      }));
      console.log('[trace] signProbe headers', Object.keys(probe.headers || {}));
      if (probe.lastF3) console.log('[trace] lastF3 native', probe.lastF3.native_entry);
      if (probe.artMethod) console.log('[trace] artMethod', JSON.stringify(probe.artMethod));
    } catch (e) {
      console.error('[trace] signProbe failed:', e.message);
    }
  }

  if (opts.waitMs > 0) {
    console.log(`[trace] waiting ${opts.waitMs}ms for background events…`);
    await new Promise((r) => setTimeout(r, opts.waitMs));
  }

  const dump = await script.exports.dump();
  const outPath = path.join(OUT_DIR, `metasec-native-trace-${Date.now()}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(dump, null, 2)}\n`, 'utf8');
  console.log('[trace] saved', outPath);
  console.log('[trace] counts', dump.counts);

  await script.unload().catch(() => {});
  await session.detach().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
