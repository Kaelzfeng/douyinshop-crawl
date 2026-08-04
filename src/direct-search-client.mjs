/**
 * Direct Search API Client for Douyin Mall
 *
 * Pure API-level search via the ecom.ecombdapi.com search endpoint.
 * Uses Frida RPC to sign requests inside the running app, then sends
 * HTTP requests from Node.js (or optionally proxies through the app).
 *
 * No ADB input, no UI automation, no share-button clicking.
 *
 * Usage:
 *   import { createDirectSearchClient } from './direct-search-client.mjs';
 *   const client = await createDirectSearchClient({ serial: 'emulator-5554' });
 *   const page = await client.searchPage({ keyword: 'ggdb', cursor: 0, count: 20 });
 *   // page = { products: [...], cursor: '0', nextCursor: '...', hasMore: true }
 *   await client.close();
 */

import frida from 'frida';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractProductFields } from './product-field-normalizers.mjs';
import { loadSession, sessionRequestHeaders } from './session.mjs';
import { resolveDeviceParams } from './device-params.mjs';
import { createNativeSignClient } from './native-sign.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.resolve(__dirname, '..', 'hook', 'direct-search-agent.bundle.js');
const PACKAGE_NAME = 'com.ss.android.ugc.livelite';
const SEARCH_ENDPOINT = 'https://ecom.ecombdapi.com/aweme/v3/shop/search/aggregate/shopping/stream/';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** @typedef {'app_proxy'|'frida_rpc'|'local'} SignMode */

function bodyStub(body) {
  return createHash('md5').update(String(body || ''), 'utf8').digest('hex').toUpperCase();
}

// ---------------------------------------------------------------------------
// TTNet streaming response dechunking
// ---------------------------------------------------------------------------

/**
 * Decode TTNet's custom streaming transfer encoding.
 * Format: each "chunk" is <hex-size>\r\n<data>\r\n where data is a transport
 * fragment. A JSON document may span multiple chunks.
 *
 * This is NOT standard HTTP chunked encoding — TTNet uses it as an
 * application-level streaming protocol on top of the HTTP response body.
 */
/**
 * Extract complete JSON documents from a concatenated TTNet payload.
 *
 * TTNet can split one JSON document over several framed chunks, so parsing a
 * chunk in isolation loses documents. This scanner tracks JSON nesting and
 * quoted-string escapes and only calls JSON.parse at a complete root.
 */
function extractJsonDocuments(payload) {
  const documents = [];
  let pos = 0;

  while (pos < payload.length) {
    while (pos < payload.length && /\s/.test(payload[pos])) pos++;
    if (pos >= payload.length) break;

    if (payload[pos] !== '{' && payload[pos] !== '[') {
      const nextObject = payload.indexOf('{', pos);
      const nextArray = payload.indexOf('[', pos);
      const candidates = [nextObject, nextArray].filter((value) => value >= 0);
      if (!candidates.length) break;
      pos = Math.min(...candidates);
    }

    const start = pos;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < payload.length; i++) {
      const ch = payload[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end < 0) break;

    try {
      documents.push(JSON.parse(payload.slice(start, end)));
      pos = end;
    } catch (_) {
      // Ignore a false opening brace in non-JSON prefix data.
      pos = start + 1;
    }
  }

  return documents;
}

/**
 * Read TTNet framing using either byte or JavaScript-string length units.
 * Real TTNet lengths are UTF-8 byte counts. The string fallback keeps
 * compatibility with older fixtures assembled with `json.length`.
 */
function readTTNetChunks(raw, byteLengths) {
  const source = byteLengths ? Buffer.from(raw, 'utf8') : raw;
  const crlf = byteLengths ? Buffer.from('\r\n') : '\r\n';
  const parts = [];
  let pos = 0;

  const findCrlf = (from) => source.indexOf(crlf, from);
  const readAscii = (from, to) => byteLengths
    ? source.subarray(from, to).toString('ascii')
    : source.slice(from, to);

  while (pos < source.length) {
    const lineEnd = findCrlf(pos);
    if (lineEnd < 0) return { valid: false, payload: '' };

    const sizeLine = readAscii(pos, lineEnd);
    const sizeHex = sizeLine.split(';')[0].trim();
    if (!/^[0-9a-f]+$/i.test(sizeHex)) return { valid: false, payload: '' };

    const chunkSize = parseInt(sizeHex, 16);
    if (!Number.isFinite(chunkSize)) return { valid: false, payload: '' };

    pos = lineEnd + 2;
    if (chunkSize === 0) {
      return {
        valid: true,
        payload: byteLengths
          ? Buffer.concat(parts).toString('utf8')
          : parts.join(''),
      };
    }

    if (pos + chunkSize > source.length) return { valid: false, payload: '' };
    if (byteLengths) parts.push(source.subarray(pos, pos + chunkSize));
    else parts.push(source.slice(pos, pos + chunkSize));
    pos += chunkSize;

    // Require the frame's trailing CRLF so a byte-length parse cannot drift
    // into the middle of a UTF-8 string.
    if (byteLengths) {
      if (source[pos] !== 13 || source[pos + 1] !== 10) {
        return { valid: false, payload: '' };
      }
    } else if (source.slice(pos, pos + 2) !== '\r\n') {
      return { valid: false, payload: '' };
    }
    pos += 2;
  }

  return { valid: false, payload: '' };
}

