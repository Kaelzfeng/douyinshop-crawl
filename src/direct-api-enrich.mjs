/**
 * Direct H5 pack API enrichment — calls the Douyin product detail API
 * using a_bogus signing, completely bypassing browser and Python.
 *
 * Replaces the Python tools/enrich_csv_h5.py → ABogusSigner → fetch_h5_product_details
 * pipeline with a pure Node.js implementation.
 *
 * Usage:
 *   import { fetchH5Detail, fetchH5DetailBatch } from './direct-api-enrich.mjs';
 *   const product = await fetchH5Detail('3752273946104430948', signer);
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Known API endpoint (from verify_h5_api.py)
const ENDPOINT_ORIGIN = 'https://haohuo.jinritemai.com';
const ENDPOINT_PATH = '/aweme/v2/shop/promotion/pack/h5/';
const ENDPOINT_URL = `${ENDPOINT_ORIGIN}${ENDPOINT_PATH}`;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Template loading (from Playwright capture JSON)
// ---------------------------------------------------------------------------

/**
 * Load the H5 pack API template from the newest sign-capture JSON.
 * Returns the unsigned query, body, and old product_id to replace.
 *
 * @returns {Promise<{query: string, body: string, oldId: string}>}
 */
async function loadTemplate() {
  const capturesDir = path.join(ROOT, 'output', 'playwright');
  let captures;
  try {
    captures = (await fs.promises.readdir(capturesDir))
      .filter((f) => f.startsWith('sign-capture-') && f.endsWith('.json'))
      .map((f) => path.join(capturesDir, f));
  } catch {
    throw new Error(
      `No sign-capture JSON found in ${capturesDir}. ` +
      `Run tools/capture-sign-tuple.mjs first to capture a template.`,
    );
  }

  if (!captures.length) {
    throw new Error('No sign-capture JSON files found.');
  }

  // Pick newest by mtime
  let newest = captures[0];
  let newestMtime = (await fs.promises.stat(newest)).mtimeMs;
  for (const f of captures.slice(1)) {
    const mtime = (await fs.promises.stat(f)).mtimeMs;
    if (mtime > newestMtime) { newest = f; newestMtime = mtime; }
  }

  const capture = JSON.parse(await fs.promises.readFile(newest, 'utf8'));

  // Extract template using the same logic as verify_h5_api.py
  for (const item of capture.transformations || []) {
    if (item.identity !== `POST ${ENDPOINT_URL}`) continue;
    const unsignedUrl = item.unsignedUrl;
    const signedUrl = item.signedUrl;
    const body = item.body;
    if (!unsignedUrl || !signedUrl || !body) continue;

    try {
      const unsigned = new URL(unsignedUrl);
      const signed = new URL(signedUrl);

      if (unsigned.pathname !== ENDPOINT_PATH) continue;
      if (signed.pathname !== ENDPOINT_PATH) continue;

      // Extract old product_id from body
      const params = new URLSearchParams(body);
      const oldId = params.get('promotion_ids') || params.get('ec_promotion_id') || '';
      if (!oldId) continue;

      return {
        query: unsigned.searchParams.toString(),
        body,
        oldId,
      };
    } catch { continue; }
  }

  throw new Error('No valid H5 pack API template found in capture.');
}

// ---------------------------------------------------------------------------
// Cached template (loaded once, reused)
// ---------------------------------------------------------------------------

let _templatePromise = null;

async function getTemplate() {
  if (!_templatePromise) {
    _templatePromise = loadTemplate().catch((e) => {
      _templatePromise = null; // Allow retry
      throw e;
    });
  }
  return _templatePromise;
}

// ---------------------------------------------------------------------------
// H5 API fetch
// ---------------------------------------------------------------------------

/**
 * Replace the old product_id in the template body with a new one.
 */
function replaceProductId(body, oldId, newId) {
  let result = body.split(oldId).join(newId);
  const params = new URLSearchParams(result);
  for (const key of ['promotion_ids', 'promotion_id', 'product_id', 'ec_promotion_id']) {
    if (params.has(key)) params.set(key, newId);
  }
  // Ensure promotion_ids exists
  if (!params.has('promotion_ids')) params.set('promotion_ids', newId);
  return params.toString();
}

/**
 * Parse the H5 API response into a product record.
 */
