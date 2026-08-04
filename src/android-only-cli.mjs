#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { createAndroidCollector } from '../android-only-collector/collector.mjs';
import { shortenProducts } from './official-shortener.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLLECTOR_DIR = path.join(ROOT, 'android-only-collector');
const KEYWORDS = ['ggdb', '\u5c0f\u810f\u978b'];
const DEFAULT_ADB = process.env.ADB_PATH
  || (fs.existsSync('C:\\ReverseLab\\tools\\platform-tools\\adb.exe')
    ? 'C:\\ReverseLab\\tools\\platform-tools\\adb.exe'
    : 'adb');
const BASE_SCREEN = { width: 900, height: 1600 };
const MAIN_ACTIVITY = 'com.ss.android.ugc.aweme.main.MainActivity';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
}

function parseOptions(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      adb: { type: 'string', default: DEFAULT_ADB },
      serial: { type: 'string', default: process.env.ANDROID_SERIAL || 'emulator-5554' },
      'frida-host': { type: 'string', default: process.env.FRIDA_HOST || '127.0.0.1:27042' },
      package: { type: 'string', default: 'com.ss.android.ugc.livelite' },
      db: { type: 'string', default: 'output/android-only.sqlite' },
      events: { type: 'string', default: 'output/android-only-events.jsonl' },
      output: { type: 'string', default: 'output/products.csv' },
      summary: { type: 'string', default: 'output/android-only-summary.json' },
      target: { type: 'string', default: '0' },
      'max-scrolls': { type: 'string', default: '40' },
      'share-scrolls': { type: 'string', default: '40' },
      'shop-scrolls': { type: 'string', default: '120' },
      'store-scrolls': { type: 'string', default: '60' },
      'shop-idle-pages': { type: 'string', default: '5' },
      'action-delay-ms': { type: 'string', default: '8000' },
      'captcha-wait-ms': { type: 'string', default: '900000' },
      'captcha-restarts': { type: 'string', default: '30' },
      'captcha-manual': { type: 'boolean', default: false },
      'shorten-workers': { type: 'string', default: '3' },
      'shorten-delay-ms': { type: 'string', default: '500' },
      'time-budget-minutes': { type: 'string', default: '0' },
      'warmup-ms': { type: 'string', default: '10000' },
      fresh: { type: 'boolean', default: false },
      'collect-only': { type: 'boolean', default: false },
      'no-short-link': { type: 'boolean', default: false },
      'share-ui-fallback': { type: 'boolean', default: false },
      'no-codec-fix': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  return {
    ...values,
    db: path.resolve(ROOT, values.db),
    events: path.resolve(ROOT, values.events),
    output: path.resolve(ROOT, values.output),
    summary: path.resolve(ROOT, values.summary),
    target: nonNegativeInteger(values.target, '--target'),
    maxScrolls: positiveInteger(values['max-scrolls'], '--max-scrolls'),
    shareScrolls: positiveInteger(values['share-scrolls'], '--share-scrolls'),
    shopScrolls: positiveInteger(values['shop-scrolls'], '--shop-scrolls'),
    storeScrolls: positiveInteger(values['store-scrolls'], '--store-scrolls'),
    shopIdlePages: positiveInteger(values['shop-idle-pages'], '--shop-idle-pages'),
    actionDelayMs: positiveInteger(values['action-delay-ms'], '--action-delay-ms'),
    captchaWaitMs: positiveInteger(values['captcha-wait-ms'], '--captcha-wait-ms'),
    captchaRestarts: positiveInteger(values['captcha-restarts'], '--captcha-restarts'),
    shortenWorkers: positiveInteger(values['shorten-workers'], '--shorten-workers'),
    shortenDelayMs: nonNegativeInteger(values['shorten-delay-ms'], '--shorten-delay-ms'),
    timeBudgetMinutes: nonNegativeInteger(values['time-budget-minutes'], '--time-budget-minutes'),
    shortenCache: path.join(ROOT, 'output', 'official-shorten-cache.jsonl'),
    shortenFailures: path.join(ROOT, 'output', 'shorten-failures.jsonl'),
    warmupMs: positiveInteger(values['warmup-ms'], '--warmup-ms'),
  };
}

function helpText() {
  return `Android-only Douyin Mall collector

Usage:
  npm start -- [options]

The search keywords are fixed to: ggdb, \u5c0f\u810f\u978b

Options:
  --serial <id>          ADB/Frida device (default: emulator-5554)
  --frida-host <host>   Frida remote host (default: 127.0.0.1:27042)
  --package <name>      Android package
  --db <path>           SQLite output
  --events <path>       JSONL output
  --output <path>       Complete six-field CSV output
  --summary <path>      Run summary JSON
  --target <count>      Optional linked-row cap; 0 means collect until exhausted (default)
  --max-scrolls <n>     Passive collection scrolls per keyword
  --share-scrolls <n>   Share-enrichment scrolls per keyword
  --shop-scrolls <n>    Safety ceiling for shop-result pages (default: 120)
  --store-scrolls <n>   Safety ceiling for each in-shop result list (default: 60)
  --shop-idle-pages <n> Stop after this many shop pages add no new shop (default: 5)
  --action-delay-ms <n> Delay around shop/search actions to reduce risk (default: 8000)
  --captcha-wait-ms <n> Legacy compatibility option
  --captcha-restarts <n> Maximum automatic app restarts after captcha (default: 30)
  --captcha-manual       Keep captcha open and wait for manual completion
  --shorten-workers <n> Concurrent official short-link requests (default: 3)
  --shorten-delay-ms <n> Delay/backoff base for short-link requests (default: 500)
  --time-budget-minutes <n> Stop UI collection early enough to finish within this budget
  --warmup-ms <ms>      App warmup before Frida attach (default: 10000)
  --fresh               Remove only the selected output files before the run
  --collect-only        Skip detail/share enrichment
  --no-short-link       Disable official short-link generation
  --share-ui-fallback   Use UI sharing only for API failures
  --no-codec-fix        Do not apply the reversible MuMu codec bind mount
  -h, --help            Show this help
`;
}

function runFile(file, args, { timeout = 30_000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout = '', stderr = '') => {
      if (error && !allowFailure) {
        error.message = `${error.message}\n${stderr || stdout}`.trim();
        reject(error);
        return;
      }
      resolve({ ok: !error, stdout, stderr, error });
    });
  });
}

function runFileBuffer(file, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: ROOT,
      encoding: null,
      windowsHide: true,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)) => {
      if (error) {
        error.message = `${error.message}\n${stderr.toString('utf8')}`.trim();
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function createAdb(options) {
  const base = ['-s', options.serial];
  const run = async (...args) => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await runFile(options.adb, [...base, ...args]);
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(500 * attempt);
      }
    }
    throw lastError;
  };
  return {
    run,
    try: (...args) => runFile(options.adb, [...base, ...args], { allowFailure: true }),
    raw: (...args) => runFileBuffer(options.adb, [...base, ...args]),
    push: (local, remote) => runFile(options.adb, [...base, 'push', local, remote]),
    pull: (remote, local) => runFile(options.adb, [...base, 'pull', remote, local]),
  };
}

function assertFreshTarget(file) {
  const relative = path.relative(ROOT, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`--fresh refuses a path outside the workspace: ${file}`);
  }
}

function clearSelectedOutputs(options) {
  const targets = [
    options.db,
    `${options.db}-wal`,
    `${options.db}-shm`,
    `${options.db}.failed.jsonl`,
    options.events,
    `${options.events}.failed`,
    options.output,
    options.summary,
    options.shortenFailures,
  ];
  for (const target of targets) {
    assertFreshTarget(target);
    fs.rmSync(target, { force: true });
  }
}

