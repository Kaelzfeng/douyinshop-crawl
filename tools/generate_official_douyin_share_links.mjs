import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMuMu, dumpUi, getScreenSize } from '../src/android.mjs';
import { nodeValue, centerOf } from '../src/ui.mjs';
import { readCurrentDouyinShareUrl, waitForDouyinShareUrl } from '../src/clipboard.mjs';
import { createShareRateLimiter } from '../src/rate-limit.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIELD_TITLE = '\u54c1\u540d';
const FIELD_SHOP = '\u5e97\u94fa\u540d';
const FIELD_PRICE = '\u4ef7\u683c';
const FIELD_SALES = '\u9500\u91cf';
const FIELD_SHARE = '\u5206\u4eab\u94fe\u63a5';
const FIELDS = [FIELD_TITLE, FIELD_SHOP, FIELD_PRICE, FIELD_SALES, FIELD_SHARE];

const SHARE = '\u5206\u4eab';
const COPY_LINK = '\u590d\u5236\u94fe\u63a5';
const ACCESS_DENIED_RE = /\u8bbf\u95ee\u88ab\u62d2\u7edd|\u64cd\u4f5c\u8fc7\u4e8e\u9891\u7e41/u;
const OFFICIAL_SHORT_RE = /https:\/\/v\.douyin\.com\/([A-Za-z0-9_-]+)\/?/u;

function readArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function intArg(name, fallback) {
  const value = readArg(name, null);
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.floor(n);
}

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/u, ''));
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter((r) => r.some((c) => c !== '')).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i += 1) obj[header[i]] = r[i] ?? '';
    return obj;
  });
}

