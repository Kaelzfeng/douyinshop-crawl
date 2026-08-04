import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SQLiteEventStore } from '../android-only-collector/sqlite-store.mjs';

export const SHORTEN_ENDPOINT = 'https://lf.snssdk.com/shorten/';
export const SHORTEN_USER_AGENT = 'com.ss.android.ugc.livelite/390600';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT_ID_RE = /^\d{16,22}$/;
const SHORT_URL_RE = /^https:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export function officialProductTarget(productId) {
  return `https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=${productId}`;
}

export function normalizeOfficialShortUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  const normalized = url.endsWith('/') ? url : `${url}/`;
  return SHORT_URL_RE.test(normalized) ? normalized : '';
}

export function parseOfficialShortenPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('shorten returned invalid JSON');
  if (payload.code !== 0) {
    throw new Error(`shorten code=${String(payload.code)} message=${String(payload.message || '')}`);
  }
  if (!Array.isArray(payload.data) || !payload.data.length) {
    throw new Error('shorten returned empty data');
  }
  const shortUrl = normalizeOfficialShortUrl(payload.data[0]?.short_url);
  if (!shortUrl) throw new Error(`invalid short_url=${JSON.stringify(payload.data[0]?.short_url || '')}`);
  return shortUrl;
}

export async function shortenProductId(productId, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  maxRetries = 3,
  backoffBaseMs = 500,
  sleepFn = sleep,
} = {}) {
  const normalizedId = String(productId || '').trim();
  if (!PRODUCT_ID_RE.test(normalizedId)) throw new Error(`invalid product_id=${JSON.stringify(normalizedId)}`);
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  const target = officialProductTarget(normalizedId);
  const body = new URLSearchParams({
    targets: target,
    belong: 'douyinecommerce',
    persist: '1',
  }).toString();
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(SHORTEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': SHORTEN_USER_AGENT,
        },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`shorten HTTP ${response.status}: ${text.slice(0, 160)}`);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`shorten returned invalid JSON: ${text.slice(0, 160)}`);
      }
      return parseOfficialShortenPayload(payload);
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) break;
      await sleepFn(backoffBaseMs * (2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `shorten failed after ${maxRetries + 1} attempts for ${normalizedId}: ${String(lastError?.message || lastError)}`,
  );
}

function appendJsonl(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function loadCache(file) {
  const result = new Map();
  if (!fs.existsSync(file)) return result;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const productId = String(row.product_id || '').trim();
      const shareUrl = normalizeOfficialShortUrl(row.share_url);
      if (PRODUCT_ID_RE.test(productId) && shareUrl) result.set(productId, shareUrl);
    } catch {
      // Ignore a partial final line; successful earlier cache rows remain usable.
    }
  }
  return result;
}

function directLinkEvent(productId, shareUrl, runId) {
  return {
    event_id: randomUUID(),
    run_id: runId,
    ts: Date.now(),
    event: 'product_share_linked',
    stage: 'direct_shorten',
    source: 'direct_shorten',
    product_id: productId,
    share_url: shareUrl,
    confidence: 1,
    correlation_reason: 'direct_shorten_product_id',
    raw: {
      endpoint: SHORTEN_ENDPOINT,
      target: officialProductTarget(productId),
      product_id: productId,
      share_url: shareUrl,
    },
  };
}

export async function shortenProducts({
  dbPath,
  productIds,
  workers = 3,
  delayMs = 500,
  timeoutMs = 15_000,
  maxRetries = 3,
  cachePath = path.join(ROOT, 'output', 'official-shorten-cache.jsonl'),
  failurePath = path.join(ROOT, 'output', 'shorten-failures.jsonl'),
  fetchImpl = globalThis.fetch,
  sleepFn = sleep,
  onProgress = () => {},
} = {}) {
  if (!dbPath) throw new Error('dbPath is required');
  const workerCount = Math.max(1, Number(workers) || 1);
  const requestDelayMs = Math.max(0, Number(delayMs) || 0);
  const uniqueIds = [...new Set((productIds || [])
    .map((value) => String(value || '').trim())
    .filter((value) => PRODUCT_ID_RE.test(value)))];
  const runId = `direct-shorten-${Date.now()}`;
  const store = new SQLiteEventStore({ dbPath, runId });
  const cache = loadCache(cachePath);
  const existing = new Map(store.all(`
    SELECT product_id, share_url
    FROM product_shares
    WHERE trim(product_id) <> '' AND trim(share_url) <> ''
    ORDER BY last_seen_ts DESC
  `).map((row) => [String(row.product_id), String(row.share_url)]));
  const pending = uniqueIds.filter((productId) => !existing.has(productId));
  const stats = {
    requested_product_ids: uniqueIds.length,
    skipped_existing: uniqueIds.length - pending.length,
    api_requests: 0,
    cache_hits: 0,
    linked: 0,
    failed: 0,
    failed_product_ids: [],
    cache_path: path.resolve(cachePath),
    failure_path: path.resolve(failurePath),
  };
  let cursor = 0;

  async function runWorker() {
    while (cursor < pending.length) {
      const productId = pending[cursor];
      cursor += 1;
      try {
        let shareUrl = cache.get(productId) || '';
        if (shareUrl) {
          stats.cache_hits += 1;
        } else {
          stats.api_requests += 1;
          shareUrl = await shortenProductId(productId, {
            fetchImpl,
            timeoutMs,
            maxRetries,
            backoffBaseMs: requestDelayMs,
            sleepFn,
          });
          cache.set(productId, shareUrl);
          appendJsonl(cachePath, { product_id: productId, share_url: shareUrl, ts: Date.now() });
        }

        if (!existing.has(productId)) {
          if (!store.record(directLinkEvent(productId, shareUrl, runId))) {
            throw new Error('SQLite rejected direct product/share link');
          }
          existing.set(productId, shareUrl);
          stats.linked += 1;
        }
        onProgress({ status: 'linked', product_id: productId, share_url: shareUrl, ...stats });
      } catch (error) {
        stats.failed += 1;
        stats.failed_product_ids.push(productId);
        appendJsonl(failurePath, {
          ts: Date.now(),
          product_id: productId,
          error: String(error?.stack || error),
        });
        onProgress({ status: 'failed', product_id: productId, error: String(error?.message || error), ...stats });
      }
      if (requestDelayMs > 0 && cursor < pending.length) await sleepFn(requestDelayMs);
    }
  }

  try {
    await Promise.all(Array.from(
      { length: Math.min(workerCount, Math.max(1, pending.length)) },
      () => runWorker(),
    ));
    return stats;
  } finally {
    store.close();
  }
}