async function applyMuMuCodecFix(adb) {
  const systemFile = '/system/etc/media_codecs_google_video.xml';
  const remoteFixed = '/data/local/tmp/android-only-media-codecs-google-video.xml';
  const remoteBackup = '/data/local/tmp/android-only-media-codecs-google-video.original.xml';
  const localFixed = path.join(COLLECTOR_DIR, 'mumu', 'media_codecs_google_video.xml');
  const current = await adb.run('shell', 'cat', systemFile);
  if (!current.stdout.includes('OMX.qcom.video.decoder.avc')) {
    process.stdout.write('[codec] software H.264 decoder already active\n');
    return false;
  }
  if (!fs.existsSync(localFixed)) throw new Error(`MuMu codec asset not found: ${localFixed}`);

  const backup = await adb.try('shell', 'ls', remoteBackup);
  if (!backup.ok) await adb.run('shell', 'cp', systemFile, remoteBackup);
  await adb.push(localFixed, remoteFixed);
  await adb.run('shell', 'mount', '--bind', remoteFixed, systemFile);

  for (const name of ['media.extractor', 'mediaserver', 'media.codec', 'media.swcodec']) {
    const result = await adb.try('shell', 'pidof', name);
    const pids = result.stdout.trim().split(/\s+/).filter((value) => /^\d+$/.test(value));
    if (pids.length) await adb.try('shell', 'kill', '-15', ...pids);
  }
  await sleep(4_000);
  const verified = await adb.run('shell', 'cat', systemFile);
  if (verified.stdout.includes('OMX.qcom.video.decoder.avc')) {
    throw new Error('MuMu codec bind mount did not remove OMX.qcom.video.decoder.avc');
  }
  process.stdout.write('[codec] OMX.google.h264.decoder selected; fix is reversible on MuMu reboot\n');
  return true;
}

async function screenSize(adb) {
  const result = await adb.run('shell', 'wm', 'size');
  const matches = [...result.stdout.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const selected = matches.at(-1);
  return selected
    ? { width: Number(selected[1]), height: Number(selected[2]) }
    : { ...BASE_SCREEN };
}

function point(screen, x, y) {
  return {
    x: Math.round((x / BASE_SCREEN.width) * screen.width),
    y: Math.round((y / BASE_SCREEN.height) * screen.height),
  };
}

async function tap(adb, screen, x, y) {
  const target = point(screen, x, y);
  await adb.run('shell', 'input', 'tap', String(target.x), String(target.y));
}

async function swipe(adb, screen, x1, y1, x2, y2, duration = 700) {
  const start = point(screen, x1, y1);
  const end = point(screen, x2, y2);
  await adb.run(
    'shell', 'input', 'swipe',
    String(start.x), String(start.y), String(end.x), String(end.y), String(duration),
  );
}

async function appPid(adb, packageName) {
  const result = await adb.try('shell', 'pidof', packageName);
  return result.stdout.trim().split(/\s+/).find((value) => /^\d+$/.test(value)) || '';
}

async function topActivity(adb) {
  const activities = await adb.try('shell', 'dumpsys', 'activity', 'activities');
  const resumed = activities.stdout.match(
    /(?:topResumedActivity|mResumedActivity)[=:].*?\s([\w.]+\/[\w.$]+)/,
  )?.[1];
  if (resumed) return resumed;
  const windows = await adb.try('shell', 'dumpsys', 'window', 'windows');
  return windows.stdout.match(
    /m(?:CurrentFocus|FocusedApp).*?\s([\w.]+\/[\w.$]+)/,
  )?.[1] || windows.stdout.match(
    /mActivityRecord=ActivityRecord\{[^}]*\su\d+\s+([\w.]+\/[\w.$]+)/,
  )?.[1] || '';
}

async function startApp(adb, options) {
  await adb.run(
    'shell', 'am', 'start', '-n', `${options.package}/${MAIN_ACTIVITY}`,
  );
}

async function attachCollector(adb, options, state) {
  if (state.collector) await state.collector.close().catch(() => {});
  let pid = await appPid(adb, options.package);
  if (!pid) {
    await startApp(adb, options);
    await sleep(options.warmupMs);
    pid = await appPid(adb, options.package);
  }
  if (!pid) throw new Error(`Android process not found: ${options.package}`);

  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const collector = await createAndroidCollector({
        serial: options.serial,
        fridaHost: options['frida-host'],
        packageName: options.package,
        db: options.db,
        events: options.events,
        agent: path.join(COLLECTOR_DIR, 'agent.bundle.js'),
        stdout: false,
      });
      collector.detached = false;
      try { collector.session.detached.connect(() => { collector.detached = true; }); } catch (_) {}
      state.collector = collector;
      process.stdout.write(`[collector] attached pid=${collector.processInfo.pid}\n`);
      return collector;
    } catch (error) {
      lastError = error;
      if (attempt < 6) await sleep(5_000);
    }
  }
  throw lastError;
}

async function ensureCollector(adb, options, state) {
  const pid = await appPid(adb, options.package);
  if (state.collector
    && !state.collector.detached
    && pid
    && Number(pid) === Number(state.collector.processInfo.pid)) {
    return state.collector;
  }
  if (!pid) {
    await startApp(adb, options);
    await sleep(options.warmupMs);
  }
  return attachCollector(adb, options, state);
}

async function resetAppToMain(adb, screen, options, state) {
  if (state.collector) {
    await state.collector.close().catch(() => {});
    state.collector = null;
  }
  await adb.run('shell', 'am', 'force-stop', options.package);
  await sleep(1_000);
  await startApp(adb, options);

  const deadline = Date.now() + Math.max(20_000, options.warmupMs);
  while (Date.now() < deadline) {
    if ((await topActivity(adb)).endsWith(`/${MAIN_ACTIVITY}`)) break;
    await sleep(1_000);
  }
  if (!(await topActivity(adb)).endsWith(`/${MAIN_ACTIVITY}`)) {
    throw new Error('MainActivity did not become ready after a clean app start');
  }
  const settleMs = Math.max(5_000, options.warmupMs);
  process.stdout.write(`[app] clean MainActivity warmup ${settleMs}ms\n`);
  await sleep(settleMs);
  await dismissKnownPopups(adb, screen);
  await assertNoLoginBlock(adb);
  await tap(adb, screen, 90, 1545);
  await sleep(2_000);
  await dismissKnownPopups(adb, screen);
  const readyDeadline = Date.now() + Math.max(15_000, options.warmupMs);
  while (Date.now() < readyDeadline) {
    const xml = await dumpUiXml(adb);
    if (exactNodeCenter(xml, '\u641c\u7d22', { maxY: 150 })) return;
    await sleep(1_000);
  }
  throw new Error('Mall search control did not become ready after app start');
}

function withDatabase(dbPath, callback) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function normalizedProductText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .toLowerCase();
}

function matchesKeyword(value, keyword) {
  const text = normalizedProductText(value);
  if (keyword === 'ggdb') return text.replace(/\s+/g, '').includes('ggdb');
  return text.includes('\u5c0f\u810f\u978b');
}

function matchesTargetKeyword(value) {
  return KEYWORDS.some((keyword) => matchesKeyword(value, keyword));
}

function targetProductCount(dbPath, keyword = '') {
  if (!fs.existsSync(dbPath)) return 0;
  return withDatabase(dbPath, (db) => db.prepare(`
    SELECT product_name, title FROM products
  `).all().filter((row) => (
    keyword
      ? matchesKeyword(row.product_name || row.title, keyword)
      : matchesTargetKeyword(row.product_name || row.title)
  )).length);
}

function targetProductIds(dbPath, limit = 0) {
  if (!fs.existsSync(dbPath)) return [];
  const ids = withDatabase(dbPath, (db) => db.prepare(`
    SELECT product_id, COALESCE(NULLIF(product_name, ''), title) AS product_name
    FROM products
    WHERE trim(product_id) <> ''
    ORDER BY first_seen_ts, product_id
  `).all().filter((row) => matchesTargetKeyword(row.product_name)).map((row) => String(row.product_id)));
  return limit > 0 ? ids.slice(0, limit) : ids;
}

function collectionShouldStop(options, state) {
  if (state.stopRequested) return true;
  let reason = '';
  if (state.collectionDeadline && Date.now() >= state.collectionDeadline) {
    reason = 'time_budget';
  } else if (options.target > 0 && targetProductCount(options.db) >= options.target) {
    reason = 'target_reached';
  }
  if (!reason) return false;
  if (!state.collectionStopReason) {
    state.collectionStopReason = reason;
    process.stdout.write(`[collect] stopping reason=${reason} products=${targetProductCount(options.db)}\n`);
  }
  return true;
}

