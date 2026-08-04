/**
 * Path B launcher: enter shops from all-products-final.csv seeds, crawl 小脏鞋 in-shop.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serial = process.env.MUMU_SERIAL || 'emulator-5554';
const KW = '\u5c0f\u810f\u978b';

const args = [
  path.join(__dirname, 'src', 'cli.mjs'),
  '--shop-seeds',
  '--seeds',
  'output/all-products-final.csv',
  '--max-shops',
  process.env.MAX_SHOPS || '20',
  '--max-scrolls',
  '35',
  '--fresh',
  '--serial',
  serial,
  '--output',
  'output/shop-from-seeds-xiaozangxie.csv',
  '--checkpoint',
  'data/shop-from-seeds-checkpoint.json',
  '--summary',
  'output/shop-from-seeds-summary.json',
];

console.log(`[launcher] shop-from-seeds keyword=${KW} serial=${serial}`);

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