/**
 * Decode TTNet's custom streaming transfer encoding.
 *
 * Chunk boundaries are transport boundaries, not JSON-document boundaries.
 * All data is concatenated before document extraction. Production lengths
 * are UTF-8 byte counts; a string-unit fallback supports legacy fixtures.
 */
function dechunkTTNetStream(raw) {
  const byteFraming = readTTNetChunks(raw, true);
  const stringFraming = readTTNetChunks(raw, false);
  const candidates = [byteFraming, stringFraming]
    .filter((candidate) => candidate.valid)
    .map((candidate) => ({
      ...candidate,
      documents: extractJsonDocuments(candidate.payload),
    }));

  if (!candidates.length) return [];

  // Prefer the framing that yields the most complete JSON documents. This
  // normally selects byte framing and falls back to legacy fixtures when
  // their size fields use JavaScript string length.
  candidates.sort((a, b) => b.documents.length - a.documents.length);
  return candidates[0].documents;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Deep-search an object tree for a value by key name.
 * Returns the first match found.
 */
function deepFind(obj, targetKey, maxDepth = 12) {
  if (!obj || typeof obj !== 'object' || maxDepth <= 0) return undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFind(item, targetKey, maxDepth - 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === targetKey) return v;
    const found = deepFind(v, targetKey, maxDepth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Deep-search for all values matching a key name.
 */
function deepFindAll(obj, targetKey, maxDepth = 12) {
  const results = [];
  if (!obj || typeof obj !== 'object' || maxDepth <= 0) return results;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...deepFindAll(item, targetKey, maxDepth - 1));
    }
    return results;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === targetKey) results.push(v);
    results.push(...deepFindAll(v, targetKey, maxDepth - 1));
  }
  return results;
}

/**
 * Parse a single product card from the search response.
 */
function parseProductCard(card) {
  const fields = extractProductFields(card);
  return {
    product_id: fields.product_id,
    promotion_id: fields.promotion_id,
    product_name: fields.product_name,
    title: fields.title,
    shop_name: fields.shop_name,
    price: fields.price,
    sales: fields.sales,
    sales_metadata: fields.sales_metadata,
    raw_card: card,
  };
}

/**
 * Parse the full search API response (TTNet streaming format).
 * Returns { products, cursor, nextCursor, hasMore, rawResponse }.
 */