function validProductCount(dbPath) {
  return Number(withDatabase(dbPath, (db) => db.prepare(`
    SELECT COUNT(*) AS count
    FROM products
    WHERE trim(product_id) <> ''
      AND trim(COALESCE(NULLIF(product_name, ''), title)) <> ''
      AND trim(COALESCE(NULLIF(price, ''), NULLIF(min_price, ''), max_price)) NOT IN ('', '0')
  `).get().count));
}

function completeProductCount(dbPath) {
  return withDatabase(dbPath, (db) => db.prepare(`
    SELECT product_id,
      COALESCE(NULLIF(product_name, ''), title) AS product_name,
      shop_name,
      COALESCE(NULLIF(price, ''), NULLIF(min_price, ''), max_price) AS price,
      sales
    FROM products
  `).all().filter((row) => rowIsComplete(row) && matchesTargetKeyword(row.product_name)).length);
}

function linkedCompleteCount(dbPath) {
  return withDatabase(dbPath, (db) => db.prepare(`
    SELECT DISTINCT p.product_id,
      COALESCE(NULLIF(p.product_name, ''), p.title) AS product_name,
      p.shop_name,
      COALESCE(NULLIF(p.price, ''), NULLIF(p.min_price, ''), p.max_price) AS price,
      p.sales,
      ps.share_url
    FROM products p
    JOIN product_shares ps ON ps.product_id = p.product_id
  `).all().filter((row) => (
    rowIsComplete(row)
    && matchesTargetKeyword(row.product_name)
    && String(row.share_url || '').trim()
  )).length);
}

function latestNavigationProduct(dbPath, since) {
  return withDatabase(dbPath, (db) => db.prepare(`
    SELECT product_id, ts
    FROM events
    WHERE event = 'product_found'
      AND stage IN ('ec_goods_detail', 'detail_request')
      AND product_id <> ''
      AND ts >= ?
    ORDER BY ts DESC
    LIMIT 1
  `).get(since));
}

function productRow(dbPath, productId) {
  return withDatabase(dbPath, (db) => db.prepare(`
    SELECT product_id,
      COALESCE(NULLIF(product_name, ''), title) AS product_name,
      shop_name,
      COALESCE(NULLIF(price, ''), NULLIF(min_price, ''), max_price) AS price,
      sales
    FROM products
    WHERE product_id = ?
  `).get(productId));
}

function observedShopName(dbPath, since) {
  return withDatabase(dbPath, (db) => db.prepare(`
    SELECT shop_name, COUNT(*) AS count
    FROM events
    WHERE event = 'product_found'
      AND ts >= ?
      AND trim(shop_name) <> ''
    GROUP BY shop_name
    ORDER BY count DESC, MAX(ts) DESC
    LIMIT 1
  `).get(since)?.shop_name || '');
}

function linkedUrl(dbPath, productId) {
  return withDatabase(dbPath, (db) => db.prepare(`
    SELECT share_url
    FROM product_shares
    WHERE product_id = ?
    ORDER BY last_seen_ts DESC
    LIMIT 1
  `).get(productId)?.share_url || '');
}

async function waitForNavigationProduct(adb, dbPath, since, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await topActivity(adb);
    if (current.endsWith('/com.ss.android.ugc.aweme.detail.ui.DetailActivity')
      || current.endsWith('/com.bytedance.android.shopping.store.arch.ECStoreActivity')) {
      return '';
    }
    if (current.endsWith('ProductDetailActivity')) {
      const found = latestNavigationProduct(dbPath, since);
      if (found?.product_id) return String(found.product_id);
    }
    await sleep(400);
  }
  return '';
}

function isStoreListActivity(value) {
  const activity = String(value || '');
  return /\.ECStoreActivity$/.test(activity) || isStoreSearchActivity(activity);
}

function isStoreSearchActivity(value) {
  const activity = String(value || '');
  return /\.ECShopSearchActivity$/.test(activity)
    || /com\.bytedance\.android\.shopping\.store\.search\..*ShopSearchResultActivity$/.test(activity);
}

async function waitForStoreProduct(adb, dbPath, since, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await topActivity(adb);
    if (current.endsWith('/com.ss.android.ugc.aweme.detail.ui.DetailActivity')) return '';
    if (current.endsWith('ProductDetailActivity')) {
      const found = latestNavigationProduct(dbPath, since);
      if (found?.product_id) return String(found.product_id);
    }
    await sleep(400);
  }
  return '';
}

async function returnToStoreList(adb, options, context) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await waitForCaptchaClear(adb, options, context);
    if (isStoreListActivity(await topActivity(adb))) {
      await sleep(2_000);
      return true;
    }
    await adb.try('shell', 'input', 'keyevent', '4');
    await sleep(2_000);
  }
  return false;
}

async function waitForLinkedUrl(dbPath, productId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = linkedUrl(dbPath, productId);
    if (url) return url;
    await sleep(500);
  }
  return '';
}

async function dumpUiXml(adb) {
  const remote = '/sdcard/android-only-query.xml';
  await adb.try('shell', 'uiautomator', 'dump', '--compressed', remote);
  const xml = await adb.try('shell', 'cat', remote);
  await adb.try('shell', 'rm', '-f', remote);
  return xml.ok && xml.stdout.includes('<hierarchy') ? xml.stdout : '';
}

async function waitForUiXml(adb, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const xml = await dumpUiXml(adb);
    if (xml) return xml;
    await sleep(1_000);
  }
  return '';
}

function decodeXmlText(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function uiNodes(xml) {
  const result = [];
  for (const tag of xml.match(/<node\b[^>]*>/g) || []) {
    const bounds = tag.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    const left = Number(bounds[1]);
    const top = Number(bounds[2]);
    const right = Number(bounds[3]);
    const bottom = Number(bounds[4]);
    result.push({
      text: decodeXmlText(tag.match(/\btext="([^"]*)"/)?.[1] || ''),
      description: decodeXmlText(tag.match(/\bcontent-desc="([^"]*)"/)?.[1] || ''),
      className: tag.match(/\bclass="([^"]*)"/)?.[1] || '',
      resourceId: tag.match(/\bresource-id="([^"]*)"/)?.[1] || '',
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      x: Math.round((left + right) / 2),
      y: Math.round((top + bottom) / 2),
    });
  }
  return result;
}

async function captureRawScreen(adb) {
  const { stdout } = await adb.raw('exec-out', 'screencap');
  if (stdout.length < 16) throw new Error('Android screencap returned an incomplete buffer');
  const width = stdout.readUInt32LE(0);
  const height = stdout.readUInt32LE(4);
  const format = stdout.readUInt32LE(8);
  const expected = 16 + (width * height * 4);
  if (format !== 1 || width <= 0 || height <= 0 || stdout.length < expected) {
    throw new Error(`Unsupported Android screencap: ${width}x${height} format=${format} bytes=${stdout.length}`);
  }
  return { width, height, pixels: stdout.subarray(16, expected) };
}

function isEnterButtonPixel(red, green, blue) {
  return red > 230 && green < 160 && blue < 190 && red - green > 70;
}

function shopHeaderFingerprint(screen, centerY) {
  const hash = createHash('sha1');
  const top = Math.max(170, centerY - 75);
  const bottom = Math.min(screen.height - 1, centerY + 55);
  for (let y = top; y <= bottom; y += 6) {
    for (let x = 20; x < screen.width - 15; x += 8) {
      const offset = ((y * screen.width) + x) * 4;
      hash.update(Buffer.from([
        screen.pixels[offset] >> 4,
        screen.pixels[offset + 1] >> 4,
        screen.pixels[offset + 2] >> 4,
      ]));
    }
  }
  return hash.digest('hex');
}

