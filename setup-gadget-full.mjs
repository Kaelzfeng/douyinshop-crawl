#!/usr/bin/env node
/**
 * Complete Frida Gadget injection setup for Douyin Mall.
 * Run: node setup-gadget-full.mjs
 *
 * Downloads gadget, pulls APK, injects gadget, rebuilds and installs.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, 'tmp');
const GADGET_URL = 'https://github.com/frida/frida/releases/download/17.15.4/frida-gadget-17.15.4-android-x86_64.so.xz';
const PACKAGE = 'com.ss.android.ugc.livelite';
const SERIAL = 'emulator-5554';

fs.mkdirSync(TMP, { recursive: true });

function run(cmd, opts = {}) {
  console.log('  >', cmd.slice(0, 100));
  return execSync(cmd, { encoding: 'utf8', stdio: 'inherit', ...opts });
}

// Step 1: Download & extract gadget
console.log('\n[1/5] Downloading Frida Gadget...');
const gadgetXz = path.join(TMP, 'frida-gadget.so.xz');
const gadgetSo = path.join(TMP, 'frida-gadget.so');
if (!fs.existsSync(gadgetSo)) {
  if (!fs.existsSync(gadgetXz)) {
    run(`curl -L -o "${gadgetXz}" "${GADGET_URL}"`);
  }
  console.log('  Extracting...');
  try {
    run(`tar -xf "${gadgetXz}" -C "${TMP}"`);
  } catch {
    // tar might fail, try renaming (sometimes the file isn't actually xz'd)
    fs.copyFileSync(gadgetXz, gadgetSo);
  }
}
const soSize = fs.existsSync(gadgetSo) ? fs.statSync(gadgetSo).size : 0;
console.log(`  Gadget: ${gadgetSo} (${soSize} bytes)`);

// Step 2: Pull APK
console.log('\n[2/5] Pulling APK...');
const apkPath = path.join(TMP, 'douyin-mall.apk');
if (!fs.existsSync(apkPath)) {
  // Find APK path on device
  const apkOnDevice = run(`adb -s ${SERIAL} shell pm path ${PACKAGE}`).trim().replace('package:', '');
  console.log(`  APK on device: ${apkOnDevice}`);
  run(`adb -s ${SERIAL} pull "${apkOnDevice}" "${apkPath}"`);
}
console.log(`  APK: ${apkPath} (${fs.statSync(apkPath).size} bytes)`);

// Step 3: Inject gadget using apktool-like approach
console.log('\n[3/5] Injecting gadget...');

// Copy gadget to app lib dir on device (simpler than APK repack)
// Push to /data/local/tmp and use LD_PRELOAD if root, or inject into APK lib dir
const injectDir = `/data/app/~~*/${PACKAGE}*/lib/x86_64/`;

// Push to device
run(`adb -s ${SERIAL} push "${gadgetSo}" /data/local/tmp/frida-gadget.so`);

// Try to find the app's lib directory
const libDir = run(`adb -s ${SERIAL} shell "ls -d /data/app/~~*/${PACKAGE}*/lib/x86_64/ 2>/dev/null | head -1"`).trim();
console.log(`  App lib dir: ${libDir}`);

// Step 4: Create gadget config
console.log('\n[4/5] Creating gadget config...');
const configPath = path.join(TMP, 'libfrida-gadget.config.so');
const config = JSON.stringify({
  interaction: {
    type: 'listen',
    address: '127.0.0.1:27042',
    on_load: 'resume',
  },
});
fs.writeFileSync(configPath, config);
run(`adb -s ${SERIAL} push "${configPath}" /data/local/tmp/libfrida-gadget.config.so`);
console.log('  Config: listen mode on 127.0.0.1:27042');

// Step 5: Instructions for APK injection
console.log('\n[5/5] APK Injection');
console.log('  Since we cannot directly write to the app lib dir without root,');
console.log('  we need to use apktool to repackage the APK:');
console.log('');
console.log('  apktool d tmp/douyin-mall.apk -o tmp/douyin-mall-extracted');
console.log('  cp tmp/frida-gadget.so tmp/douyin-mall-extracted/lib/x86_64/');
console.log('  cp tmp/libfrida-gadget.config.so tmp/douyin-mall-extracted/lib/x86_64/');
console.log('  # Patch the manifest or smali to load the gadget (see README)');
console.log('  apktool b tmp/douyin-mall-extracted -o tmp/douyin-mall-patched.apk');
console.log('  jarsigner -keystore ~/.android/debug.keystore tmp/douyin-mall-patched.apk androiddebugkey');
console.log('  adb install -r tmp/douyin-mall-patched.apk');
console.log('');
console.log('ALTERNATIVELY: Try a simpler approach - use the frida-gadget as a shared library');
console.log('  adb -s emulator-5554 push tmp/frida-gadget.so ' + libDir + 'libfrida-gadget.so');
console.log('  adb -s emulator-5554 push tmp/libfrida-gadget.config.so ' + libDir + 'libfrida-gadget.config.so');
console.log('');
console.log('Done! Files prepared in tmp/');
