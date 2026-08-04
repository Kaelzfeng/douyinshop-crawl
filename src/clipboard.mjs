import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';

const execFileAsync = promisify(execFile);
const SHARE_URL_RE = /https:\/\/(?:v\.douyin\.com\/[A-Za-z0-9_-]+\/?|haohuo\.jinritemai\.com\/[\w\/%.?=&=-]+)/;

/**
 * Extended regex that also captures haohuo.jinritemai.com URLs with full query
 * strings including goods_detail, product_id, and other tracking params.
 */
const ANY_PRODUCT_URL_RE = /https:\/\/(?:v\.douyin\.com\/[A-Za-z0-9_-]+\/?|haohuo\.jinritemai\.com\/[\w\/%.?&=@!$'()*+,;~-]+)/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// URL extraction
// ---------------------------------------------------------------------------

export function extractShareUrl(text = '') {
  return text.match(SHARE_URL_RE)?.[0] || null;
}

/**
 * Extract ANY product URL — v.douyin.com short links AND haohuo long links
 * (including those with goods_detail query params).
 */
export function extractAnyProductUrl(text = '') {
  return text.match(ANY_PRODUCT_URL_RE)?.[0] || null;
}

// ---------------------------------------------------------------------------
// Windows clipboard (PowerShell)
// ---------------------------------------------------------------------------

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

/**
 * Set Windows clipboard (UTF-8 safe via base64).
 * MuMu mirrors host clipboard — seed the exact keyword BEFORE app paste
 * so we never paste Claude plan paths / chat logs.
 */
export async function setWindowsClipboard(text) {
  const b64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64');
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$bytes = [Convert]::FromBase64String('${b64}'); $t = [Text.Encoding]::UTF8.GetString($bytes); Set-Clipboard -Value $t`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
}

// ---------------------------------------------------------------------------
// ADB clipboard (direct from emulator, bypasses MuMu sync)
// ---------------------------------------------------------------------------

/**
 * Read clipboard directly from the Android emulator via adb shell.
 * This bypasses MuMu's unreliable host-side clipboard sync.
 * @param {object} device — Playwright/ADB device handle with .shell() method
 * @returns {Promise<string>} raw clipboard text
 */
async function readAdbClipboard(device) {
  if (!device) return '';
  try {
    // Primary: cmd clipboard get (Android 10+)
    const { stdout } = await device.shell('cmd clipboard get --user 0');
    const text = (stdout || '').trim();
    if (text && text !== 'null' && text.length > 3) return text;
  } catch { /* fall through */ }

  try {
    // Fallback: dumpsys clipboard
    const { stdout } = await device.shell('dumpsys clipboard');
    const text = (stdout || '');
    // dumpsys output format: "Clipboard content: ..." or "Primary clip: ..."
    const m = text.match(/(?:Clipboard content|Primary clip)[:\s]*(\S[\s\S]*?)(?:\n\s*\n|$)/i);
    if (m?.[1]) return m[1].trim();
    // Try to extract any non-empty, non-metadata line that looks like a URL
    const urlLine = text.split(/\r?\n/).find(
      (line) => /https?:\/\//i.test(line) && !/clipboard|service|package/i.test(line),
    );
    if (urlLine) return urlLine.trim();
  } catch { /* fall through */ }

  return '';
}

/**
 * Clear the Android device clipboard to prevent stale URL reads.
 * @param {object} device — Playwright/ADB device handle
 */
export async function clearDeviceClipboard(device) {
  if (!device) return;
  try {
    await device.shell('cmd clipboard set --user 0 ""').catch(() => {});
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// High-level clipboard reading
// ---------------------------------------------------------------------------

export async function readCurrentDouyinShareUrl() {
  return extractShareUrl(await readWindowsClipboard().catch(() => ''));
}

/**
 * Poll a single clipboard source until a matching URL appears.
 * @returns {Promise<{url: string, text: string} | null>}
 */
async function pollUntilUrl(readFn, { timeoutMs, intervalMs, previousUrl, extendedMatch = false }) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  const extractFn = extendedMatch ? extractAnyProductUrl : extractShareUrl;
  while (Date.now() < deadline) {
    try {
      lastText = await readFn();
    } catch {
      lastText = '';
    }
    const url = extractFn(lastText);
    if (url && url !== previousUrl) {
      return { url, text: lastText.trim() };
    }
    await sleep(intervalMs);
  }
  return null;
}

/**
 * Wait for a Douyin share URL to appear in the clipboard.
 *
 * When `device` is provided, races THREE clipboard sources in parallel:
 *   1. Windows clipboard (PowerShell, 300ms poll)
 *   2. ADB `cmd clipboard get` (400ms poll)
 *   3. ADB `dumpsys clipboard` (500ms poll, last resort)
 *
 * The first source to produce a matching URL wins.
 *
 * @param {object} [options]
 * @param {number}  [options.timeoutMs=15_000]
 * @param {string}  [options.previousUrl=null]
 * @param {object}  [options.device=null] — Playwright/ADB device for direct clipboard read
 * @returns {Promise<{url: string, shareCommand: string}>}
 */
export async function waitForDouyinShareUrl({ timeoutMs = 15_000, previousUrl = null, device = null } = {}) {
  const deadline = Date.now() + timeoutMs;

  // Build poll sources
  const sources = [
    {
      name: 'windows',
      poll: () => pollUntilUrl(
        () => readWindowsClipboard(),
        { timeoutMs: deadline - Date.now(), intervalMs: 300, previousUrl, extendedMatch: false },
      ),
    },
  ];

  if (device) {
    sources.push({
      name: 'adb-cmd',
      poll: () => pollUntilUrl(
        () => readAdbClipboard(device),
        { timeoutMs: deadline - Date.now(), intervalMs: 400, previousUrl, extendedMatch: true },
      ),
    });
  }

  // Race all sources; pick winner
  const results = await Promise.allSettled(sources.map((s) => s.poll()));
  let bestResult = null;
  const samples = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value) {
      // Prefer haohuo long URLs over v.douyin.com short links
      const isHaohuo = /haohuo\.jinritemai/.test(r.value.url);
      if (!bestResult || (isHaohuo && !/haohuo\.jinritemai/.test(bestResult.url))) {
        bestResult = r.value;
      }
    }
    // Collect debug samples
    try {
      if (sources[i].name === 'windows') {
        const t = await readWindowsClipboard().catch(() => '');
        samples.push(`windows: ${t.slice(0, 60)}`);
      }
    } catch { /* ignore */ }
  }

  if (bestResult) {
    return { url: bestResult.url, shareCommand: bestResult.text };
  }

  // Nothing found — collect debug info
  let adbSample = '';
  if (device) {
    try { adbSample = await readAdbClipboard(device); } catch { /* ignore */ }
  }
  throw new Error(
    `No Douyin share URL found in clipboard after ${timeoutMs}ms. ` +
    `Windows sample: ${samples.join('; ') || 'n/a'}. ` +
    `ADB sample: ${(adbSample || '').slice(0, 80) || 'n/a'}`,
  );
}
