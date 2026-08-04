/**
 * Shop-tab full crawl for 小脏鞋 only.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serial = process.env.MUMU_SERIAL || 'emulator-5554';
const KW = '\u5c0f\u810f\u978b'; // 小脏鞋

const args = [
  path.join(__dirname, 'src', 'cli.mjs'),
  '--shop-tab',
  '--query',
  KW,
  '--gentle',
  '--serial',
  serial,
  '--max-scrolls',
  '25',
  '--output',
  'output/shop-tab-xiaozangxie.csv',
];

console.log(`[launcher] shop-tab keyword=${KW} serial=${serial}`);

const child = spawn(process.execPath, args, {
  cwd: __dirname,
  env: {
    ...process.env,
    MUMU_SERIAL: serial,
    CRAWL_KEYWORD: KW,
  },
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 1));