export function parseSearchResponse(body, requestCursor = '0') {
  if (typeof body !== 'string') {
    return {
      products: [], cursor: requestCursor, nextCursor: '', hasMore: false,
      status_code: -1, rawResponse: body, rawBody: body, parseError: 'Body is not a string',
    };
  }

  // Detect TTNet streaming format (starts with hex size + \r\n)
  const isTTNetStream = /^[0-9a-fA-F]+\r?\n/.test(body);
  let documents;

  if (isTTNetStream) {
    documents = dechunkTTNetStream(body);
  } else {
    // Standard JSON response
    try {
      documents = [JSON.parse(body)];
    } catch {
      return {
        products: [], cursor: requestCursor, nextCursor: '', hasMore: false,
        status_code: -1, rawResponse: body, rawBody: body, parseError: 'JSON parse failed',
      };
    }
  }

  if (!documents.length) {
    return {
      products: [], cursor: requestCursor, nextCursor: '', hasMore: false,
      status_code: -1, rawResponse: body, rawBody: body,
      parseError: 'No valid JSON documents in response',
    };
  }

  // Merge data from all documents — deep search for products and cursor info
  let statusCode = -1;
  let statusMsg = '';
  let cursor = requestCursor;
  let nextCursor = '';
  let hasMore = false;
  let logPb = null;
  const productCards = [];
  const seenProductIds = new Set();

  /**
   * Recursively search for product objects.
   * A product object is an object with a product_id-like field
   * AND at least one other product field (title, price, shop).
   */
  function collectProductObjects(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 16) return;
    if (seenProductIds.size > 5000) return; // safety limit

    if (Array.isArray(obj)) {
      for (const item of obj) collectProductObjects(item, depth + 1);
      return;
    }

    // Check if this object itself is a product card
    const pid = obj.ProductID || obj.product_id || obj.productId || obj.promotion_id || '';
    const hasProductFields = Boolean(
      obj.Title || obj.title || obj.product_name ||
      obj.Price !== undefined || obj.price !== undefined ||
      obj.MaterialContentInfo || obj.shop_name || obj.shopName,
    );

    if (pid && hasProductFields) {
      const pidStr = String(pid);
      if (!seenProductIds.has(pidStr)) {
        seenProductIds.add(pidStr);
        productCards.push(obj);
      }
      // Don't return — there might be nested products
    }

    // Recurse into object values
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') collectProductObjects(v, depth + 1);
    }
  }

  for (const doc of documents) {
    if (doc.status_code !== undefined) statusCode = doc.status_code;
    if (doc.status_msg) statusMsg = doc.status_msg;

    // Collect cursor/has_more from top-level and nested paths
    if (doc.cursor !== undefined) cursor = String(doc.cursor);
    if (doc.has_more !== undefined) hasMore = Boolean(doc.has_more);
    if (doc.next_cursor !== undefined) nextCursor = String(doc.next_cursor);
    if (doc.log_pb) logPb = doc.log_pb;

    // Check biz_data.basic_info for pagination info
    const basicInfo = doc.biz_data?.basic_info || {};
    if (basicInfo.has_more !== undefined) hasMore = Boolean(basicInfo.has_more);
    if (basicInfo.next_cursor) nextCursor = String(basicInfo.next_cursor);

    // Check page_data sub-fields
    const pd = doc.page_data || {};
    if (pd.cursor !== undefined) cursor = String(pd.cursor);
    if (pd.has_more !== undefined) hasMore = Boolean(pd.has_more);
    if (pd.next_cursor) nextCursor = String(pd.next_cursor);

    // The ecom search response places pagination in load_more_config rather
    // than next_cursor. This is present in the real TTNet documents (for
    // example: { has_more: true, cursor: 8 }).
    const loadMore = doc.load_more_config
      || pd.load_more_config
      || doc.biz_data?.load_more_config
      || {};
    if (loadMore.has_more !== undefined) hasMore = Boolean(loadMore.has_more);
    if (loadMore.cursor !== undefined) nextCursor = String(loadMore.cursor);
    if (loadMore.next_cursor !== undefined) nextCursor = String(loadMore.next_cursor);

    // Deep search for products in this document
    collectProductObjects(doc);
  }

  // Parse found product cards
  const products = [];
  for (const card of productCards) {
    const product = parseProductCard(card);
    if (product.product_id) {
      products.push(product);
    }
  }

  return {
    products,
    cursor,
    nextCursor: nextCursor || '',
    hasMore,
    status_code: statusCode,
    status_msg: statusMsg,
    logPb,
    documentCount: documents.length,
    rawResponse: documents,
    rawBody: body,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Create a direct search client.
 *
 * @param {object} [opts]
 * @param {string} [opts.serial='emulator-5554']
 * @param {string} [opts.fridaHost='127.0.0.1:27042']
 * @param {string} [opts.bundlePath]
 * @param {boolean} [opts.useAppProxy=true] — legacy alias for signMode
 * @param {'app_proxy'|'frida_rpc'|'local'} [opts.signMode]
 * @param {string} [opts.sessionPath]
 * @param {string} [opts.deviceParamsPath]
 * @param {string} [opts.nativeSignerUrl]
 */
export async function createDirectSearchClient({
  serial = 'emulator-5554',
  fridaHost = '127.0.0.1:27042',
  bundlePath = null,
  useAppProxy = true,
  signMode = null,
  sessionPath = 'output/session.json',
  deviceParamsPath = 'output/device-params.json',
  nativeSignerUrl = process.env.METASEC_SIGNER_URL || 'http://127.0.0.1:17890',
} = {}) {
  /** @type {'app_proxy'|'frida_rpc'|'local'} */
  let mode = signMode || (useAppProxy ? 'app_proxy' : 'frida_rpc');
  if (!['app_proxy', 'frida_rpc', 'local'].includes(mode)) {
    throw new Error(`Invalid signMode=${mode}`);
  }

  const appSession = loadSession(sessionPath);
  const deviceResolved = resolveDeviceParams({
    deviceParamsPath,
    session: appSession,
  });
  if (deviceResolved.usedFallback) {
    console.warn('[direct-search] Using fallback device params; run: node tools/export-app-session.mjs');
  } else {
    console.log(`[direct-search] Device params source=${deviceResolved.source}`);
  }
  if (appSession?.cookie_header) {
    console.log(`[direct-search] Session cookies loaded (${Object.keys(appSession.cookies || {}).length} keys)`);
  } else if (mode !== 'app_proxy') {
    console.warn('[direct-search] No session cookies; L2/local may fail until export-app-session');
  }

  const STATIC_PARAMS = deviceResolved.staticParams;
  const SESSION_PARAMS = deviceResolved.sessionParams;

  let script = null;
  let fridaSession = null;
  let device = null;
  let nativeSigner = null;
  let lastWire = null;

  async function ensureFrida() {
    if (script) return;
    const bundle = bundlePath || BUNDLE_PATH;
    if (!fs.existsSync(bundle)) {
      throw new Error(`Frida bundle not found: ${bundle}. Run: npm run build:direct-search`);
    }

    const devices = await frida.enumerateDevices();
    device = devices.find((d) => d.id === serial) || devices.find((d) => d.type === 'usb');
    if (!device) {
      device = await frida.getDeviceManager().addRemoteDevice(fridaHost);
    }

    const processes = await device.enumerateProcesses({ scope: 'full' });
    const proc = processes.find((p) =>
      (p.parameters?.applications || []).includes(PACKAGE_NAME),
    ) || processes.find((p) => {
      const n = p.name || '';
      return n === '抖音商城' || n.includes('livelite');
    });

    if (!proc) throw new Error('Douyin Mall process not found. Start the app first.');

    fridaSession = await device.attach(proc.pid);
    script = await fridaSession.createScript(fs.readFileSync(bundle, 'utf8'));
    await script.load();
    await sleep(500);

    const status = await script.exports.status();
    if (!status.ok || !status.providerInstalled) {
      console.warn('[direct-search] NetworkParams signer not ready');
      if (mode === 'frida_rpc') {
        console.warn('[direct-search] Falling back to app_proxy');
        mode = 'app_proxy';
      }
    }
    console.log(`[direct-search] Frida attached pid=${proc.pid}`);
  }

  if (mode === 'local') {
    nativeSigner = createNativeSignClient({ baseUrl: nativeSignerUrl });
    const health = await nativeSigner.health();
    if (!health.ok) {
      throw new Error(
        `local sign mode requires MetaSec sidecar at ${nativeSignerUrl} (${health.error || health.status}). `
        + 'Start unidbg-metasec or use --sign-mode app_proxy|frida_rpc',
      );
    }
    console.log(`[direct-search] Local signer ready at ${nativeSignerUrl}`);
  } else {
    await ensureFrida();
  }

  console.log(`[direct-search] mode=${mode}`);

  function buildSearchUrl(cursor = '0', count = 20) {
    const ts = Math.floor(Date.now() / 1000);
    const _rticket = Date.now();
    const params = new URLSearchParams({
      ...STATIC_PARAMS,
      ...SESSION_PARAMS,
      ts: String(ts),
      _rticket: String(_rticket),
    });
    return `${SEARCH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Build the POST body for a search request.
   */
  function buildSearchBody(keyword, cursor = '0', count = 20, searchSessionId = '') {
    const bodyParams = {
      cursor: String(cursor),
      count: String(count),
      keyword,
      query_correct_type: '1',
      search_channel: 'search_order_center',
      search_source: 'normal_search',
      search_scene: 'douyin_search',
      shown_count: '0',
    };
    if (searchSessionId) {
      bodyParams.search_session_id = searchSessionId;
    }
    return new URLSearchParams(bodyParams).toString();
  }

  /**
   * Execute one search page.
   *
   * @param {object} params
   * @param {string} params.keyword
   * @param {string|number} [params.cursor='0']
   * @param {number} [params.count=20]
   * @param {string} [params.searchSessionId]
   * @returns {Promise<object>} { products, cursor, nextCursor, hasMore, ... }
   */
  async function searchPage({
    keyword,
    cursor = '0',
    count = 20,
    searchSessionId = '',
  }) {
    const url = buildSearchUrl(cursor, count);
    const body = buildSearchBody(keyword, cursor, count, searchSessionId);
    const startTime = Date.now();

    let httpStatus;
    let responseBody;
    let signedHeaders = {};

    if (mode === 'app_proxy') {
      await ensureFrida();
      const resp = await script.exports.search(url, body, sessionRequestHeaders(appSession));
      httpStatus = resp.status;
      responseBody = resp.body;
      signedHeaders = resp.signed_headers || {};
      lastWire = resp.wire || null;
    } else {
      // frida_rpc or local: Node sends HTTP
      const baseHeaders = sessionRequestHeaders(appSession, {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'com.ss.android.ugc.livelite/390600',
        'X-SS-STUB': bodyStub(body),
      });

      if (mode === 'frida_rpc') {
        await ensureFrida();
        const signed = await script.exports.signOnly(url, baseHeaders);
        signedHeaders = signed.headers || {};
        lastWire = signed.wire || null;
        if (signed.cookie_header && !baseHeaders.Cookie) {
          baseHeaders.Cookie = signed.cookie_header;
        }
      } else {
        const signed = await nativeSigner.sign(url, baseHeaders, body);
        signedHeaders = signed.headers || {};
      }

      const headers = {
        ...baseHeaders,
        ...signedHeaders,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const fetchResp = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        httpStatus = fetchResp.status;
        responseBody = await fetchResp.text();
      } finally {
        clearTimeout(timer);
      }
    }

    const elapsed = Date.now() - startTime;
    const parsed = parseSearchResponse(responseBody, String(cursor));

    return {
      keyword,
      cursor: String(cursor),
      nextCursor: parsed.nextCursor,
      hasMore: parsed.hasMore,
      httpStatus,
      businessStatus: parsed.status_code,
      statusMsg: parsed.status_msg,
      products: parsed.products,
      productsInPage: parsed.products.length,
      responseBytes: (responseBody || '').length,
      signMode: mode,
      signedHeaders,
      lastWire,
      elapsedMs: elapsed,
      rawResponse: parsed.rawResponse,
      rawBody: parsed.rawBody,
    };
  }

  /**
   * Search all pages for a keyword, collecting unique products.
   *
   * @param {object} params
   * @param {string} params.keyword
   * @param {number} [params.count=20]
   * @param {number} [params.maxPages=50]
   * @param {function} [params.onPage] — callback(pageResult)
   * @returns {Promise<{products: object[], pages: number, totalProducts: number}>}
   */
  async function searchAllPages({
    keyword,
    count = 20,
    maxPages = 50,
    onPage = null,
  }) {
    const seen = new Set();
    const allProducts = [];
    let cursor = '0';
    let pages = 0;
    let consecutiveEmpty = 0;
    let consecutiveNoNew = 0;

    while (pages < maxPages) {
      const page = await searchPage({ keyword, cursor, count });
      pages += 1;

      let newInPage = 0;
      for (const product of page.products) {
        if (product.product_id && !seen.has(product.product_id)) {
          seen.add(product.product_id);
          allProducts.push(product);
          newInPage += 1;
        }
      }

      if (onPage) {
        await onPage({ ...page, newInPage, totalUnique: allProducts.length });
      }

      // Termination conditions
      if (!page.hasMore) {
        console.log(`[direct-search] ${keyword}: has_more=false after ${pages} pages`);
        break;
      }

      if (!page.nextCursor || page.nextCursor === cursor) {
        console.log(`[direct-search] ${keyword}: cursor stalled after ${pages} pages`);
        break;
      }

      if (page.productsInPage === 0) {
        consecutiveEmpty += 1;
        if (consecutiveEmpty >= 3) {
          console.log(`[direct-search] ${keyword}: ${consecutiveEmpty} consecutive empty pages`);
          break;
        }
      } else {
        consecutiveEmpty = 0;
      }

      if (newInPage === 0) {
        consecutiveNoNew += 1;
        if (consecutiveNoNew >= 3) {
          console.log(`[direct-search] ${keyword}: ${consecutiveNoNew} pages with no new products`);
          break;
        }
      } else {
        consecutiveNoNew = 0;
      }

      cursor = page.nextCursor;
    }

    return {
      keyword,
      products: allProducts,
      pages,
      totalProducts: allProducts.length,
    };
  }

  async function close() {
    if (script) {
      await script.unload().catch(() => {});
      script = null;
    }
    if (fridaSession) {
      await fridaSession.detach().catch(() => {});
      fridaSession = null;
    }
  }

  async function exportSessionFromApp() {
    await ensureFrida();
    return script.exports.exportSession();
  }

  async function getLastWire() {
    if (lastWire) return lastWire;
    if (!script) return null;
    try {
      return await script.exports.getLastWire();
    } catch {
      return null;
    }
  }

  return {
    searchPage,
    searchAllPages,
    exportSessionFromApp,
    getLastWire,
    getSignMode: () => mode,
    status: async () => {
      if (!script) return { ok: mode === 'local', mode };
      return script.exports.status();
    },
    close,
  };
}
