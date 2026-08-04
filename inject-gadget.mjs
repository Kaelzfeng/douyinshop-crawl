#!/usr/bin/env node
/**
 * ONE-CLICK: Frida Gadget injection for Douyin Mall APK
 * Run: node inject-gadget.mjs
 *
 * This script:
 * 1. Extracts frida-gadget.so from xz
 * 2. Decompiles APK with apktool
 * 3. Injects gadget + config into the APK
 * 4. Rebuilds and signs the APK
 * 5. Installs on emulator
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, 'tmp');
const TOOLS = path.join(__dirname, 'tools', 'apktool');
const GADGET_URL = 'https://github.com/frida/frida/releases/download/17.15.4/frida-gadget-17.15.4-android-x86_64.so.xz';
const APKTOOL_URL = 'https://github.com/iBotPeaches/Apktool/releases/download/v3.0.0/apktool_3.0.0.jar';
const SERIAL = 'emulator-5554';
const PACKAGE = 'com.ss.android.ugc.livelite';

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(TOOLS, { recursive: true });

function $(cmd, opts = {}) {
  console.log('  >', cmd.slice(0, 120));
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'inherit', ...opts });
  } catch (e) {
    console.error('  FAILED:', e.message.slice(0, 200));
    throw e;
  }
}

// ── Step 1: Download & extract frida-gadget ──
console.log('\n═══ [1/6] Frida Gadget ═══');
const gadgetXz = path.join(TMP, 'frida-gadget.so.xz');
const gadgetSo = path.join(TMP, 'frida-gadget.so');

if (!fs.existsSync(gadgetSo)) {
  if (!fs.existsSync(gadgetXz)) {
    console.log('Downloading frida-gadget...');
    $(`curl -L -o "${gadgetXz}" "${GADGET_URL}"`);
  }
  console.log('Extracting...');
  try {
    $(`tar -xf "${gadgetXz}" -C "${TMP}"`);
  } catch {
    // Try xz from Git Bash
    try {
      $('"C:\\Program Files\\Git\\usr\\bin\\xz.exe" -d -f "' + gadgetXz + '"');
    } catch {
      // Maybe it's not compressed
      fs.copyFileSync(gadgetXz, gadgetSo);
    }
  }
}
console.log('Gadget:', fs.statSync(gadgetSo).size, 'bytes');

// ── Step 2: Download apktool ──
console.log('\n═══ [2/6] Apktool ═══');
const apktoolJar = path.join(TOOLS, 'apktool.jar');
if (!fs.existsSync(apktoolJar)) {
  console.log('Downloading apktool...');
  $(`curl -L -o "${apktoolJar}" "${APKTOOL_URL}"`);
}
console.log('Apktool:', fs.statSync(apktoolJar).size, 'bytes');

// ── Step 3: Pull APK ──
console.log('\n═══ [3/6] Pull APK ═══');
const apkPath = path.join(TMP, 'douyin-mall.apk');
if (!fs.existsSync(apkPath)) {
  const apkOnDevice = $(`adb -s ${SERIAL} shell pm path ${PACKAGE}`).trim().replace('package:', '');
  console.log('APK path on device:', apkOnDevice);
  $(`adb -s ${SERIAL} pull "${apkOnDevice}" "${apkPath}"`);
}
console.log('APK:', (fs.statSync(apkPath).size / 1024 / 1024).toFixed(1), 'MB');

// ── Step 4: Decompile APK ──
console.log('\n═══ [4/6] Decompile APK ═══');
const apkDir = path.join(TMP, 'douyin-mall-extracted');
if (!fs.existsSync(apkDir)) {
  console.log('Decompiling... (this will take 5-10 minutes for a 163MB APK)');
  $(`java -jar "${apktoolJar}" d -f "${apkPath}" -o "${apkDir}"`, { timeout: 600000 });
}
console.log('APK extracted to:', apkDir);

// ── Step 5: Inject gadget ──
console.log('\n═══ [5/6] Inject Gadget ═══');

// Find the x86_64 lib directory
const libDir = path.join(apkDir, 'lib', 'x86_64');
if (!fs.existsSync(libDir)) {
  // Maybe it's in lib/x86 or just lib/
  const altDirs = [path.join(apkDir, 'lib', 'x86'), path.join(apkDir, 'lib')];
  for (const d of altDirs) {
    if (fs.existsSync(d)) {
      console.log('Using lib dir:', d);
      break;
    }
  }
}
console.log('Lib dir:', fs.existsSync(libDir) ? libDir : 'NOT FOUND (check APK structure)');

// Copy gadget
if (fs.existsSync(libDir)) {
  fs.copyFileSync(gadgetSo, path.join(libDir, 'libfrida-gadget.so'));
  console.log('Copied libfrida-gadget.so');

  // Write config for listen mode
  const config = JSON.stringify({
    interaction: {
      type: 'listen',
      address: '127.0.0.1:27042',
      on_load: 'resume',
    },
  });
  fs.writeFileSync(path.join(libDir, 'libfrida-gadget.config.so'), config);
  console.log('Created libfrida-gadget.config.so (listen mode)');
}

// Find and patch an early-loading native library to load our gadget
// Common targets: libc++_shared.so, libijkffmpeg.so, or any .so in the lib dir
const soFiles = fs.readdirSync(libDir).filter(f => f.endsWith('.so') && f !== 'libfrida-gadget.so');
console.log(`Found ${soFiles.length} native libraries`);

// Pick a target: prefer JNI libraries that load early
const jniLibs = soFiles.filter(f => /native|jni|main|app|aweme|livelite/i.test(f));
const targetLib = jniLibs[0] || soFiles.find(f => f.includes('c++')) || soFiles[0];
console.log('Target library for ELF patching:', targetLib);

if (targetLib) {
  const targetPath = path.join(libDir, targetLib);
  // Use patchelf to add DT_NEEDED dependency
  try {
    $(`patchelf --add-needed libfrida-gadget.so "${targetPath}"`);
    console.log('ELF patched: added DT_NEEDED libfrida-gadget.so');
  } catch (e) {
    console.log('patchelf not available or failed. Alternative: modify smali entry point.');
    console.log('Manual step needed: add System.loadLibrary("frida-gadget") to app startup.');
  }
}

// ── Step 6: Rebuild & Install ──
console.log('\n═══ [6/6] Rebuild & Install ═══');
const patchedApk = path.join(TMP, 'douyin-mall-patched.apk');

console.log('Rebuilding APK... (this will take 5-10 minutes)');
try {
  $(`java -jar "${apktoolJar}" b "${apkDir}" -o "${patchedApk}"`, { timeout: 600000 });
} catch {
  console.log('apktool build failed. This is common with obfuscated APKs.');
  console.log('Trying with --use-aapt2...');
  $(`java -jar "${apktoolJar}" b --use-aapt2 "${apkDir}" -o "${patchedApk}"`, { timeout: 600000 });
}
console.log('Patched APK:', (fs.statSync(patchedApk).size / 1024 / 1024).toFixed(1), 'MB');

// Sign the APK
console.log('Signing APK...');
const keystore = path.join(TMP, 'debug.keystore');
if (!fs.existsSync(keystore)) {
  $('keytool -genkey -v -keystore "' + keystore + '" -alias debug -keyalg RSA -keysize 2048 -validity 10000 -storepass android -keypass android -dname "CN=Debug"');
}
$(`jarsigner -verbose -sigalg SHA1withRSA -digestalg SHA1 -keystore "${keystore}" -storepass android "${patchedApk}" debug`);

// Install
console.log('\nInstalling patched APK...');
console.log('WARNING: This will REPLACE the existing Douyin Mall app.');
console.log('Your account data may be lost. Make sure you can re-login.');
console.log('\nPress Ctrl+C to abort, or wait 5 seconds to continue...');
await new Promise(r => setTimeout(r, 5000));

// Uninstall original then install patched
$(`adb -s ${SERIAL} uninstall ${PACKAGE}`);
$(`adb -s ${SERIAL} install "${patchedApk}"`);

console.log('\n═══ DONE ═══');
console.log('Douyin Mall with Frida Gadget installed!');
console.log('The gadget listens on 127.0.0.1:27042');
console.log('');
console.log('Test with:');
console.log('  frida-ps -U');
console.log('  node -e "import frida from \'frida\'; ..."');
