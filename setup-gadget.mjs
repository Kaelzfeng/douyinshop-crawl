import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TMP = 'tmp';
fs.mkdirSync(TMP, { recursive: true });

// Step 1: Download frida-gadget
const GADGET_URL = 'https://github.com/frida/frida/releases/download/17.15.4/frida-gadget-17.15.4-android-x86_64.so.xz';
const GADGET_XZ = path.join(TMP, 'frida-gadget.so.xz');
const GADGET_SO = path.join(TMP, 'frida-gadget.so');

if (!fs.existsSync(GADGET_SO)) {
  console.log('Downloading frida-gadget...');
  execSync(`curl -L -o "${GADGET_XZ}" "${GADGET_URL}"`, { stdio: 'inherit' });
  console.log('Extracting...');
  execSync(`xz -d -f "${GADGET_XZ}"`, { stdio: 'inherit' });
  execSync(`mv "${GADGET_XZ.replace('.xz','')}" "${GADGET_SO}"`, { stdio: 'inherit' });
  console.log('Gadget ready:', GADGET_SO);
} else {
  console.log('Gadget already downloaded');
}

// Step 2: Pull APK
const APK_PATH = path.join(TMP, 'douyin-mall.apk');
if (!fs.existsSync(APK_PATH)) {
  console.log('Pulling APK from emulator...');
  execSync('adb -s emulator-5554 pull /data/app/~~atOP-r7TZ6eS_qk7v73iEg==/com.ss.android.ugc.livelite-1ETDWmK-cmD-R10fT0W0ng==/base.apk tmp/douyin-mall.apk', { stdio: 'inherit' });
}
console.log('APK:', fs.statSync(APK_PATH).size, 'bytes');

// Step 3: Check available tools
console.log('\nChecking tools...');
for (const tool of ['apktool', 'java', 'jarsigner', 'zipalign']) {
  try {
    const result = execSync(`which ${tool} 2>/dev/null || where ${tool} 2>/dev/null || echo NOT_FOUND`, { encoding: 'utf8' }).trim();
    console.log(`  ${tool}: ${result || 'NOT FOUND'}`);
  } catch { console.log(`  ${tool}: NOT FOUND`); }
}