function csvCell(value = '') {
  const s = String(value ?? '');
  if (/[",\r\n]/u.test(s)) return `"${s.replace(/"/gu, '""')}"`;
  return s;
}

async function writeCsv(file, rows) {
  const body = [
    FIELDS.map(csvCell).join(','),
    ...rows.map((row) => FIELDS.map((field) => csvCell(row[field] ?? '')).join(',')),
  ].join('\n') + '\n';
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `\ufeff${body}`, 'utf8');
}

function productIdFromRow(row) {
  const haystack = `${row[FIELD_SHARE] || ''} ${row.product_id || ''} ${row.promotion_id || ''}`;
  const direct = haystack.match(/\b\d{16,22}\b/u);
  return direct?.[0] ?? '';
}

function officialShortUrl(text = '') {
  const match = String(text).match(OFFICIAL_SHORT_RE);
  if (!match) return '';
  if (/^\d+$/u.test(match[1])) return '';
  return match[0].endsWith('/') ? match[0] : `${match[0]}/`;
}

function accessDenied(nodes) {
  return nodes.some((n) => ACCESS_DENIED_RE.test(nodeValue(n)));
}

async function waitForUi(device, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    try {
      latest = (await dumpUi(device)).nodes;
      const value = predicate(latest);
      if (value) return { nodes: latest, value };
    } catch {}
    await sleep(500);
  }
  return { nodes: latest, value: null };
}

async function openProduct(device, productId, openDelayMs) {
  // Close any leftover share sheet/toast overlay from the previous item.
  await device.shell('input keyevent 4').catch(() => {});
  await sleep(500);
  const uri = `snssdk561124://ec_goods_detail?product_id=${productId}&promotion_id=${productId}&enter_from=copy`;
  await device.shell(`am start -W -a android.intent.action.VIEW -d "${uri}"`);
  const ready = await waitForUi(device, (nodes) => {
    if (accessDenied(nodes)) return { accessDenied: true };
    const copy = nodes.find((n) => nodeValue(n) === COPY_LINK && n.bounds);
    if (copy) return { shareSheetOpen: true };
    return nodes.find((n) => nodeValue(n) === SHARE && n.bounds && n.bounds.y < 180) ? { ready: true } : null;
  }, Math.max(openDelayMs, 10_000));
  if (ready.value?.accessDenied) throw new Error('access denied while opening product');
  if (ready.value?.shareSheetOpen) {
    await device.shell('input keyevent 4').catch(() => {});
    await sleep(800);
  }
  if (!ready.value) {
    // Some deep-link launches land in the media gallery overlay. Back once returns
    // to the normal product detail page where the top-right share button exists.
    await device.shell('input keyevent 4').catch(() => {});
    await sleep(1200);
    const normal = await waitForUi(
      device,
      (nodes) => nodes.find((n) => nodeValue(n) === SHARE && n.bounds && n.bounds.y < 180) ? { ready: true } : null,
      5_000,
    );
    if (!normal.value) await sleep(openDelayMs);
  }
}

async function tapShare(device, screen) {
  const result = await waitForUi(device, (nodes) => {
    if (accessDenied(nodes)) return { accessDenied: true };
    const button = nodes.find((n) => nodeValue(n) === SHARE && n.bounds && n.bounds.y < 180);
    return button ? { button } : null;
  }, 8_000);
  if (result.value?.accessDenied) throw new Error('access denied before share');
  const point = result.value?.button ? centerOf(result.value.button) : {
    x: Math.round(screen.width * 0.897),
    y: Math.round(screen.height * 0.043),
  };
  await device.shell(`input tap ${Math.round(point.x)} ${Math.round(point.y)}`);
}

async function tapCopyLink(device, screen) {
  const result = await waitForUi(device, (nodes) => {
    if (accessDenied(nodes)) return { accessDenied: true };
    let button = nodes.find((n) => nodeValue(n) === COPY_LINK && n.bounds);
    if (!button) button = nodes.find((n) => /(\u590d\u5236|\u94fe\u63a5)/u.test(nodeValue(n)) && n.bounds);
    const shareSheet = nodes.some((n) => /\u5206\u4eab\u7ed9/u.test(nodeValue(n)));
    if (!button && shareSheet) return { coordinateFallback: true };
    return button ? { button } : null;
  }, 12_000);
  if (result.value?.accessDenied) throw new Error('access denied on share panel');
  if (!result.value?.button && !result.value?.coordinateFallback) throw new Error('share panel did not show copy-link');
  const point = result.value?.button ? centerOf(result.value.button) : {
    x: Math.round(screen.width * 0.073),
    y: Math.round(screen.height * 0.972),
  };
  await device.shell(`input tap ${Math.round(point.x)} ${Math.round(point.y)}`);
}

async function copyOfficialShare(device, screen) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previousUrl = await readCurrentDouyinShareUrl();
    try {
      const alreadyOpen = await waitForUi(
        device,
        (nodes) => nodes.find((n) => nodeValue(n) === COPY_LINK && n.bounds) ? { open: true } : null,
        800,
      );
      if (!alreadyOpen.value) {
        await tapShare(device, screen);
        await sleep(2500);
      }
      await tapCopyLink(device, screen);
      const share = await waitForDouyinShareUrl({ previousUrl, timeoutMs: 25_000 });
      const url = officialShortUrl(share.shareCommand) || officialShortUrl(share.url);
      if (!url) throw new Error('clipboard did not contain an official v.douyin short link');
      return {
        url,
        shareCommand: share.shareCommand,
      };
    } catch (error) {
      lastError = error;
      await device.shell('input keyevent 4').catch(() => {});
      await sleep(1000);
    }
  }
  throw lastError ?? new Error('copy share failed');
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const cwd = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const source = path.resolve(cwd, readArg('--source', 'output/FINAL-golden-goose-products.url-link-backup.csv'));
  const output = path.resolve(cwd, readArg('--output', 'output/FINAL-golden-goose-products-official-copylink.csv'));
  const checkpointFile = path.resolve(cwd, readArg('--checkpoint', 'output/official-share-links-checkpoint.json'));
  const summaryFile = path.resolve(cwd, readArg('--summary', 'output/official-share-links-summary.json'));
  const serial = readArg('--serial', '127.0.0.1:16384');
  const start = intArg('--start', 0);
  const limit = intArg('--limit', 0);
  const maxShares = intArg('--max-shares-per-window', 8);
  const windowMinutes = intArg('--share-window-minutes', 15);
  const openDelayMs = intArg('--open-delay-ms', 5000);
  const finalizePath = readArg('--finalize-to', '');
  const fresh = hasFlag('--fresh');

  const sourceRows = parseCsv(await fs.readFile(source, 'utf8'));
  if (!sourceRows.length) throw new Error(`no rows in ${source}`);

  let checkpoint = fresh ? {} : await loadJson(checkpointFile, {});
  const rows = sourceRows.map((row) => ({ ...row }));

  for (const row of rows) {
    const productId = productIdFromRow(row);
    if (productId && checkpoint[productId]?.shareCommand) {
      row[FIELD_SHARE] = checkpoint[productId].shareCommand;
    }
  }
  await writeCsv(output, rows);

  const { device, devices } = await connectMuMu(serial);
  const screen = await getScreenSize(device);
  const limiter = createShareRateLimiter({
    maxActions: maxShares,
    windowMs: windowMinutes * 60_000,
    onWait: (delayMs) => console.log(`[throttle] waiting ${Math.ceil(delayMs / 1000)}s before next share`),
  });

  const errors = [];
  let attempted = 0;
  let completedThisRun = 0;
  try {
    for (let i = start; i < rows.length; i += 1) {
      if (limit > 0 && attempted >= limit) break;
      const row = rows[i];
      const productId = productIdFromRow(sourceRows[i]);
      if (!productId) {
        errors.push({ index: i, error: 'missing product_id' });
        continue;
      }
      if (checkpoint[productId]?.shareCommand && officialShortUrl(checkpoint[productId].shareCommand)) {
        continue;
      }

      attempted += 1;
      console.log(`[${i + 1}/${rows.length}] ${productId} ${String(row[FIELD_TITLE] || '').slice(0, 46)}`);
      try {
        await limiter.waitForSlot();
        await openProduct(device, productId, openDelayMs);
        const share = await copyOfficialShare(device, screen);
        limiter.recordAction();
        checkpoint[productId] = {
          productId,
          url: share.url,
          shareCommand: share.shareCommand,
          title: row[FIELD_TITLE] || '',
          at: new Date().toISOString(),
        };
        row[FIELD_SHARE] = share.shareCommand;
        completedThisRun += 1;
        console.log(`  -> ${share.url}`);
      } catch (error) {
        const message = error?.message || String(error);
        errors.push({ index: i, productId, title: row[FIELD_TITLE] || '', error: message, at: new Date().toISOString() });
        console.warn(`  !! ${message}`);
        if (/access denied|frequent|\u9891\u7e41|\u62d2\u7edd/iu.test(message)) break;
        await device.shell('input keyevent 4').catch(() => {});
        await sleep(1000);
      }

      await fs.writeFile(checkpointFile, JSON.stringify(checkpoint, null, 2), 'utf8');
      for (let j = 0; j < rows.length; j += 1) {
        const id = productIdFromRow(sourceRows[j]);
        if (id && checkpoint[id]?.shareCommand) rows[j][FIELD_SHARE] = checkpoint[id].shareCommand;
      }
      await writeCsv(output, rows);
      await fs.writeFile(summaryFile, JSON.stringify({
        source,
        output,
        checkpointFile,
        rows: rows.length,
        officialLinks: Object.keys(checkpoint).length,
        completedThisRun,
        attemptedThisRun: attempted,
        complete: Object.keys(checkpoint).length >= rows.length,
        errors,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
    }
  } finally {
    await Promise.allSettled(devices.map((d) => d.close()));
  }

  const officialCount = sourceRows.reduce((count, row) => {
    const id = productIdFromRow(row);
    return count + (id && checkpoint[id]?.shareCommand ? 1 : 0);
  }, 0);
  const complete = officialCount >= sourceRows.length;
  if (complete && finalizePath) {
    const final = path.resolve(cwd, finalizePath);
    await fs.copyFile(output, final);
    console.log(`[finalized] ${final}`);
  }
  console.log(JSON.stringify({
    output,
    checkpointFile,
    rows: sourceRows.length,
    officialLinks: officialCount,
    completedThisRun,
    complete,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