function detectStoreEntryButtons(screen) {
  const left = Math.floor(screen.width * 0.76);
  const rows = [];
  for (let y = 170; y < screen.height - 20; y += 1) {
    let count = 0;
    let xTotal = 0;
    for (let x = left; x < screen.width; x += 1) {
      const offset = ((y * screen.width) + x) * 4;
      if (!isEnterButtonPixel(
        screen.pixels[offset],
        screen.pixels[offset + 1],
        screen.pixels[offset + 2],
      )) continue;
      count += 1;
      xTotal += x;
    }
    if (count > 35) rows.push({ y, count, x: Math.round(xTotal / count) });
  }

  const groups = [];
  for (const row of rows) {
    const latest = groups.at(-1);
    if (!latest || row.y > latest.at(-1).y + 1) groups.push([row]);
    else latest.push(row);
  }

  return groups
    .map((group) => {
      const y1 = group[0].y;
      const y2 = group.at(-1).y;
      const strongest = group.reduce((best, row) => row.count > best.count ? row : best);
      const y = Math.round((y1 + y2) / 2);
      return {
        x: strongest.x,
        y,
        height: y2 - y1 + 1,
        maxWidth: strongest.count,
        fingerprint: shopHeaderFingerprint(screen, y),
      };
    })
    .filter((button) => button.height >= 25 && button.height <= 50 && button.maxWidth >= 70);
}

function exactNodeCenter(xml, value, { minY = 0, maxY = Infinity } = {}) {
  for (const node of xml.match(/<node\b[^>]*>/g) || []) {
    const text = node.match(/\btext="([^"]*)"/)?.[1] || '';
    const description = node.match(/\bcontent-desc="([^"]*)"/)?.[1] || '';
    if (text !== value && description !== value) continue;
    const bounds = node.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    const top = Number(bounds[2]);
    const bottom = Number(bounds[4]);
    const centerY = Math.round((top + bottom) / 2);
    if (centerY < minY || centerY > maxY) continue;
    return {
      x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
      y: centerY,
    };
  }
  return null;
}

async function tapActual(adb, pointToTap) {
  await adb.run('shell', 'input', 'tap', String(pointToTap.x), String(pointToTap.y));
}

async function tapCopyLink(adb, screen) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const xml = await waitForUiXml(adb, 2);
    const copyLink = exactNodeCenter(xml, '\u590d\u5236\u94fe\u63a5', { minY: 1_200 });
    if (copyLink) {
      await tapActual(adb, copyLink);
      return true;
    }
    await sleep(750);
  }

  // MuMu 900x1600 fallback. The UI node is preferred because the share sheet
  // moves vertically when the recipient row changes height.
  await tap(adb, screen, 58, 1_513);
  return false;
}

async function dismissKnownPopups(adb, screen) {
  const xml = await waitForUiXml(adb, 2);
  if (!xml.includes('text="\u4ee5\u540e\u518d\u8bf4"')) return false;
  const later = exactNodeCenter(xml, '\u4ee5\u540e\u518d\u8bf4');
  if (later) await tapActual(adb, later);
  else await tap(adb, screen, 345, 1018);
  await sleep(2_000);
  process.stdout.write('[app] dismissed update prompt\n');
  return true;
}

async function assertNoLoginBlock(adb) {
  const activities = await adb.try('shell', 'dumpsys', 'activity', 'activities');
  const top = activities.stdout.match(/topResumedActivity=.*?\s([\w.]+\/[\w.$]+)/)?.[1] || '';
  if (/\.account\.(?:business\.)?(?:login|logout|verify|verification|onekey)/i.test(top)) {
    const error = new Error(`Douyin login is required before Android collection can continue (${top})`);
    error.code = 'DOUYIN_LOGIN_REQUIRED';
    throw error;
  }
  const xml = await dumpUiXml(adb);
  if (!/\u8d26\u53f7\u5df2\u9000\u51fa\u767b\u5f55|\u767b\u5f55\u4fe1\u606f\u5931\u6548|\u6211\u77e5\u9053\u4e86|\u767b\u5f55\u53d1\u73b0\u66f4\u591a\u7cbe\u5f69|\u5bc6\u7801\u767b\u5f55|\u8bf7\u8f93\u5165\u9a8c\u8bc1\u7801|\u77ed\u4fe1\u5df2\u53d1\u9001\u81f3/.test(xml)) return;
  const error = new Error('Douyin login is required before Android collection can continue');
  error.code = 'DOUYIN_LOGIN_REQUIRED';
  throw error;
}

async function waitForCaptchaClear(adb, options, context) {
  if (!/BdTuringVerifyActivity/.test(await topActivity(adb))) return false;
  const safeContext = String(context || 'unknown').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60);
  const diagnostic = path.join(
    ROOT,
    'output',
    'diagnostics',
    `captcha-${safeContext}-${Date.now()}.png`,
  );
  await captureScreenshot(adb, diagnostic).catch(() => {});
  process.stdout.write(`[risk] captcha detected context=${context} screenshot=${diagnostic}\n`);
  if (options['captcha-manual']) {
    const manualDeadline = Date.now() + options.captchaWaitMs;
    process.stdout.write(`[risk] captcha waiting for manual completion timeout=${options.captchaWaitMs}ms\n`);
    while (Date.now() < manualDeadline) {
      if (!/BdTuringVerifyActivity/.test(await topActivity(adb))) {
        process.stdout.write(`[risk] captcha manually cleared context=${context}\n`);
        await sleep(options.actionDelayMs);
        return true;
      }
      await sleep(1_000);
    }
    process.stdout.write(`[risk] captcha manual wait timed out context=${context}\n`);
  }
  await adb.try('shell', 'input', 'keyevent', '4');
  await sleep(2_000);
  if (!/BdTuringVerifyActivity/.test(await topActivity(adb))) {
    process.stdout.write(`[risk] captcha dismissed context=${context}\n`);
    await sleep(options.actionDelayMs);
    return true;
  }
  await adb.try('shell', 'input', 'tap', '729', '512');
  await sleep(2_000);
  if (!/BdTuringVerifyActivity/.test(await topActivity(adb))) {
    process.stdout.write(`[risk] captcha dismissed context=${context}\n`);
    await sleep(options.actionDelayMs);
    return true;
  }

  process.stdout.write(`[risk] captcha restart context=${context}\n`);
  await adb.run('shell', 'am', 'force-stop', options.package);
  await sleep(1_500);
  await startApp(adb, options);
  const deadline = Date.now() + Math.max(20_000, options.warmupMs);
  while (Date.now() < deadline && !(await topActivity(adb)).endsWith(`/${MAIN_ACTIVITY}`)) {
    await sleep(1_000);
  }
  await sleep(Math.max(15_000, Math.min(60_000, options.actionDelayMs * 5)));
  const error = new Error(`Douyin captcha forced an app restart: ${diagnostic}`);
  error.code = 'DOUYIN_CAPTCHA_RESTARTED';
  throw error;
}

async function runWithCaptchaRecovery(options, state, label, task) {
  let restarts = 0;
  while (!state.stopRequested) {
    try {
      return await task();
    } catch (error) {
      if (error?.code !== 'DOUYIN_CAPTCHA_RESTARTED') throw error;
      restarts += 1;
      state.storeTitleAttempts.clear();
      if (restarts > options.captchaRestarts) {
        throw new Error(`${label} exceeded ${options.captchaRestarts} captcha restarts`);
      }
      if (state.collectionDeadline && Date.now() >= state.collectionDeadline) return undefined;
      const cooldownMs = Math.min(
        300_000,
        30_000 * (2 ** Math.min(restarts - 1, 4)),
      );
      process.stdout.write(
        `[risk] resume phase=${label} restart=${restarts}/${options.captchaRestarts} cooldown=${cooldownMs}ms\n`,
      );
      await sleep(cooldownMs);
    }
  }
  return undefined;
}

async function verifyTypedQuery(adb, query) {
  const xml = await waitForUiXml(adb);
  if (!xml || !exactNodeCenter(xml, query, { maxY: 150 })) {
    throw new Error(`Search field did not contain the exact keyword ${JSON.stringify(query)}`);
  }
  return true;
}

async function restoreKeywordHeader(adb, screen, query) {
  if (!isGlobalShopResultActivity(await topActivity(adb))) return false;
  for (let batch = 0; batch <= 4; batch += 1) {
    const xml = await waitForUiXml(adb, 1);
    if (exactNodeCenter(xml, query, { maxY: 150 })
      && exactNodeCenter(xml, '\u5e97\u94fa', { minY: 100, maxY: 220 })) {
      return true;
    }
    if (batch === 4) break;
    for (let swipeIndex = 0; swipeIndex < 3; swipeIndex += 1) {
      await swipe(adb, screen, 450, 360, 450, 1_360, 300);
      await sleep(250);
    }
  }
  return false;
}

