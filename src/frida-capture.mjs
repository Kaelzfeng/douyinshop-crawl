/**
 * Frida-assisted capture for Douyin Mall (livelite).
 * Requires: adb root + frida-server running as root.
 *
 * Prefer hook/capture-share-min.bundle.js (verified on 39.6.0).
 *
 * v2: added waitForAnyProductUrl with multi-source scoring,
 *     response body parsing, WebView URL extraction (2026-07)
 */
import frida from 'frida';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractProductId } from './enrich.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = 'com.ss.android.ugc.livelite';

const BUNDLE_CANDIDATES = [
  path.resolve(__dirname, '..', 'hook', 'capture-semi.bundle.js'),
  path.resolve(__dirname, '..', 'hook', 'capture-share-min.bundle.js'),
  path.resolve(__dirname, '..', 'hook', 'capture-share-api.bundle.js'),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function extractShareUrlFromText(text) {
  const m = String(text || '').match(/https:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/);
  return m ? m[0].replace(/\/?$/, '/') : null;
}

function extractHaohuoUrlFromText(text) {
  const m = String(text || '').match(/https:\/\/haohuo\.jinritemai\.com\/[\w\/%.?&=@!$'()*+,;~-]+/);
  return m ? m[0] : null;
}

function interestingProductBlob(e) {
  const s = JSON.stringify(e || {}).slice(0, 800);
  return /product_id|goods_detail|haohuo|ec_goods|promotion_id|v\.douyin|shorten|ecombdapi|ecom\/product/i.test(s);
}

// ---------------------------------------------------------------------------
// URL scoring — exported for use by share-url-capture.mjs
// ---------------------------------------------------------------------------

/**
 * Score a product URL by data completeness. Higher = more stable / self-contained.
 *
 *  10 : haohuo URL with goods_detail (self-contained, never expires)
 *   8 : haohuo URL with product_id (resolvable)
 *   7 : OkHttp response body with title + product_id
 *   5 : v.douyin.com short link (may expire, needs browser resolution)
 *   3 : raw event with product_id only
 *
 * @param {string} url
 * @param {object} [meta]
 * @returns {{ score: number, url: string, productId?: string, title?: string, price?: string, sales?: string }}
 */
export function scoreProductUrl(url, meta = {}) {
  let score = 0;
  const s = String(url || '');

  if (/goods_detail/.test(s)) {
    score += 10;
  } else if (/haohuo\.jinritemai/.test(s) && /[?&]id=/.test(s)) {
    score += 8;
  } else if (/v\.douyin\.com/.test(s)) {
    score += 5;
  } else if (meta.productId || /product_id=/.test(s)) {
    score += 3;
  }

  if (meta.productId) score += 3;
  if (meta.title) score += 2;
  if (meta.price || meta.sales) score += 1;

  return {
    score,
    url: s,
    productId: meta.productId || '',
    title: meta.title || '',
    price: meta.price || '',
    sales: meta.sales || '',
  };
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function extractFromProductUrl(urlString) {
  try {
    const decoded = safeDecode(urlString);
    const productId = extractProductId(decoded) || '';
    let title = '';
    let sales = '';
    let price = '';
    try {
      const url = new URL(decoded.includes('://') ? decoded : `https://x/?${decoded}`);
      const goodsRaw = url.searchParams.get('goods_detail');
      if (goodsRaw) {
        const goods = JSON.parse(safeDecode(goodsRaw));
        title = String(goods.title || '').trim();
        if (goods.sales) sales = `${goods.sales}件`;
        const minPrice = Number(goods.min_price);
        const maxPrice = Number(goods.max_price);
        if (Number.isFinite(minPrice)) {
          const minYuan = minPrice / 100;
          const maxYuan = maxPrice / 100;
          price = Number.isFinite(maxYuan) && maxYuan !== minYuan ? `${minYuan}-${maxYuan}` : String(minYuan);
        }
      }
      if (!productId) {
        const id = url.searchParams.get('id') || url.searchParams.get('product_id') || '';
        if (id) return { productId: id, title, sales, price, url: urlString };
      }
    } catch {
      /* ignore */
    }
    const m = decoded.match(/product_id=(\d{10,})/);
    return {
      productId: productId || m?.[1] || '',
      title,
      sales,
      price,
      url: urlString,
    };
  } catch {
    return null;
  }
}

function extractProductIdLoose(raw) {
  const s = String(raw || '');
  const patterns = [
    // URL query params (plain)
    /[?&]product_id=(\d{10,})/i,
    /[?&]promotion_id=(\d{10,})/i,
    // 39.6.0: promotion_ids (plural) in query-string body
    /(?:^|[?&])promotion_ids=(\d{10,})/i,
    // URL-encoded JSON: %22product_id%22%3A + digits
    /%22product_id%22%3A(\d{10,})/i,
    // iid param (39.6.0 fallback)
    /[?&]iid=(\d{10,})/i,
    /[?&]id=(\d{10,})/i,
    // haohuo goods_detail encoded path
    /ec_goods_detail[^"]*product_id%3D(\d{10,})/i,
    /ec_goods_detail\?[^"\s]*product_id=(\d{10,})/i,
    /ec_goods_detail\?[^"\s]*promotion_id=(\d{10,})/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return '';
}

// ---------------------------------------------------------------------------
// NEW: Response body extraction (OkHttp, FastJson)
// ---------------------------------------------------------------------------

/**
 * Extract product data from an OkHttp response body JSON string.
 * Handles common API response shapes from Douyin's ecom endpoints.
 */
function extractFromResponseBody(bodyText) {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);

    // Walk common nesting patterns: { data: { ... } }, { result: { ... } }
    const candidates = [
      parsed,
      parsed?.data,
      parsed?.result,
      parsed?.goods,
      parsed?.product,
      parsed?.data?.goods_detail,
      parsed?.data?.product,
      parsed?.result?.goods_detail,
      parsed?.result?.product,
    ].filter(Boolean);

    for (const obj of candidates) {
      if (typeof obj !== 'object') continue;
      const title = obj.title || obj.goods_name || obj.product_name || '';
      const productId = String(
        obj.product_id || obj.goods_id || obj.id || obj.promotion_id || '',
      );
      const minPrice = obj.min_price ?? obj.price_min ?? obj.price;
      const maxPrice = obj.max_price ?? obj.price_max ?? obj.price;
      const sales = obj.sales ?? obj.sold_num ?? obj.sales_volume ?? '';
      const shopName = obj.shop_name || obj.shop_name_str || obj.store_name || '';

      if (productId || title) {
        let price = '';
        if (Number.isFinite(Number(minPrice))) {
          const minYuan = Number(minPrice) / 100;
          const maxYuan = Number(maxPrice) / 100;
          price = Number.isFinite(maxYuan) && maxYuan !== minYuan
            ? `${minYuan}-${maxYuan}` : String(minYuan);
        }
        return {
          productId,
          title,
          price,
          sales: sales ? `${sales}件` : '',
          shopName,
          _source: 'okhttp-response',
        };
      }
    }

    // Fallback: scan raw JSON for product_id pattern
    const str = JSON.stringify(parsed);
    const m = str.match(/"product_id"\s*:\s*"?(\d{15,})"?/);
    if (m) return { productId: m[1], title: '', price: '', sales: '', _source: 'okhttp-response-scan' };

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract product data from a FastJson converter response.
 */
function extractFromFastJsonResponse(bodyText) {
  // Same shape as OkHttp responses; reuse the parser
  return extractFromResponseBody(bodyText);
}

/**
 * Extract product data from WebView-loaded URL.
 */
function extractFromWebViewUrl(urlString) {
  if (!urlString) return null;
  const decoded = safeDecode(urlString);
  if (/haohuo\.jinritemai|goods_detail|product_id/i.test(decoded)) {
    return extractFromProductUrl(decoded);
  }
  return null;
}

/**
 * Extract product data from Intent extras.
 */
function extractFromIntentExtra(name, value) {
  if (!value) return null;
  const decoded = safeDecode(value);
  if (/haohuo\.jinritemai|goods_detail|product_id/i.test(decoded)) {
    return extractFromProductUrl(decoded);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event extraction (existing + new event types)
// ---------------------------------------------------------------------------

function extractFromEvent(payload) {
  if (!payload) return null;

  // ---- clipboard ----
  if (payload.type === 'clipboard') {
    const shortUrl = extractShareUrlFromText(payload.text);
    const longUrl = extractHaohuoUrlFromText(payload.text);
    const url = longUrl || shortUrl;
    if (url) {
      return {
        productId: extractProductIdLoose(payload.text) || payload.extractedProductId || '',
        title: '', sales: '', price: '',
        url,
        source: 'clipboard',
      };
    }
    return null;
  }

  // ---- form-field (shorten targets) ----
  if (payload.type === 'form-field' && payload.name === 'targets' && payload.value) {
    const data = extractFromProductUrl(payload.value) || {};
    const productId = data.productId || extractProductIdLoose(payload.value);
    if (productId || data.url || /haohuo|goods_detail/i.test(payload.value)) {
      return {
        productId,
        title: data.title || '',
        sales: data.sales || '',
        price: data.price || '',
        url: payload.value,
        source: 'form-targets',
      };
    }
  }

  // ---- bd-retrofit-request with body (39.6.0 ecombdapi POST) ----
  // Body is URL-encoded query-string with JSON-encoded fields like:
  //   promotion_ids=123&basic_info=%7B%22product_id%22%3A123%7D&...
  if (payload.type === 'bd-retrofit-request' && payload.body) {
    const url = payload.url || '';
    let productId = '';
    let title = '';
    let price = '';
    let sales = '';

    // ---- Deep body parse: decode + extract JSON fields ----
    try {
      const decodedBody = safeDecode(payload.body);
      const params = new URLSearchParams(decodedBody);

      // 39.6.0: promotion_ids (plural) — direct product identifier
      productId = params.get('promotion_ids') || '';

      // Parse basic_info JSON for product_id and other fields
      const basicInfoRaw = params.get('basic_info');
      if (basicInfoRaw) {
        try {
          const bi = JSON.parse(basicInfoRaw);
          if (!productId) productId = String(bi.product_id || bi.id || '');
          // shop_id for later enrichment
          if (bi.shop_id) title = title || ''; // keep scanning
        } catch { /* basic_info may not be valid JSON */ }
      }

      // Also try promotion_id (singular, older format)
      if (!productId) productId = params.get('promotion_id') || '';

      // product_id as direct param
      if (!productId) productId = params.get('product_id') || '';
    } catch { /* body parse is best-effort */ }

    // Fallback: regex extraction from raw body
    if (!productId) {
      productId = extractProductIdLoose(payload.body) || payload.extractedProductId || '';
    }

    if (productId || /promotion_ids|product_id|goods_detail|ecom.*product.*detail|basic_info/i.test(payload.body)) {
      return { productId, title, sales, price, url, source: 'bd-retrofit-body' };
    }
  }

  // ---- NEW: OkHttp response body ----
  if (payload.type === 'okhttp-response' && payload.body) {
    const parsed = extractFromResponseBody(payload.body);
    if (parsed) {
      const productId = parsed.productId || extractProductIdLoose(payload.body) || payload.extractedProductId || '';
      return {
        productId,
        title: parsed.title || '',
        sales: parsed.sales || '',
        price: parsed.price || '',
        url: payload.url || '',
        source: 'okhttp-response',
        _responseData: parsed,
      };
    }
  }

  // ---- NEW: FastJson response ----
  if (payload.type === 'fastjson-response' && payload.body) {
    const parsed = extractFromFastJsonResponse(payload.body);
    if (parsed) {
      const productId = parsed.productId || payload.extractedProductId || '';
      return {
        productId,
        title: parsed.title || '',
        sales: parsed.sales || '',
        price: parsed.price || '',
        url: '',
        source: 'fastjson-response',
        _responseData: parsed,
      };
    }
  }

  // ---- NEW: Gson response (39.6.0) ----
  if (payload.type === 'gson-response' && payload.body) {
    const parsed = extractFromResponseBody(payload.body);
    const productId = parsed?.productId || extractProductIdLoose(payload.body) || payload.extractedProductId || '';
    if (productId || parsed?.title) {
      return {
        productId,
        title: parsed?.title || '',
        sales: parsed?.sales || '',
        price: parsed?.price || '',
        url: '',
        source: 'gson-response',
        _responseData: parsed,
      };
    }
  }

  // ---- NEW: WebView URL ----
  if ((payload.type === 'webview-load-url' || payload.type === 'webview-override-url') && payload.url) {
    const data = extractFromWebViewUrl(payload.url);
    if (data) {
      return { ...data, source: payload.type };
    }
  }

  // ---- NEW: Intent extra ----
  if (payload.type === 'intent-extra' && payload.value) {
    const data = extractFromIntentExtra(payload.name, payload.value);
    if (data) {
      return { ...data, source: 'intent-extra' };
    }
  }

  // ---- Generic: URI / URL / text ----
  const raw = payload.uri || payload.url || payload.text || payload.value || '';
  if (!raw) return null;

  if (/v\.douyin\.com\/[A-Za-z0-9_-]+/.test(raw)) {
    const url = extractShareUrlFromText(raw);
    return url ? { productId: extractProductIdLoose(raw), title: '', sales: '', price: '', url, source: payload.type } : null;
  }
  // 39.5.0: haohuo.jinritemai.com / goods_detail URLs
  // 39.6.0: ecom.ecombdapi.com / ecom/product/detail URLs
  if (/haohuo\.jinritemai|goods_detail|ec_goods|product_id|promotion_id|ecombdapi|ecom\/product/i.test(raw)) {
    const data = extractFromProductUrl(raw) || {};
    const productId = data.productId || extractProductIdLoose(raw);
    if (!productId && !data.title && !/haohuo|goods_detail|ecombdapi|ecom\/product/i.test(raw)) return null;
    return {
      productId,
      title: data.title || '',
      sales: data.sales || '',
      price: data.price || '',
      url: raw,
      source: payload.type || 'uri',
    };
  }
  return null;
}

function resolveBundlePath(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const p of BUNDLE_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Frida bundle not found. Expected one of:\n${BUNDLE_CANDIDATES.join('\n')}`);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param {{ serial?: string, fridaHost?: string, bundlePath?: string }} opts
 */
export async function createFridaCapture({
  serial = 'emulator-5554',
  fridaHost = '127.0.0.1:27042',
  bundlePath = null,
} = {}) {
  const bundle = resolveBundlePath(bundlePath || process.env.FRIDA_BUNDLE);
  const devices = await frida.enumerateDevices();
  let device = devices.find((d) => d.id === serial) || devices.find((d) => d.type === 'usb');
  if (!device) {
    device = await frida.getDeviceManager().addRemoteDevice(fridaHost);
  }

  const processes = await device.enumerateProcesses({ scope: 'full' });
  let proc = processes.find((p) => (p.parameters?.applications || []).includes(PACKAGE_NAME))
    || processes.find((p) => {
      const n = p.name || '';
      return n === '抖音商城' || n.includes('livelite');
    });
  if (!proc) {
    throw new Error(`Douyin Mall process not found (${PACKAGE_NAME}). Start the app first.`);
  }

  const session = await device.attach(proc.pid);
  const script = await session.createScript(fs.readFileSync(bundle, 'utf8'));
  const events = [];

  script.message.connect((message) => {
    if (message.type !== 'send') return;
    const payload = message.payload;
    events.push({ ...payload, _receivedAt: Date.now() });
    const productData = extractFromEvent(payload);
    if (productData) {
      events.push({ type: 'product-captured', ...productData, _receivedAt: Date.now() });
    }
  });

  await script.load();
  await sleep(800);
  console.log(`[frida] Attached PID=${proc.pid} name=${proc.name} bundle=${path.basename(bundle)}`);

  return {
    session,
    script,
    pid: proc.pid,

    getEvents() {
      return [...events];
    },

    clearEvents() {
      events.length = 0;
    },

    /**
     * Wait for ANY product URL — races all Frida sources, returns best match by score.
     *
     * Scoring priority:
     *   10 : haohuo + goods_detail (self-contained, never expires)
     *    8 : haohuo + product_id
     *    7 : OkHttp response body with title + id
     *    5 : v.douyin.com short link
     *    3 : product_id only
     *
     * @param {{ timeoutMs?: number, previousUrl?: string }} [opts]
     * @returns {Promise<{url: string, productId: string, title: string, price: string, sales: string, score: number, source: string}|null>}
     */
    async waitForAnyProductUrl({ timeoutMs = 15_000, previousUrl = null } = {}) {
      const deadline = Date.now() + timeoutMs;
      const startIndex = events.length;
      let best = null;

      while (Date.now() < deadline) {
        for (let i = startIndex; i < events.length; i++) {
          const e = events[i];

          // Check product-captured events (synthesized by extractFromEvent)
          if (e.type === 'product-captured') {
            const url = e.url || '';
            if (previousUrl && url && url.replace(/\/$/, '') === previousUrl.replace(/\/$/, '')) continue;

            const scored = scoreProductUrl(url, {
              productId: e.productId || '',
              title: e.title || '',
              price: e.price || '',
              sales: e.sales || '',
            });
            scored.source = e.source || 'frida';
            scored._responseData = e._responseData || null;

            if (!best || scored.score > best.score) {
              best = scored;
            }
          }

          // Also scan raw okhttp-response events directly
          if (e.type === 'okhttp-response' && e.body) {
            const parsed = extractFromResponseBody(e.body);
            if (parsed?.productId || parsed?.title) {
              const url = e.url || '';
              const scored = scoreProductUrl(url, {
                productId: parsed.productId || '',
                title: parsed.title || '',
                price: parsed.price || '',
                sales: parsed.sales || '',
              });
              scored.source = 'okhttp-response';
              scored._responseData = parsed;
              if (!best || scored.score > best.score) {
                best = scored;
              }
            }
          }

          // Scan fastjson-response events
          if (e.type === 'fastjson-response' && e.body) {
            const parsed = extractFromFastJsonResponse(e.body);
            if (parsed?.productId || parsed?.title) {
              const scored = scoreProductUrl('', {
                productId: parsed.productId || '',
                title: parsed.title || '',
                price: parsed.price || '',
                sales: parsed.sales || '',
              });
              scored.source = 'fastjson-response';
              scored._responseData = parsed;
              if (!best || scored.score > best.score) {
                best = scored;
              }
            }
          }
        }

        // Good enough: score >= 7 (has goods_detail OR response body with id+title)
        if (best && best.score >= 7) {
          return best;
        }

        await sleep(250);
      }

      return best; // May be null or have lower score
    },

    /**
     * Wait for a share short link (v.douyin.com) after share/copy.
     */
    async waitForShareUrl({ timeoutMs = 15_000, previousUrl = null } = {}) {
      const deadline = Date.now() + timeoutMs;
      const startIndex = events.length;
      while (Date.now() < deadline) {
        for (let i = startIndex; i < events.length; i++) {
          const e = events[i];
          if (e.type !== 'product-captured') continue;
          const url = e.url || '';
          if (!/v\.douyin\.com/.test(url)) continue;
          if (previousUrl && url.replace(/\/$/, '') === previousUrl.replace(/\/$/, '')) continue;
          return { url, productId: e.productId || '', source: e.source || 'frida' };
        }
        // also scan raw clipboard events not yet product-captured
        for (let i = startIndex; i < events.length; i++) {
          const e = events[i];
          if (e.type === 'clipboard') {
            const url = extractShareUrlFromText(e.text);
            if (url && (!previousUrl || url.replace(/\/$/, '') !== previousUrl.replace(/\/$/, ''))) {
              return { url, productId: '', source: 'clipboard' };
            }
          }
        }
        await sleep(200);
      }
      return null;
    },

    /**
     * Wait for product_id / goods_detail after opening a product page.
     * Scans product-captured events first, then raw URI/url/form events.
     */
    async waitForProduct({ timeoutMs = 12_000, previousUrl = null, requireId = false } = {}) {
      const deadline = Date.now() + timeoutMs;
      let best = null;

      const consider = (event) => {
        if (!event) return;
        const url = event.url || event.uri || event.value || '';
        if (previousUrl && url && url === previousUrl) return;
        const productId = event.productId || extractProductIdLoose(url) || '';
        const title = event.title || '';
        const price = event.price || '';
        const sales = event.sales || '';
        if (!productId && !title && !/haohuo|goods_detail|v\.douyin\.com|ecombdapi|ecom\/product|promotion_ids/i.test(url)) return;
        if (requireId && !productId) return;

        const scored = scoreProductUrl(url, { productId, title, price, sales });

        const candidate = {
          商品id: productId,
          商品品名: title,
          价格: price,
          销量: sales,
          分享的链接: /v\.douyin\.com/.test(url) ? extractShareUrlFromText(url) || url : '',
          _detailUrl: url,
          _captured: true,
          _source: event.source || event.type || '',
          _score: scored.score,
          _responseData: event._responseData || null,
        };
        if (!best || scored.score > best._score) best = candidate;
      };

      while (Date.now() < deadline) {
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          if (event.type === 'product-captured') {
            consider(event);
          } else if (event.type === 'okhttp-response' && event.body) {
            const parsed = extractFromResponseBody(event.body);
            if (parsed) consider({ ...parsed, url: event.url, type: 'okhttp-response' });
          } else if (event.type === 'fastjson-response' && event.body) {
            const parsed = extractFromFastJsonResponse(event.body);
            if (parsed) consider({ ...parsed, url: '', type: 'fastjson-response' });
          } else {
            // Re-extract from raw traffic (uri / retrofit / form targets / webview)
            const extracted = extractFromEvent(event);
            if (extracted) consider({ ...extracted, type: event.type });
          }
        }
        // Good enough: have id, or id+title, or goods_detail long link
        if (best && best._score >= 4) {
          return best;
        }
        await sleep(250);
      }
      return best;
    },

    /** Snapshot product-related events for debugging. */
    recentProductEvents(limit = 20) {
      return events
        .filter((e) => e.type === 'product-captured' || interestingProductBlob(e))
        .slice(-limit);
    },

    async close() {
      await script.unload().catch(() => {});
      await session.detach().catch(() => {});
    },
  };
}
