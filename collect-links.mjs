/**
 * Link collector — monitors Windows clipboard for Douyin share links.
 *
 * How to use:
 *   1. node collect-links.mjs
 *   2. Open Douyin Mall on MuMu
 *   3. Browse products → tap 分享 → tap 复制链接
 *   4. Each link is automatically saved to links.txt (deduplicated)
 *   5. Ctrl+C to stop
 *
 * Rate-limiting note:
 *   The rate limit is on the Android app's share action, not on this script.
 *   If you share too fast, the "复制链接" button won't appear for some products.
 *   Recommended pace: 1 product every ~30 seconds.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);
const OUTPUT_FILE = process.argv[2] || 'links.txt';
const SHARE_URL_RE = /https:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/;

// Load existing links
const seen = new Set();
if (existsSync(OUTPUT_FILE)) {
  const existing = readFileSync(OUTPUT_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  existing.forEach(l => seen.add(l));
}

console.log(`[Collector] Saving to ${OUTPUT_FILE}`);
console.log(`[Collector] ${seen.size} links already collected`);
console.log('[Collector] Monitoring clipboard...');
console.log('[Collector] Browse products on MuMu, tap 分享 → 复制链接');
console.log('[Collector] Links will auto-save. Ctrl+C to stop.\n');

let lastClipboard = '';

async function readClipboard() {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return stdout;
  } catch {
    return '';
  }
}

async function check() {
  const text = await readClipboard();
  if (text === lastClipboard) return;

  lastClipboard = text;
  const match = text.match(SHARE_URL_RE);
  if (!match) return;

  const url = match[0];
  if (seen.has(url)) return;

  seen.add(url);
  appendFileSync(OUTPUT_FILE, url + '\n', 'utf8');
  console.log(`[${String(seen.size).padStart(3)}] ${url}`);
}

// Poll every 500ms
let running = true;
process.on('SIGINT', () => { running = false; });

while (running) {
  await check();
  await new Promise(r => setTimeout(r, 500));
}

console.log(`\n[Collector] Done. ${seen.size} links saved to ${OUTPUT_FILE}`);