async function submitExactQuery(adb, screen, query, options) {
  await dismissKnownPopups(adb, screen);
  await tap(adb, screen, 300, 90);
  await sleep(1_500);
  await waitForCaptchaClear(adb, options, `search-entry-${query}`);

  let entryXml = '';
  const entryDeadline = Date.now() + 15_000;
  while (Date.now() < entryDeadline) {
    entryXml = await dumpUiXml(adb);
    if (entryXml && /\.ECSearchActivity$/.test(await topActivity(adb))) break;
    await sleep(750);
  }
  if (!entryXml) throw new Error('Search entry UI is unavailable');
  if (/\u7f51\u7edc\u9519\u8bef|\u5f53\u524d\u65e0\u7f51\u7edc/.test(entryXml)) {
    const refresh = exactNodeCenter(entryXml, '\u5237\u65b0');
    if (refresh) await tapActual(adb, refresh);
    await sleep(5_000);
    throw new Error('Search entry reported a transient network error');
  }

  await adb.run('shell', 'input', 'keycombination', '113', '29');
  await sleep(300);
  await adb.run('shell', 'input', 'keyevent', '67');
  await adb.run('shell', 'input', 'text', query);
  await sleep(500);
  await waitForCaptchaClear(adb, options, `search-type-${query}`);
  await verifyTypedQuery(adb, query);
  const readyXml = await waitForUiXml(adb);
  const searchButton = exactNodeCenter(readyXml, '\u641c\u7d22', { maxY: 150 });
  if (searchButton) await tapActual(adb, searchButton);
  else await tap(adb, screen, 837, 77);

  await sleep(Math.max(3_000, options.actionDelayMs));
  const captchaSeen = await waitForCaptchaClear(adb, options, `search-result-${query}`);
  await assertNoLoginBlock(adb);
  await verifyTypedQuery(adb, query);
  const resultXml = await waitForUiXml(adb, 3);
  const hasResultTabs = exactNodeCenter(resultXml, '\u5e97\u94fa', { minY: 100, maxY: 220 })
    || exactNodeCenter(resultXml, '\u9500\u91cf', { minY: 100, maxY: 220 });
  if (!hasResultTabs) {
    const error = new Error(`Search results are not ready for ${JSON.stringify(query)}`);
    if (captchaSeen) error.code = 'DOUYIN_CAPTCHA_RESTARTED';
    throw error;
  }
}

async function searchKeyword(adb, screen, options, state, query) {
  if (!KEYWORDS.includes(query)) throw new Error(`Unexpected search keyword: ${JSON.stringify(query)}`);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await resetAppToMain(adb, screen, options, state);
      await attachCollector(adb, options, state);
      await submitExactQuery(adb, screen, query, options);
      await waitForCaptchaClear(adb, options, `search-submit-${query}`);
      process.stdout.write(`[search] exact keyword=${JSON.stringify(query)} verified\n`);
      return;
    } catch (error) {
      if (error?.code === 'DOUYIN_CAPTCHA_RESTARTED') throw error;
      lastError = error;
      process.stdout.write(`[search] retry=${attempt} keyword=${JSON.stringify(query)} reason=${error.message}\n`);
      if (attempt < 3) await sleep(3_000);
    }
  }
  throw lastError;
}

async function collectKeyword(adb, screen, options, state, query) {
  const before = targetProductCount(options.db, query);
  if (await restoreKeywordHeader(adb, screen, query)) {
    await ensureCollector(adb, options, state);
    process.stdout.write(`[search] resume current keyword=${JSON.stringify(query)}\n`);
  } else {
    await searchKeyword(adb, screen, options, state, query);
  }
  let previous = before;
  let idle = 0;

  for (let index = 0; index < options.maxScrolls && !collectionShouldStop(options, state); index += 1) {
    await waitForCaptchaClear(adb, options, `collect-${query}-${index + 1}`);
    await ensureCollector(adb, options, state);
    await sleep(800);
    const current = targetProductCount(options.db, query);
    const added = current - previous;
    idle = added > 0 ? 0 : idle + 1;
    previous = current;
    process.stdout.write(`[collect] ${query} scroll=${index + 1} valid=${current} delta=${added} idle=${idle}\n`);
    // Search results render many cards from an in-memory page. Reaching the
    // next network page can require substantially more than seven swipes.
    if (idle >= 6 && index >= 9) break;
    await swipe(adb, screen, 450, 1360, 450, 420, 700);
    await sleep(Math.min(options.actionDelayMs, 1_500));
  }
  const after = targetProductCount(options.db, query);
  const restored = await restoreKeywordHeader(adb, screen, query);
  process.stdout.write(`[collect] ${query} search-header-restored=${restored}\n`);
  process.stdout.write(`[collect] ${query} finished added=${after - before} total=${after}\n`);
  return after - before;
}

async function readStoreName(adb) {
  const excluded = /^(?:\u54c1\u724c|\u5546\u54c1|\u5206\u7c7b|\u65b0\u54c1|\u7efc\u5408|\u9500\u91cf|\u4e0a\u65b0|\u4ef7\u683c|\u5355\u5217|\u641c\s*\u7d22)$/;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const xml = await waitForUiXml(adb, 4);
    const candidates = uiNodes(xml).filter((node) => (
      node.text
      && node.top < 150
      && node.left >= 45
      && node.left < 420
      && node.width >= 55
      && node.width <= 360
      && node.text.length <= 60
      && !excluded.test(node.text)
    ));
    candidates.sort((a, b) => a.top - b.top || a.left - b.left || b.text.length - a.text.length);
    if (candidates[0]?.text.trim()) return candidates[0].text.trim();
    await sleep(1_500);
  }
  return '';
}

function isGlobalShopResultActivity(value) {
  const activity = String(value || '');
  return /\.ECSearchActivity$/.test(activity)
    || (/\.ShopSearchResultActivity$/.test(activity) && !isStoreSearchActivity(activity));
}

async function returnToShopResults(adb, options, context) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await waitForCaptchaClear(adb, options, context);
    const current = await topActivity(adb);
    if (isGlobalShopResultActivity(current)) {
      await sleep(Math.min(options.actionDelayMs, 4_000));
      return true;
    }
    await adb.try('shell', 'input', 'keyevent', '4');
    await sleep(2_500);
  }
  return false;
}

async function openShopTab(adb, options, query) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const xml = await waitForUiXml(adb, 4);
    const shopTab = exactNodeCenter(xml, '\u5e97\u94fa', { minY: 100, maxY: 220 });
    if (!shopTab) throw new Error(`Shop tab is unavailable for ${JSON.stringify(query)}`);
    await tapActual(adb, shopTab);
    await sleep(options.actionDelayMs);
    await waitForCaptchaClear(adb, options, `shop-tab-${query}`);
    await verifyTypedQuery(adb, query);
    const raw = await captureRawScreen(adb);
    const buttons = detectStoreEntryButtons(raw);
    if (buttons.length) {
      process.stdout.write(`[shops] ${query} tab ready buttons=${buttons.length}\n`);
      return buttons;
    }
    process.stdout.write(`[shops] ${query} tab retry=${attempt} no entry buttons\n`);
  }
  throw new Error(`Shop results did not expose any entry button for ${JSON.stringify(query)}`);
}

