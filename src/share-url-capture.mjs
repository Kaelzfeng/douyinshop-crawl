/**
 * Multi-source product URL capture orchestrator.
 *
 * Races all available capture sources in parallel, scores results by
 * data completeness, and returns the best URL + product metadata.
 *
 * Priority (scoring):
 *   10 : haohuo URL with goods_detail — self-contained, never expires
 *    8 : haohuo URL with product_id — resolvable via browser or H5
 *    7 : OkHttp/FastJson response body with title + product_id
 *    5 : v.douyin.com short link — may expire, needs browser resolution
 *    3 : product_id only — needs H5 pack enrichment
 *
 * Usage from any crawler path:
 *   const capture = await captureProductUrl({ device, screen, fridaCapture, enricher, previousUrl });
 *   const product = await enrichFromAnySource({ productId: capture.productId, url: capture.url, enricher });
 */

import {
  copyCurrentProductShareLink,
} from './android.mjs';
import {
  extractAnyProductUrl,
  readCurrentDouyinShareUrl,
  waitForDouyinShareUrl,
} from './clipboard.mjs';
import {
  enrichFromHaohuoUrl,
  normalizeProductUrl,
} from './enrich.mjs';
import { scoreProductUrl } from './frida-capture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// buildHaohuoLink — construct stable long URL from product_id
// ---------------------------------------------------------------------------

/**
 * Build a stable haohuo.jinritemai.com product URL from available data.
 * The resulting URL is durable (doesn't expire like v.douyin.com short links)
 * and carries goods_detail inline when enough data is available.
 *
 * @param {object} opts
 * @param {string} opts.productId
 * @param {string} [opts.title]
 * @param {string} [opts.sales]
 * @param {number|null} [opts.minPriceFen]
 * @param {number|null} [opts.maxPriceFen]
 * @param {string} [opts.rawUrl]
 * @returns {string}
 */
export function buildHaohuoLink({ productId, title = '', sales = '', minPriceFen = null, maxPriceFen = null, rawUrl = '' }) {
  // If we already have a haohuo URL with goods_detail, return it as-is
  if (rawUrl && /haohuo\.jinritemai\.com/.test(rawUrl) && /goods_detail|id=/.test(rawUrl)) {
    return rawUrl.startsWith('http') ? rawUrl : decodeURIComponent(rawUrl);
  }
  if (!productId) return rawUrl || '';

  const u = new URL('https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html');
  u.searchParams.set('id', String(productId));
  u.searchParams.set('origin_type', '3002070010');
  u.searchParams.set('h5_origin_type', 'detail_share_funshopping');

  if (title || sales || minPriceFen != null) {
    const goods = {
      title: title || '',
      sales: sales ? Number(String(sales).replace(/[^\d.]/g, '')) || sales : 0,
      min_price: minPriceFen ?? 0,
      max_price: maxPriceFen ?? minPriceFen ?? 0,
    };
    u.searchParams.set('goods_detail', JSON.stringify(goods));
  }
  return u.toString();
}

// ---------------------------------------------------------------------------
// captureProductUrl — main orchestrator
// ---------------------------------------------------------------------------

/**
 * Capture a product URL from ALL available sources, racing in parallel.
 * The highest-scoring result wins.
 *
 * Three race groups fire simultaneously:
 *   Group 1 (15s): Frida waitForAnyProductUrl — intercepts network/clipboard/WebView
 *   Group 2 (10s): ADB clipboard + Windows clipboard polling
 *   Group 3 (12s): Traditional share button click → clipboard
 *
 * @param {object} opts
 * @param {object} opts.device         — Playwright/ADB device handle
 * @param {object} opts.screen         — { width, height }
 * @param {object} [opts.fridaCapture] — Frida capture instance (may be null)
 * @param {object} [opts.enricher]     — Browser enricher (may be null; only for scoring)
 * @param {string} [opts.previousUrl]  — Previous product URL to avoid re-capture
 * @param {number} [opts.timeoutMs=20_000]
 * @returns {Promise<{url: string, productId: string, title: string, price: string, sales: string, score: number, source: string, fridaData?: object}>}
 */