function parseH5Response(payload, productId) {
  const ph = payload.promotion_h5 || {};
  const basic = ph.basic_info_data || {};
  const titleInfo = basic.title_info || {};
  const shopBasic = ((ph.shop_info || {}).basic_info || {});

  // Price extraction
  let price = '';
  const priceInfo = basic.price_info || {};
  for (const sectionName of ['discount_price', 'price', 'market_price']) {
    const section = priceInfo[sectionName];
    if (section && typeof section === 'object') {
      const minPrice = section.min_price || section.price;
      if (minPrice) {
        const minYuan = Number(minPrice) / 100;
        const maxPrice = section.max_price;
        if (maxPrice && maxPrice !== minPrice) {
          price = `${minYuan}-${Number(maxPrice) / 100}`;
        } else {
          price = String(minYuan);
        }
        break;
      }
    }
  }

  // Sales extraction
  let sales = '';
  const salesVal = basic.sales || basic.sales_desc || basic.sale_num || '';
  if (salesVal) sales = String(salesVal).endsWith('件') ? String(salesVal) : `${salesVal}件`;

  return {
    商品id: productId,
    商品品名: String(titleInfo.title || basic.title || basic.name || '').trim(),
    店铺名: String(shopBasic.shop_name || '').trim(),
    价格: price,
    销量: sales,
    分享的链接: `https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=${productId}&origin_type=3002070010&h5_origin_type=detail_share_funshopping`,
    _source: 'direct-api',
  };
}

/**
 * Fetch product details via the H5 pack API using a_bogus signing.
 *
 * @param {string} productId
 * @param {object} signer — a_bogus signer with sign(query, body) method
 * @param {number} [timeoutMs=20_000]
 * @returns {Promise<object>} product record
 */
export async function fetchH5Detail(productId, signer, timeoutMs = 20_000) {
  const { query, body: templateBody, oldId } = await getTemplate();
  const body = replaceProductId(templateBody, oldId, String(productId));

  // Sign
  const aBogus = await signer.sign(query, body);
  const signedQuery = `${query}&a_bogus=${encodeURIComponent(aBogus)}`;

  const fullUrl = `${ENDPOINT_URL}?${signedQuery}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': ENDPOINT_ORIGIN,
        'Referer': `${ENDPOINT_ORIGIN}/`,
        'User-Agent': DEFAULT_USER_AGENT,
      },
      body,
      signal: controller.signal,
      redirect: 'manual',
    });

    const raw = Buffer.from(await response.arrayBuffer()).toString('utf8');

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error(`H5 API returned non-JSON (HTTP ${response.status}, ${raw.length} bytes)`);
    }

    if (payload.status_code !== 0) {
      const msg = payload.msg || payload.message || 'unknown error';
      throw new Error(`H5 API error: status_code=${payload.status_code} msg=${msg}`);
    }

    return parseH5Response(payload, String(productId));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Batch-fetch multiple product details via the H5 pack API.
 *
 * @param {string[]} productIds
 * @param {object} signer — a_bogus signer (supports signBatch for speed)
 * @param {object} [opts]
 * @param {number} [opts.delayMs=400] — delay between requests
 * @param {number} [opts.jitterMs=300] — random jitter added to delay
 * @returns {Promise<object[]>} product records (null for failed fetches)
 */
export async function fetchH5DetailBatch(productIds, signer, { delayMs = 400, jitterMs = 300 } = {}) {
  const { query, body: templateBody, oldId } = await getTemplate();
  const results = [];
  const useSignBatch = typeof signer.signBatch === 'function';

  // Pre-sign all bodies in one roundtrip if supported
  let signatures = [];
  if (useSignBatch) {
    const batch = productIds.map((pid) => {
      const body = replaceProductId(templateBody, oldId, String(pid));
      return { query, body };
    });
    signatures = await signer.signBatch(batch);
  }

  for (let i = 0; i < productIds.length; i++) {
    const pid = String(productIds[i]);

    try {
      const body = replaceProductId(templateBody, oldId, pid);

      let aBogus;
      if (useSignBatch) {
        aBogus = signatures[i];
      } else {
        aBogus = await signer.sign(query, body);
      }

      const signedQuery = `${query}&a_bogus=${encodeURIComponent(aBogus)}`;
      const fullUrl = `${ENDPOINT_URL}?${signedQuery}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);

      let result;
      try {
        const response = await fetch(fullUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': ENDPOINT_ORIGIN,
            'Referer': `${ENDPOINT_ORIGIN}/`,
            'User-Agent': DEFAULT_USER_AGENT,
          },
          body,
          signal: controller.signal,
          redirect: 'manual',
        });

        const raw = Buffer.from(await response.arrayBuffer()).toString('utf8');
        const payload = JSON.parse(raw);

        if (payload.status_code === 0) {
          result = parseH5Response(payload, pid);
        }
      } finally {
        clearTimeout(timer);
      }

      results.push(result);
    } catch (e) {
      console.warn(`[direct-api] batch enrich failed for ${pid}: ${e.message.slice(0, 60)}`);
      results.push(null);
    }

    // Rate-limit between requests
    if (i + 1 < productIds.length && delayMs > 0) {
      const jitter = Math.floor(Math.random() * jitterMs);
      await sleep(delayMs + jitter);
    }
  }

  return results;
}