async function submitStoreQuery(adb, options, query, shopName) {
  const storeXml = await waitForUiXml(adb, 4);
  const searchBar = uiNodes(storeXml).find((node) => (
    node.top < 130
    && node.left > 180
    && node.width > 350
    && /(?:TextView|EditText)$/.test(node.className)
  ));
  if (!searchBar) {
    process.stdout.write(`[store] ${shopName} no in-store search bar; using product tab\n`);
    return false;
  }

  await tapActual(adb, searchBar);
  await sleep(1_200);
  const entryXml = await waitForUiXml(adb, 4);
  const input = uiNodes(entryXml).find((node) => (
    node.top < 130 && node.className.endsWith('EditText') && node.width > 300
  ));
  if (!input) {
    process.stdout.write(`[store] ${shopName} search input unavailable\n`);
    return false;
  }
  let typed = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await tapActual(adb, input);
    await adb.run('shell', 'input', 'keycombination', '113', '29');
    await sleep(350);
    await adb.run('shell', 'input', 'keyevent', '67');
    await adb.run('shell', 'input', 'text', query);
    await sleep(600);
    const typedXml = await waitForUiXml(adb, 3);
    if (exactNodeCenter(typedXml, query, { maxY: 150 })) {
      typed = true;
      break;
    }
    process.stdout.write(`[store] ${shopName} type retry=${attempt} keyword=${JSON.stringify(query)}\n`);
  }
  if (!typed) throw new Error(`Search field did not contain the exact keyword ${JSON.stringify(query)}`);

  const readyXml = await waitForUiXml(adb, 3);
  const searchButton = exactNodeCenter(readyXml, '\u641c\u7d22', { maxY: 140 });
  if (!searchButton) throw new Error(`In-store search button is unavailable in ${shopName}`);
  await tapActual(adb, searchButton);
  await sleep(options.actionDelayMs);
  await waitForCaptchaClear(adb, options, `store-search-${query}-${shopName}`);
  const current = await topActivity(adb);
  const opened = isStoreSearchActivity(current);
  process.stdout.write(`[store] ${shopName} exact keyword=${JSON.stringify(query)} search=${opened ? 'ready' : 'fallback'}\n`);
  return opened;
}

async function storeViewportKey(adb) {
  const raw = await captureRawScreen(adb);
  const hash = createHash('sha1');
  for (let y = 180; y < raw.height; y += 32) {
    for (let x = 20; x < raw.width - 20; x += 32) {
      const offset = ((y * raw.width) + x) * 4;
      hash.update(Buffer.from([
        raw.pixels[offset] >> 5,
        raw.pixels[offset + 1] >> 5,
        raw.pixels[offset + 2] >> 5,
      ]));
    }
  }
  return hash.digest('hex');
}

async function visibleStoreKeywordTitles(adb, keyword) {
  const xml = await waitForUiXml(adb, 3);
  const byText = new Map();
  for (const node of uiNodes(xml)) {
    const value = node.text || node.description;
    if (!matchesKeyword(value, keyword)) continue;
    if (node.top < 180 || node.top > 1_520 || node.width < 180 || node.height < 20) continue;
    const key = normalizedProductText(value);
    const previous = byText.get(key);
    if (!previous || node.width > previous.width) byText.set(key, { ...node, value });
  }
  return [...byText.values()].sort((a, b) => a.y - b.y);
}

async function shareStoreProduct(adb, screen, options, state, query, shopName, titleNode) {
  const signature = `${query}\u0000${normalizedProductText(shopName)}\u0000${normalizedProductText(titleNode.value)}`;
  if (state.storeTitleAttempts.has(signature)) return { status: 'attempted' };
  state.storeTitleAttempts.add(signature);

  await ensureCollector(adb, options, state);
  const openedAt = Date.now() - 250;
  await tapActual(adb, titleNode);
  const productId = await waitForStoreProduct(adb, options.db, openedAt, 15_000);
  await waitForCaptchaClear(adb, options, `store-product-${query}`);
  if (!productId) {
    await returnToStoreList(adb, options, `store-card-miss-${query}`);
    return { status: 'not_product' };
  }

  await sleep(5_000);
  const product = productRow(options.db, productId);
  if (!matchesKeyword(product?.product_name, query)) {
    await returnToStoreList(adb, options, `store-card-nonmatch-${query}`);
    return { status: 'nonmatch', productId };
  }
  if (!rowIsComplete(product)) {
    await returnToStoreList(adb, options, `store-card-incomplete-${query}`);
    return { status: 'incomplete', productId };
  }
  const existing = linkedUrl(options.db, productId);
  if (existing) {
    await returnToStoreList(adb, options, `store-card-linked-${query}`);
    return { status: 'duplicate', productId, shareUrl: existing };
  }

  await tap(adb, screen, 807, 69);
  await sleep(5_000);
  await waitForCaptchaClear(adb, options, `store-share-${query}-${productId}`);
  await tapCopyLink(adb, screen);
  const shareUrl = await waitForLinkedUrl(options.db, productId, 15_000);
  if (!shareUrl) {
    const diagnostic = path.join(ROOT, 'output', 'diagnostics', `store-share-${productId}.png`);
    await captureScreenshot(adb, diagnostic).catch(() => {});
    process.stdout.write(`[share] store product=${productId} blocked screenshot=${diagnostic}\n`);
    await adb.try('shell', 'input', 'keyevent', '4');
    await returnToStoreList(adb, options, `store-share-blocked-${query}`);
    return { status: 'share_blocked', productId };
  }

  process.stdout.write(`[share] store=${JSON.stringify(shopName)} product=${productId} ${shareUrl}\n`);
  await returnToStoreList(adb, options, `store-share-return-${query}`);
  await sleep(options.actionDelayMs);
  return { status: 'linked', productId, shareUrl };
}

async function shareVisibleStoreProducts(adb, screen, options, state, query, shopName) {
  if (options['collect-only'] || !state.uiShareFallbackActive) return;
  const titles = await visibleStoreKeywordTitles(adb, query);
  for (const titleNode of titles) {
    if (state.stopRequested) break;
    if (options.target > 0 && linkedCompleteCount(options.db) >= options.target) break;
    const result = await shareStoreProduct(adb, screen, options, state, query, shopName, titleNode);
    process.stdout.write(
      `[share] store=${JSON.stringify(shopName)} keyword=${query} status=${result.status} linked=${linkedCompleteCount(options.db)}\n`,
    );
  }
}

async function collectStoreKeyword(adb, screen, options, state, query, shopName) {
  await ensureCollector(adb, options, state);
  const before = targetProductCount(options.db, query);
  await sleep(options.actionDelayMs);
  await shareVisibleStoreProducts(adb, screen, options, state, query, shopName);
  let searched = false;
  try {
    searched = await submitStoreQuery(adb, options, query, shopName);
  } catch (error) {
    if (error.code === 'DOUYIN_CAPTCHA_REQUIRED') throw error;
    process.stdout.write(`[store] ${shopName} search fallback reason=${error.message}\n`);
  }
  if (!searched && isStoreSearchActivity(await topActivity(adb))) {
    await adb.try('shell', 'input', 'keyevent', '4');
    await sleep(3_000);
  }

  let previous = targetProductCount(options.db, query);
  let previousViewport = '';
  let stableViews = 0;
  for (let index = 0; index < options.storeScrolls && !collectionShouldStop(options, state); index += 1) {
    await ensureCollector(adb, options, state);
    await waitForCaptchaClear(adb, options, `store-scroll-${query}-${shopName}`);
    const currentActivity = await topActivity(adb);
    if (!isStoreListActivity(currentActivity)) break;
    await shareVisibleStoreProducts(adb, screen, options, state, query, shopName);
    const current = targetProductCount(options.db, query);
    const added = current - previous;
    previous = current;
    const viewport = await storeViewportKey(adb);
    stableViews = viewport === previousViewport ? stableViews + 1 : 0;
    previousViewport = viewport;
    process.stdout.write(
      `[store] ${query} shop=${JSON.stringify(shopName)} scroll=${index + 1} matched=${current} delta=${added} stable=${stableViews}\n`,
    );
    if (stableViews >= 3 && index >= 3) break;
    await swipe(adb, screen, 450, 1360, 450, 410, 750);
    await sleep(Math.min(options.actionDelayMs, 2_000));
  }

  const after = targetProductCount(options.db, query);
  process.stdout.write(
    `[store] ${query} shop=${JSON.stringify(shopName)} finished searched=${searched} added=${after - before}\n`,
  );
  return after - before;
}

