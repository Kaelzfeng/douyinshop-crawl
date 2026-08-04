/**
 * Semi-reverse full crawl: 小脏鞋 + ggdb, NO share button clicks.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serial = process.env.MUMU_SERIAL || 'emulator-5554';
const XIAOZANGXIE = '\u5c0f\u810f\u978b';
const KEYWORDS = process.env.CRAWL_KEYWORDS || `${XIAOZANGXIE},ggdb`;

const args = [
  path.join(__dirname, 'src', 'cli.mjs'),
  '--semi',
  '--all',
  '--fresh',
  '--serial',
  serial,
  '--output',
  'output/semi-xiaozangxie-ggdb.csv',
  '--checkpoint',
  'data/semi-xiaozangxie-ggdb-checkpoint.json',
  '--summary',
  'output/semi-xiaozangxie-ggdb-summary.json',
  '--diagnostics',
  'output/diagnostics-semi',
];

console.log(`[launcher-semi] keywords=${KEYWORDS} serial=${serial}`);
console.log('[launcher-semi] NO share clicks — Frida product_id / goods_detail only');

const child = spawn(process.execPath, args, {
  cwd: __dirname,
  env: {
    ...process.env,
    MUMU_SERIAL: serial,
    CRAWL_KEYWORDS: KEYWORDS,
    FRIDA_BUNDLE: path.join(__dirname, 'hook', 'capture-semi.bundle.js'),
  },
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 1));
