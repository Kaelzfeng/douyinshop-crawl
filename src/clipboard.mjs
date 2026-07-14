import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';

const execFileAsync = promisify(execFile);
const SHARE_URL_RE = /https:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function extractShareUrl(text = '') {
  return text.match(SHARE_URL_RE)?.[0] || null;
}

async function readWindowsClipboard() {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))',
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return Buffer.from(stdout.trim(), 'base64').toString('utf8');
}

export async function readCurrentDouyinShareUrl() {
  return extractShareUrl(await readWindowsClipboard().catch(() => ''));
}

export async function waitForDouyinShareUrl({ timeoutMs = 8_000, previousUrl = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    lastText = await readWindowsClipboard().catch(() => '');
    const url = extractShareUrl(lastText);
    if (url && url !== previousUrl) return { url, shareCommand: lastText.trim() };
    await sleep(300);
  }
  throw new Error(`MuMu clipboard sync did not produce a Douyin share URL. Clipboard sample: ${lastText.slice(0, 80)}`);
}