async function enterStoreButton(adb, screen, options, state, query, button) {
  const enteredAt = Date.now() - 250;
  await tapActual(adb, button);
  await sleep(options.actionDelayMs);
  await waitForCaptchaClear(adb, options, `enter-store-${query}`);
  const current = await topActivity(adb);

  if (/LiveDummyActivity|\.live\./i.test(current)) {
    process.stdout.write(`[shops] ${query} entry opened live; skipped\n`);
    await returnToShopResults(adb, options, `leave-live-${query}`);
    return { status: 'live', newShop: false };
  }
  if (!current.endsWith('/com.bytedance.android.shopping.store.arch.ECStoreActivity')) {
    process.stdout.write(`[shops] ${query} entry opened ${current || 'unknown'}; skipped\n`);
    await returnToShopResults(adb, options, `leave-unexpected-${query}`);
    return { status: 'unexpected', newShop: false };
  }

  await ensureCollector(adb, options, state);
  await sleep(Math.max(1_500, Math.min(options.actionDelayMs, 3_000)));
  const shopName = await readStoreName(adb)
    || observedShopName(options.db, enteredAt)
    || `shop-${button.fingerprint.slice(0, 12)}`;
  const key = `${query}\u0000${normalizedProductText(shopName)}`;
  if (state.visitedShopKeywords.has(key)) {
    process.stdout.write(`[shops] ${query} duplicate shop=${JSON.stringify(shopName)}\n`);
    await returnToShopResults(adb, options, `leave-duplicate-${query}`);
    return { status: 'duplicate', newShop: false, shopName };
  }

  process.stdout.write(`[shops] ${query} enter shop=${JSON.stringify(shopName)}\n`);
  await collectStoreKeyword(adb, screen, options, state, query, shopName);
  state.visitedShopKeywords.add(key);
  const returned = await returnToShopResults(adb, options, `leave-store-${query}-${shopName}`);
  if (!returned) throw new Error(`Could not return to shop results after ${shopName}`);
  return { status: 'collected', newShop: true, shopName };
}

async function expandKeywordShops(adb, screen, options, state, query) {
  const canReuseResults = await restoreKeywordHeader(adb, screen, query);
  if (canReuseResults) {
    process.stdout.write(`[search] reuse keyword=${JSON.stringify(query)} for shop expansion\n`);
  } else {
    await searchKeyword(adb, screen, options, state, query);
  }
  await openShopTab(adb, options, query);
  const attemptedHeaders = new Set();
  let idlePages = 0;
  let collectedShops = 0;

  for (let page = 0; page < options.shopScrolls && !collectionShouldStop(options, state); page += 1) {
    await ensureCollector(adb, options, state);
    await waitForCaptchaClear(adb, options, `shop-page-${query}-${page + 1}`);
    if (!isGlobalShopResultActivity(await topActivity(adb))) {
      if (!await returnToShopResults(adb, options, `recover-shop-page-${query}`)) break;
    }

    let pageNew = 0;
    const attemptedSlots = new Set();
    let buttons = detectStoreEntryButtons(await captureRawScreen(adb))
      .filter((button) => !attemptedHeaders.has(button.fingerprint));
    process.stdout.write(`[shops] ${query} page=${page + 1} unvisited-buttons=${buttons.length}\n`);

    while (buttons.length) {
      if (collectionShouldStop(options, state)) break;
      const button = buttons[0];
      attemptedHeaders.add(button.fingerprint);
      attemptedSlots.add(Math.round(button.y / 80));
      const result = await enterStoreButton(adb, screen, options, state, query, button);
      if (result.newShop) {
        pageNew += 1;
        collectedShops += 1;
      }
      await sleep(Math.min(options.actionDelayMs, 5_000));
      if (!isGlobalShopResultActivity(await topActivity(adb))) break;
      buttons = detectStoreEntryButtons(await captureRawScreen(adb)).filter((candidate) => (
        !attemptedHeaders.has(candidate.fingerprint)
        && !attemptedSlots.has(Math.round(candidate.y / 80))
      ));
    }

    idlePages = pageNew > 0 ? 0 : idlePages + 1;
    process.stdout.write(
      `[shops] ${query} page=${page + 1} new=${pageNew} total-shops=${collectedShops} idle-pages=${idlePages}\n`,
    );
    if (idlePages >= options.shopIdlePages && page >= options.shopIdlePages) break;
    await swipe(adb, screen, 450, 1380, 450, 360, 850);
    await sleep(options.actionDelayMs);
  }

  process.stdout.write(
    `[shops] ${query} exhausted shops=${collectedShops} matched-products=${targetProductCount(options.db, query)}\n`,
  );
  return collectedShops;
}

async function captureScreenshot(adb, localPath) {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const remote = '/sdcard/android-only-diagnostic.png';
  await adb.run('shell', 'screencap', '-p', remote);
  await adb.pull(remote, localPath);
  await adb.try('shell', 'rm', '-f', remote);
}

function rowIsComplete(row) {
  return Boolean(
    String(row?.product_id || '').trim()
    && String(row?.product_name || '').trim()
    && String(row?.shop_name || '').trim()
    && String(row?.price || '').trim()
    && String(row?.price) !== '0'
    && String(row?.sales || '').trim(),
  );
}

async function returnToResults(adb) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await topActivity(adb);
    if (current.endsWith(`/${MAIN_ACTIVITY}`)) return;
    await adb.try('shell', 'input', 'keyevent', '4');
    await sleep(2_000);
  }
}

async function shareVisibleProduct(adb, screen, options, state, x, y) {
  await ensureCollector(adb, options, state);
  const openedAt = Date.now() - 250;
  await tap(adb, screen, x, y);
  const productId = await waitForNavigationProduct(adb, options.db, openedAt);
  await waitForCaptchaClear(adb, options, 'share-product-open');
  if (!productId) {
    await returnToResults(adb);
    return { status: 'not_product' };
  }
  if (!state.uiFallbackProductIds.has(productId)) {
    await returnToResults(adb);
    return { status: 'not_api_failure', productId };
  }

  await sleep(6_000);
  const product = productRow(options.db, productId);
  if (!rowIsComplete(product)) {
    await returnToResults(adb);
    return { status: 'incomplete', productId };
  }
  const existing = linkedUrl(options.db, productId);
  if (existing) {
    await returnToResults(adb);
    return { status: 'duplicate', productId, shareUrl: existing };
  }

  await tap(adb, screen, 807, 69);
  await sleep(5_000);
  await waitForCaptchaClear(adb, options, `share-${productId}`);
  await tapCopyLink(adb, screen);
  const shareUrl = await waitForLinkedUrl(options.db, productId);
  if (!shareUrl) {
    const diagnostic = path.join(ROOT, 'output', 'diagnostics', `share-blocked-${productId}.png`);
    await captureScreenshot(adb, diagnostic).catch(() => {});
    await adb.try('shell', 'input', 'keyevent', '4');
    await sleep(1_000);
    await adb.try('shell', 'input', 'keyevent', '4');
    throw new Error(`Share flow blocked for ${productId}; inspect ${diagnostic}`);
  }

  process.stdout.write(`[share] ${productId} ${shareUrl}\n`);
  await returnToResults(adb);
  return { status: 'linked', productId, shareUrl };
}

async function enrichShares(adb, screen, options, state) {
  const available = completeProductCount(options.db);
  const shareTarget = options.target > 0 ? Math.min(options.target, available) : available;
  process.stdout.write(`[share] complete products=${available} target=${shareTarget}\n`);
  if (shareTarget === 0) return;

  const points = [
    [225, 610],
    [675, 610],
    [225, 1210],
    [675, 1210],
  ];

  for (const query of KEYWORDS) {
    if (linkedCompleteCount(options.db) >= shareTarget || state.stopRequested) break;
    await searchKeyword(adb, screen, options, state, query);
    for (let scrollIndex = 0;
      scrollIndex < options.shareScrolls
      && linkedCompleteCount(options.db) < shareTarget
      && !state.stopRequested;
      scrollIndex += 1) {
      for (const [x, y] of points) {
        if (linkedCompleteCount(options.db) >= shareTarget || state.stopRequested) break;
        const result = await shareVisibleProduct(adb, screen, options, state, x, y);
        const linked = linkedCompleteCount(options.db);
        process.stdout.write(`[share] ${query} scroll=${scrollIndex + 1} status=${result.status} linked=${linked}/${shareTarget}\n`);
      }
      await swipe(adb, screen, 450, 1360, 450, 420, 700);
      await sleep(2_500);
    }
  }
}

