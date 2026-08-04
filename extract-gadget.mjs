// Extract frida-gadget.so.xz using Node.js + execSync
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const xzFile = path.join(__dirname, 'tmp', 'frida-gadget.so.xz');
const soFile = path.join(__dirname, 'tmp', 'frida-gadget.so');

if (fs.existsSync(soFile)) {
  console.log('Already extracted:', soFile, fs.statSync(soFile).size, 'bytes');
  process.exit(0);
}

console.log('Extracting', xzFile, '...');

// Method 1: Windows tar
try {
  execSync(`tar -xf "${xzFile}" -C "${path.join(__dirname, 'tmp')}"`, {
    stdio: 'inherit', timeout: 30000
  });
  if (fs.existsSync(soFile)) {
    console.log('Extracted via tar:', soFile, fs.statSync(soFile).size, 'bytes');
    process.exit(0);
  }
} catch (e) {
  console.log('tar failed:', e.message.slice(0, 100));
}

// Method 2: xz from Git Bash
try {
  execSync(`"C:\\Program Files\\Git\\usr\\bin\\xz.exe" -d -f "${xzFile}"`, {
    stdio: 'inherit', timeout: 30000
  });
} catch (e) {
  console.log('xz failed:', e.message.slice(0, 100));
}

// Check result
if (fs.existsSync(soFile)) {
  console.log('Extracted:', soFile, fs.statSync(soFile).size, 'bytes');
} else {
  // The .xz might actually be a plain .so (GitHub sometimes doesn't compress)
  const xzData = fs.readFileSync(xzFile);
  if (xzData[0] === 0x7F && xzData[1] === 0x45 && xzData[2] === 0x4C && xzData[3] === 0x46) {
    // ELF magic - it's already a .so file
    console.log('File is already an ELF binary, renaming...');
    fs.renameSync(xzFile, soFile);
    console.log('Renamed to:', soFile);
  } else if (xzData[0] === 0xFD && xzData[1] === 0x37) {
    console.log('This is an xz file but extraction failed. Please extract manually:');
    console.log('  tar -xf', xzFile, '-C', path.join(__dirname, 'tmp'));
  } else {
    console.log('Unknown format. First bytes:', xzData.slice(0, 4).toString('hex'));
  }
}
