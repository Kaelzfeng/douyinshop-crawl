/**
 * Launcher: Frida full crawl for 小脏鞋 + ggdb
 * Keywords are Unicode-escaped so PowerShell/file encoding cannot corrupt them.
 *
 * Prereq:
 *   adb -s emulator-5554 root
 *   frida-server as root
 *   Douyin Mall running
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serial = process.env.MUMU_SERIAL || 'emulator-5554';

// 小脏鞋,ggdb — never paste host clipboard into the app
const XIAOZANGXIE = '\u5c0f\u810f\u978b';
const KEYWORDS = process.env.CRAWL_KEYWORDS || `${XIAOZANGXIE},ggdb`;

const args = [
  path.join(__dirname, 'src', 'cli.mjs'),
  '--frida',
  '--all',
  '--gentle',
  '--fresh',
  '--serial',
  serial,
  '--output',
  'output/frida-xiaozangxie-ggdb.csv',
  '--checkpoint',
  'data/frida-xiaozangxie-ggdb-checkpoint.json',
  '--summary',
  'output/frida-xiaozangxie-ggdb-summary.json',
  '--diagnostics',
  'output/diagnostics-frida-dual',
];

console.log(`[launcher] keywords=${KEYWORDS} serial=${serial}`);
console.log('[launcher] note: Chinese search uses deeplink, not host clipboard paste');

const child = spawn(process.execPath, args, {
  cwd: __dirname,
  env: {
    ...process.env,
    MUMU_SERIAL: serial,
    CRAWL_KEYWORDS: KEYWORDS,
  },
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 1));