function qualityStats(dbPath) {
  return withDatabase(dbPath, (db) => {
    const products = db.prepare(`
      SELECT product_id,
        COALESCE(NULLIF(product_name, ''), title) AS product_name,
        shop_name,
        COALESCE(NULLIF(price, ''), NULLIF(min_price, ''), max_price) AS price,
        sales
      FROM products
    `).all().filter((row) => matchesTargetKeyword(row.product_name));
    const productIds = new Set(products.map((row) => String(row.product_id || '').trim()).filter(Boolean));
    const productEvents = db.prepare(`
      SELECT product_id, product_name, title FROM events WHERE event = 'product_found'
    `).all().filter((row) => (
      matchesTargetKeyword(row.product_name || row.title)
      || productIds.has(String(row.product_id || '').trim())
    ));
    const linked = db.prepare(`
      SELECT DISTINCT product_id FROM product_shares
    `).all().filter((row) => productIds.has(String(row.product_id || '').trim())).length;
    const ids = productEvents.map((row) => String(row.product_id || '').trim()).filter(Boolean);
    return {
      total_products: products.length,
      unique_product_ids: new Set(products.map((row) => row.product_id)).size,
      valid_products: products.filter((row) => (
        String(row.product_name || '').trim()
        && String(row.price || '').trim()
        && String(row.price) !== '0'
      )).length,
      complete_products: products.filter(rowIsComplete).length,
      linked_products: linked,
      duplicate_product_events: Math.max(0, ids.length - new Set(ids).size),
      missing_product_id_events: productEvents.length - ids.length,
      missing_product_name: products.filter((row) => !String(row.product_name || '').trim()).length,
      missing_shop_name: products.filter((row) => !String(row.shop_name || '').trim()).length,
      missing_price: products.filter((row) => !String(row.price || '').trim() || String(row.price) === '0').length,
      missing_sales: products.filter((row) => !String(row.sales || '').trim()).length,
      missing_share_url: products.length - linked,
    };
  });
}

function emptyQualityStats() {
  return {
    total_products: 0,
    unique_product_ids: 0,
    valid_products: 0,
    complete_products: 0,
    linked_products: 0,
    duplicate_product_events: 0,
    missing_product_id_events: 0,
    missing_product_name: 0,
    missing_shop_name: 0,
    missing_price: 0,
    missing_sales: 0,
    missing_share_url: 0,
  };
}

async function exportCsv(options) {
  const args = [
    path.join(COLLECTOR_DIR, 'export.mjs'),
    '--db', options.db,
    '--output', options.output,
    '--keywords', KEYWORDS.join(','),
  ];
  if (!options['collect-only']) args.push('--complete-only');
  if (options.target > 0) args.push('--limit', String(options.target));
  const result = await runFile(process.execPath, args, { timeout: 60_000 });
  process.stdout.write(result.stdout);
  const text = fs.readFileSync(options.output, 'utf8').replace(/^\uFEFF/, '').trim();
  return text ? Math.max(0, text.split(/\r?\n/).length - 1) : 0;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (options.fresh) clearSelectedOutputs(options);
  fs.mkdirSync(path.dirname(options.db), { recursive: true });
  fs.mkdirSync(path.dirname(options.events), { recursive: true });
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.mkdirSync(path.dirname(options.summary), { recursive: true });

  const adb = createAdb(options);
  const reserveMinutes = options['collect-only'] ? 1 : 10;
  const state = {
    collector: null,
    stopRequested: false,
    collectionDeadline: options.timeBudgetMinutes > 0
      ? Date.now() + (Math.max(1, options.timeBudgetMinutes - reserveMinutes) * 60_000)
      : 0,
    collectionStopReason: '',
    visitedShopKeywords: new Set(),
    storeTitleAttempts: new Set(),
    uiShareFallbackActive: false,
    uiFallbackProductIds: new Set(),
  };
  const requestStop = () => { state.stopRequested = true; };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  let runError = null;
  let shortenStats = null;

  try {
    await adb.run('get-state');
    await adb.run('forward', 'tcp:27042', 'tcp:27042');
    if (!options['no-codec-fix']) await applyMuMuCodecFix(adb);
    const screen = await screenSize(adb);
    process.stdout.write(`[device] ${options.serial} ${screen.width}x${screen.height}\n`);
    if (options.timeBudgetMinutes > 0) {
      process.stdout.write(
        `[budget] total=${options.timeBudgetMinutes}m collection=${Math.max(1, options.timeBudgetMinutes - reserveMinutes)}m reserve=${reserveMinutes}m\n`,
      );
    }

    for (const query of KEYWORDS) {
      if (collectionShouldStop(options, state)) break;
      await runWithCaptchaRecovery(
        options,
        state,
        `collect-${query}`,
        () => collectKeyword(adb, screen, options, state, query),
      );
      if (!collectionShouldStop(options, state)) {
        await runWithCaptchaRecovery(
          options,
          state,
          `shops-${query}`,
          () => expandKeywordShops(adb, screen, options, state, query),
        );
      }
    }
    if (!options['collect-only'] && !state.stopRequested) {
      const productIds = targetProductIds(options.db, options.target);
      if (!options['no-short-link']) {
        if (state.collector) {
          await state.collector.close().catch(() => {});
          state.collector = null;
        }
        process.stdout.write(`[shorten] target product_ids=${productIds.length}\n`);
        shortenStats = await shortenProducts({
          dbPath: options.db,
          productIds,
          workers: options.shortenWorkers,
          delayMs: options.shortenDelayMs,
          cachePath: options.shortenCache,
          failurePath: options.shortenFailures,
          onProgress: (progress) => process.stdout.write(
            `[shorten] product=${progress.product_id} status=${progress.status} linked=${progress.linked} failed=${progress.failed}\n`,
          ),
        });
      }

      if (options['share-ui-fallback']) {
        const fallbackIds = options['no-short-link']
          ? productIds.filter((productId) => !linkedUrl(options.db, productId))
          : (shortenStats?.failed_product_ids || []);
        state.uiFallbackProductIds = new Set(fallbackIds);
        state.uiShareFallbackActive = fallbackIds.length > 0;
        if (state.uiShareFallbackActive) {
          process.stdout.write(`[share] UI fallback product_ids=${fallbackIds.length}\n`);
          await runWithCaptchaRecovery(
            options,
            state,
            'share-enrichment',
            () => enrichShares(adb, screen, options, state),
          );
        }
      }
    }
  } catch (error) {
    runError = error;
  } finally {
    if (state.collector) await state.collector.close().catch(() => {});
  }

  const hasDatabase = fs.existsSync(options.db);
  const stats = hasDatabase ? qualityStats(options.db) : emptyQualityStats();
  let csvRows = 0;
  if (hasDatabase) {
    csvRows = await exportCsv(options);
  } else {
    fs.writeFileSync(
      options.output,
      '\uFEFF"product_id","product_name","shop_name","price","sales","share_url"\r\n',
      'utf8',
    );
  }
  const fullDataComplete = stats.total_products > 0
    && stats.missing_product_name === 0
    && stats.missing_shop_name === 0
    && stats.missing_price === 0
    && stats.missing_sales === 0
    && stats.missing_share_url === 0;
  const summary = {
    mode: 'android-only',
    package: options.package,
    serial: options.serial,
    keywords: KEYWORDS,
    target: options.target,
    time_budget_minutes: options.timeBudgetMinutes,
    collection_stop_reason: state.collectionStopReason,
    csv_rows: csvRows,
    completed: !runError && (
      options.target > 0
        ? csvRows >= options.target
        : (options['collect-only'] || fullDataComplete)
    ),
    error: runError ? String(runError.stack || runError) : '',
    shortener: shortenStats,
    ...stats,
    db: options.db,
    events: options.events,
    output: options.output,
    finished_at: new Date().toISOString(),
  };
  fs.writeFileSync(options.summary, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (runError) throw runError;
  if (!options['collect-only'] && !summary.completed) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`[android-only-cli] ${error?.stack || error}\n`);
  process.exitCode = 1;
});
