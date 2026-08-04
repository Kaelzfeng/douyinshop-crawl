/**
 * Overnight full crawl — ggdb + 小脏鞋.
 *
 * Run from terminal:
 *   node crawl-overnight.mjs
 *
 * Uses traditional share-click mode (proven 1174+ products).
 * Resumes from checkpoint automatically.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERIAL = process.env.MUMU_SERIAL || 'emulator-5554';
const KEYWORDS = process.env.CRAWL_KEYWORDS || 'ggdb,小脏鞋';

const args = [
  path.join(__dirname, 'src', 'cli.mjs'),
  '--all',
  '--serial', SERIAL,
  '--queries', KEYWORDS,
  '--max-scrolls', '200',
  '--output', path.join(__dirname, 'output', 'overnight-ggdb-xiaozangxie.csv'),
  '--checkpoint', path.join(__dirname, 'data', 'overnight-checkpoint.json'),
  '--summary', path.join(__dirname, 'output', 'overnight-summary.json'),
  '--diagnostics', path.join(__dirname, 'output', 'diagnostics-overnight'),
];

console.log('=== Overnight Full Crawl ===');
console.log('Mode: share-click (traditional, proven)');
console.log('Keywords:', KEYWORDS);
console.log('Serial:', SERIAL);
console.log('Output:', args[args.indexOf('--output') + 1]);
console.log('Started at:', new Date().toLocaleString());
console.log('');

const child = spawn(process.execPath, args, {
  cwd: __dirname,
  env: { ...process.env, MUMU_SERIAL: SERIAL, CRAWL_KEYWORDS: KEYWORDS },
  stdio: 'inherit',
});

child.on('exit', (code) => {
  console.log('\nCrawl exited with code:', code);
  console.log('Finished at:', new Date().toLocaleString());
  process.exit(code ?? 1);
});