export async function captureProductUrl({
  device,
  screen,
  fridaCapture = null,
  enricher = null,
  previousUrl = null,
  timeoutMs = 20_000,
}) {
  const deadline = Date.now() + timeoutMs;
  let bestResult = null;

  // Helper to consider a result
  function consider(result) {
    if (!result?.url) return;
    const urlNorm = result.url.replace(/\/$/, '');
    const prevNorm = (previousUrl || '').replace(/\/$/, '');
    if (prevNorm && urlNorm === prevNorm) return;

    const scored = scoreProductUrl(result.url, {
      productId: result.productId || '',
      title: result.title || '',
      price: result.price || '',
      sales: result.sales || '',
    });
    scored.source = result.source || 'unknown';
    scored._fridaData = result._responseData || result._fridaData || null;

    if (!bestResult || scored.score > bestResult.score) {
      bestResult = scored;
    }
  }

  // ---- Group 1: Frida (if available) ----
  const fridaPromise = fridaCapture
    ? (async () => {
      try {
        fridaCapture.clearEvents?.();
        const result = await fridaCapture.waitForAnyProductUrl({
          timeoutMs: Math.min(15_000, deadline - Date.now()),
          previousUrl,
        });
        if (result) {
          result.source = result.source || 'frida';
          result._fridaData = result._responseData || null;
          consider(result);
        }
      } catch (e) {
        // Frida may fail; that's OK — other sources will cover
        console.warn(`[capture] Frida source failed: ${e.message.slice(0, 60)}`);
      }
    })()
    : Promise.resolve();

  // ---- Group 2: Clipboard polling (ADB + Windows) ----
  const clipboardPromise = (async () => {
    try {
      const result = await waitForDouyinShareUrl({
        timeoutMs: Math.min(10_000, deadline - Date.now()),
        previousUrl,
        device,
      });
      if (result) {
        consider({ ...result, source: 'clipboard-poll' });
      }
    } catch {
      // Clipboard timeout is expected sometimes
    }
  })();

  // ---- Group 3: Traditional share-click (always available, no Frida needed) ----
  const shareClickPromise = (async () => {
    try {
      const result = await copyCurrentProductShareLink(
        device,
        screen,
        () => waitForDouyinShareUrl({
          timeoutMs: Math.min(18_000, deadline - Date.now()),
          previousUrl,
          device,
        }),
      );
      if (result?.url) {
        consider({ ...result, source: 'share-click' });
      }
    } catch (e) {
      // Share click may fail; other sources may succeed
      console.warn(`[capture] Share-click source failed: ${e.message.slice(0, 60)}`);
    }
  })();

  // Wait for all groups to settle (at least one should produce a result)
  await Promise.allSettled([fridaPromise, clipboardPromise, shareClickPromise]);

  // If we have a good result, return early
  if (bestResult && bestResult.score >= 5) {
    return bestResult;
  }

  // Give Frida one more chance (it may have captured after the first wait)
  if (fridaCapture && deadline - Date.now() > 2_000) {
    try {
      const lateResult = await fridaCapture.waitForAnyProductUrl({
        timeoutMs: Math.min(3_000, deadline - Date.now()),
        previousUrl,
      });
      if (lateResult) {
        lateResult.source = 'frida-late';
        consider(lateResult);
      }
    } catch { /* ignore */ }
  }

  return bestResult; // May be null if all sources failed
}

// ---------------------------------------------------------------------------
// enrichFromAnySource — unified enrichment from any URL/data type
// ---------------------------------------------------------------------------

/**
 * Enrich a product record from whichever source is available.
 * Tries sources in order of efficiency:
 *   1. haohuo URL with goods_detail → parse directly (zero network)
 *   2. haohuo URL → browser enricher
 *   3. Frida response body data → parse directly
 *   4. v.douyin.com short link → browser enricher
 *   5. product_id only → H5 pack enrichment
 *
 * @param {object} opts
 * @param {string} [opts.productId]
 * @param {string} [opts.url]
 * @param {object} [opts.enricher]       — Browser enricher (from createSharePageEnricher)
 * @param {object} [opts.fridaMeta]      — Raw Frida metadata (may contain response body data)
 * @returns {Promise<object>} product record with 商品id, 商品品名, 店铺名, 价格, 销量, 分享的链接
 */
export async function enrichFromAnySource({
  productId = '',
  url = '',
  enricher = null,
  fridaMeta = null,
}) {
  const shareLink = url || '';

  // ---- Step 1: haohuo URL with goods_detail → parse directly (fastest) ----
  if (/haohuo\.jinritemai/.test(shareLink)) {
    const fastResult = enrichFromHaohuoUrl(shareLink);
    if (fastResult) return fastResult;
  }

  // ---- Step 2: Frida response body data (OkHttp/FastJson) ----
  if (fridaMeta?._responseData) {
    const rd = fridaMeta._responseData;
    if (rd.productId || rd.title) {
      return {
        商品id: rd.productId || productId || '',
        商品品名: rd.title || '',
        店铺名: rd.shopName || '',
        价格: rd.price || '',
        销量: rd.sales || '',
        分享的链接: shareLink,
      };
    }
  }

  // ---- Step 3: Browser enrich (haohuo or v.douyin.com) ----
  if (enricher && shareLink) {
    try {
      const enriched = await enricher.enrich(shareLink);
      if (enriched) {
        return {
          ...enriched,
          分享的链接: enriched.分享的链接 || shareLink,
        };
      }
    } catch (e) {
      console.warn(`[enrich] browser enrich failed: ${e.message.slice(0, 60)}`);
    }
  }

  // ---- Step 4: H5 pack enrich from product_id (last resort) ----
  if (productId) {
    try {
      const { enrichOneProductId } = await import('./h5-enrich.mjs');
      const h5Result = await enrichOneProductId(productId, {
        搜索关键词: '',
        商品id: String(productId),
        商品品名: fridaMeta?.title || fridaMeta?.商品品名 || '',
        店铺名: fridaMeta?.shopName || fridaMeta?.店铺名 || '',
        价格: fridaMeta?.price || fridaMeta?.价格 || '',
        销量: fridaMeta?.sales || fridaMeta?.销量 || '',
        分享的链接: shareLink,
      });
      if (h5Result) {
        return {
          ...h5Result,
          分享的链接: h5Result.分享的链接 || shareLink || buildHaohuoLink({ productId }),
        };
      }
    } catch (e) {
      console.warn(`[enrich] H5 pack failed: ${e.message.slice(0, 60)}`);
    }
  }

  // ---- Ultimate fallback: minimal record ----
  return {
    商品id: productId || '',
    商品品名: fridaMeta?.title || fridaMeta?.商品品名 || '',
    店铺名: fridaMeta?.shopName || fridaMeta?.店铺名 || '',
    价格: fridaMeta?.price || fridaMeta?.价格 || '',
    销量: fridaMeta?.sales || fridaMeta?.销量 || '',
    分享的链接: shareLink || (productId ? buildHaohuoLink({ productId }) : ''),
  };
}

