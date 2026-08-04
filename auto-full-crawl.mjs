#!/usr/bin/env node
/**
 * FULL AUTO: Sign APK → Install → Wait for login → Connect Frida → Full crawl
 * Run: node auto-full-crawl.mjs
 *
 * This script runs everything autonomously:
 * 1. Signs the patched APK
 * 2. Installs on emulator
 * 3. Waits for you to login
 * 4. Connects Frida to the gadget
 * 5. Loads native-signer-agent
 * 6. Starts full crawl for ggdb + 小脏鞋
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERIAL = 'emulator-5554';
const PACKAGE = 'com.ss.android.ugc.livelite';

function $(cmd, opts = {}) {
  console.log('  >', cmd.slice(0, 120));
  return execSync(cmd, { encoding: 'utf8', stdio: 'inherit', ...opts });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════
// STEP 1: Sign APK
// ═══════════════════════════════════════════
console.log('\n═══ [1/6] Signing APK ═══');
const apkPath = path.join(__dirname, 'tmp', 'douyin-mall-patched.apk');
const signerJar = path.join(__dirname, 'tmp', 'uber-apk-signer.jar');

if (!fs.existsSync(apkPath)) {
  console.error('ERROR: Patched APK not found:', apkPath);
  process.exit(1);
}

try {
  $(`java -jar "${signerJar}" --apks "${apkPath}" --allowResign`);
} catch (e) {
  console.log('uber-apk-signer failed, trying apksigner...');
  // Try with Android SDK apksigner
  try {
    $('apksigner sign --ks tmp/debug.keystore --ks-pass pass:android "' + apkPath + '"');
  } catch {
    console.log('apksigner also failed. Trying to find it...');
    // Search for apksigner in common locations
    const builds = glob.sync('**/build-tools/**/apksigner*', { cwd: process.env.LOCALAPPDATA + '/Android/Sdk' });
    console.log('Found apksigners:', builds);
  }
}
console.log('Signing complete');

// ═══════════════════════════════════════════
// STEP 2: Install
// ═══════════════════════════════════════════
console.log('\n═══ [2/6] Installing APK ═══');
try {
  $(`adb -s ${SERIAL} uninstall ${PACKAGE}`);
} catch { /* may not be installed */ }
$(`adb -s ${SERIAL} install "${apkPath}"`);
// Forward Frida gadget port
$(`adb -s ${SERIAL} forward tcp:27042 tcp:27042`);
console.log('APK installed, port forwarded');

// ═══════════════════════════════════════════
// STEP 3: Launch app
// ═══════════════════════════════════════════
console.log('\n═══ [3/6] Launching app ═══');
$(`adb -s ${SERIAL} shell am start -n ${PACKAGE}/com.ss.android.ugc.aweme.main.MainActivity`);
console.log('\n*** PLEASE LOGIN TO DOUYIN NOW ***');
console.log('Waiting 60 seconds for login...');
await sleep(60000);

// Check if app is running
const pid = $(`adb -s ${SERIAL} shell pidof ${PACKAGE}`).trim();
console.log('App PID:', pid || 'NOT RUNNING');

// ═══════════════════════════════════════════
// STEP 4: Connect Frida
// ═══════════════════════════════════════════
console.log('\n═══ [4/6] Connecting Frida ═══');
try {
  const { default: frida } = await import('frida');
  const manager = frida.getDeviceManager();
  const devices = await manager.enumerateDevices();
  const device = devices.find(d => d.type === 'usb');
  if (!device) {
    console.error('No USB Frida device found. Trying remote...');
    device = await manager.addRemoteDevice('127.0.0.1:27042');
  }
  const processes = await device.enumerateProcesses({ scope: 'full' });
  const proc = processes.find(p => (p.name || '').includes('livelite') || (p.name || '') === '抖音商城');

  if (!proc) {
    console.error('Douyin Mall process not found via Frida.');
    console.log('Gadget may not have loaded. Check if the app starts correctly.');
    process.exit(1);
  }

  console.log('Frida connected! PID:', proc.pid, 'Name:', proc.name);

  // ═══════════════════════════════════════════
  // STEP 5: Load signer agent
  // ═══════════════════════════════════════════
  console.log('\n═══ [5/6] Loading native-signer-agent ═══');
  const session = await device.attach(proc.pid);
  const bundle = fs.readFileSync(path.join(__dirname, 'hook', 'native-signer-agent.bundle.js'), 'utf8');
  const script = await session.createScript(bundle);
  await script.load();

  // Test signing
  const signResult = await script.exports.sign('https://lf.snssdk.com/shorten/', {});
  console.log('Sign test:', JSON.stringify(signResult, null, 2).slice(0, 500));

  console.log('Frida signer ready!');

  // ═══════════════════════════════════════════
  // STEP 6: Full Crawl
  // ═══════════════════════════════════════════
  console.log('\n═══ [6/6] Starting Full Crawl ═══');
  console.log('Keywords: ggdb, 小脏鞋');

  // Set env and spawn the crawler
  const env = { ...process.env, MUMU_SERIAL: SERIAL, FRIDA_SIGNER_READY: '1' };
  const crawler = spawn('node', [
    'src/cli.mjs',
    '--serial', SERIAL,
    '--all', '--fresh',
    '--output', 'output/full-frida-auto.csv',
  ], { stdio: 'inherit', env });

  crawler.on('exit', (code) => {
    console.log('Crawl finished with code:', code);
    script.unload().catch(() => {});
    session.detach().catch(() => {});
    process.exit(code);
  });

} catch (e) {
  console.error('Frida connection failed:', e.message);
  console.log('Retry with: node test-frida-gadget.mjs');
  process.exit(1);
}