/**
 * Shortcut: capture + enrich in one call.
 *
 * @param {object} opts — same as captureProductUrl + enrichFromAnySource combined
 * @returns {Promise<{product: object, capture: object}>}
 */
export async function captureAndEnrich(opts) {
  const capture = await captureProductUrl(opts);
  if (!capture?.url && !capture?.productId) {
    throw new Error('All capture sources failed — no URL or product_id obtained');
  }

  const product = await enrichFromAnySource({
    productId: capture.productId || '',
    url: capture.url || '',
    enricher: opts.enricher,
    fridaMeta: capture._fridaData || capture,
  });

  console.log(
    `[capture] source=${capture.source || 'unknown'} ` +
    `score=${capture.score || 0} ` +
    `url=${String(capture.url || product.分享的链接).slice(0, 50)}`,
  );

  return { product, capture };
}

// ---------------------------------------------------------------------------
// Direct API integration (a_bogus signer + shorten API)
// Lazily loaded — adds zero overhead when not used
// ---------------------------------------------------------------------------

let _aBogusSignerPromise = null;
let _shortenerPromise = null;

async function getABogusSigner() {
  if (!_aBogusSignerPromise) {
    _aBogusSignerPromise = (async () => {
      try {
        const { createABogusSigner } = await import('./a-bogus.mjs');
        return await createABogusSigner();
      } catch (e) {
        console.warn(`[direct-api] a_bogus signer unavailable: ${e.message}`);
        return null;
      }
    })();
  }
  return _aBogusSignerPromise;
}

async function getShortener(fridaEvents = []) {
  if (!_shortenerPromise) {
    _shortenerPromise = (async () => {
      try {
        const signer = await getABogusSigner();
        if (!signer) return null;
        const { createShortener } = await import('./shorten.mjs');
        return await createShortener({ signer, fridaEvents });
      } catch (e) {
        console.warn(`[direct-api] shortener unavailable: ${e.message}`);
        return null;
      }
    })();
  }
  return _shortenerPromise;
}

/**
 * Direct H5 pack API enrichment — uses a_bogus signer to call the product
 * detail API directly, bypassing both browser and Python subprocess.
 *
 * Falls back gracefully if the signer is unavailable.
 *
 * @param {string} productId
 * @returns {Promise<object|null>} product record or null
 */
export async function enrichViaDirectApi(productId) {
  try {
    const signer = await getABogusSigner();
    if (!signer) return null;

    const { default: fetchH5Detail } = await import('./direct-api-enrich.mjs');
    return await fetchH5Detail(productId, signer);
  } catch (e) {
    console.warn(`[direct-api] enrich failed for ${productId}: ${e.message.slice(0, 60)}`);
    return null;
  }
}

/**
 * Shorten a haohuo URL via the direct shorten API.
 * Uses pre-captured template + a_bogus signing.
 *
 * @param {string} haohuoUrl
 * @param {Array<object>} [fridaEvents] — for template discovery
 * @returns {Promise<string>} v.douyin.com short link (or original URL on failure)
 */
export async function shortenViaDirectApi(haohuoUrl, fridaEvents = []) {
  try {
    const shortener = await getShortener(fridaEvents);
    if (!shortener?.template) return haohuoUrl;
    return await shortener.shorten(haohuoUrl);
  } catch (e) {
    console.warn(`[direct-api] shorten failed: ${e.message.slice(0, 60)}`);
    return haohuoUrl;
  }
}

/**
 * Clean up the persistent a_bogus signer (call on process exit).
 */
export async function closeDirectApiSigner() {
  if (_aBogusSignerPromise) {
    try {
      const signer = await _aBogusSignerPromise;
      if (signer) await signer.close();
    } catch { /* ignore */ }
    _aBogusSignerPromise = null;
    _shortenerPromise = null;
  }
}
