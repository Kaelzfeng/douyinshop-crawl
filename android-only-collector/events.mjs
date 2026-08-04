import { randomUUID } from 'node:crypto';

export const EVENT_SCHEMA_VERSION = 1;
export const DEFAULT_CORRELATION_WINDOW_MS = 60_000;

const PRODUCT_ID_KEYS = [
  'product_id',
  'promotion_id',
  'promotion_ids',
  'target_id',
  'goods_id',
  'productId',
  'promotionId',
];

const SHARE_URL_RE = /https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/i;
const PRODUCT_URL_RE = /ecom\/product\/detail\/pack|promotion\/pack|ec_goods_detail/i;
const PRODUCT_BODY_RE = /promotion_ids?|basic_info|pass_through_params|product_id/i;
const EC_GOODS_DETAIL_RE = /^sslocal:\/\/ec_goods_detail(?:[?#]|$)/i;

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function limited(value, max = 16_000) {
  return text(value).slice(0, max);
}

function decodeOnce(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodedVariants(value) {
  const result = [];
  let current = text(value);
  for (let i = 0; i < 3; i += 1) {
    if (!result.includes(current)) result.push(current);
    const next = decodeOnce(current);
    if (next === current) break;
    current = next;
  }
  return result;
}

function parseNestedJson(value) {
  if (typeof value !== 'string') return null;
  for (const candidate of decodedVariants(value)) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Nested card payloads are not always JSON strings; keep walking normally.
    }
  }
  return null;
}

function validId(value) {
  const candidate = text(value).trim().replace(/^['"]|['"]$/g, '');
  return /^\d{10,22}$/.test(candidate) ? candidate : '';
}

function scalarText(value) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  return text(value).trim();
}

function idFromObject(value, depth = 0) {
  if (!value || depth > 6) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = idFromObject(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';

  for (const key of PRODUCT_ID_KEYS) {
    const found = validId(value[key]);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    const found = idFromObject(item, depth + 1);
    if (found) return found;
  }
  return '';
}

/** Extract a Douyin product identifier from URLs, form bodies, or JSON. */
export function extractProductId(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (raw && typeof raw === 'object') return idFromObject(raw);

  for (const candidate of decodedVariants(raw)) {
    try {
      const parsed = JSON.parse(candidate);
      const found = idFromObject(parsed);
      if (found) return found;
    } catch {
      // The runtime body is often URL-encoded rather than JSON.
    }

    try {
      const params = new URLSearchParams(candidate);
      for (const key of PRODUCT_ID_KEYS) {
        const found = validId(params.get(key));
        if (found) return found;
      }
      for (const key of ['basic_info', 'pass_through_params', 'common_params']) {
        const nested = params.get(key);
        const found = extractProductId(nested);
        if (found) return found;
      }
    } catch {
      // Continue with regex extraction below.
    }

    for (const key of PRODUCT_ID_KEYS) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp(`(?:^|[?&\\s])${escapedKey}=(?:%22|["']?)(\\d{10,22})`, 'i'),
        new RegExp(`(?:["']|%22)${escapedKey}(?:["']|%22)\\s*(?:=|:|%3A)\\s*(?:["']|%22)?(\\d{10,22})`, 'i'),
      ];
      for (const pattern of patterns) {
        const match = candidate.match(pattern);
        if (match) return match[1];
      }
    }
  }
  return '';
}

function objectFields(value, result, depth = 0) {
  // HomePageDTO -> sections[] -> items[] -> item_data(JSON) -> price/shop
  // is deeper than the ordinary response path, so keep enough depth for the
  // confirmed card model without making recursion unbounded.
  if (!value || depth > 12) return;
  if (Array.isArray(value)) {
    for (const item of value) objectFields(item, result, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const directShopName = scalarText(
    value.shop_name
      ?? value.shopName
      ?? value.store_name
      ?? value.seller_name
      ?? value.merchant_name,
  );
  if (directShopName && !result.shop_name) result.shop_name = directShopName;
  for (const key of ['shop_info', 'shopInfo', 'shop']) {
    const shop = value[key];
    if (!shop || typeof shop !== 'object' || result.shop_name) continue;
    const nestedShopName = scalarText(
      shop.name
        ?? shop.shop_name
        ?? shop.shopName
        ?? shop.store_name
        ?? shop.seller_name,
    );
    if (nestedShopName) result.shop_name = nestedShopName;
  }

  for (const key of PRODUCT_ID_KEYS) {
    const found = validId(value[key]);
    if (found && !result.product_id) {
      result.product_id = found;
      if (key.toLowerCase().includes('promotion')) result.promotion_id ||= found;
    }
  }
  const promotionId = validId(value.promotion_id ?? value.promotionId);
  if (promotionId) result.promotion_id ||= promotionId;

  const aliases = {
    title: ['title', 'product_name', 'goods_name'],
    product_name: ['product_name', 'title', 'goods_name'],
    shop_name: ['shop_name', 'shopName', 'shop_name_str', 'store_name', 'seller_name', 'merchant_name'],
    min_price: ['min_price', 'price_min'],
    max_price: ['max_price', 'price_max'],
    price: ['price', 'show_price', 'goods_discount_price', 'min_price', 'price_min', 'max_price', 'price_max'],
    sales: ['sales', 'sold_num', 'sales_volume', 'sale_count', 'campagin_sales', 'price_sales_num', 'price_sales_desc'],
  };
  for (const [field, keys] of Object.entries(aliases)) {
    if (result[field]) continue;
    for (const key of keys) {
      const valueText = scalarText(value[key]);
      if (valueText) {
        result[field] = valueText;
        break;
      }
    }
  }

  result.product_name ||= result.title;
  result.title ||= result.product_name;

  for (const item of Object.values(value)) {
    const nested = parseNestedJson(item);
    objectFields(nested || item, result, depth + 1);
  }
}

/** Extract product metadata from a response JSON object or form-encoded body. */
export function extractProductFields(raw) {
  const result = {
    product_id: '',
    promotion_id: '',
    title: '',
    product_name: '',
    shop_name: '',
    min_price: '',
    max_price: '',
    price: '',
    sales: '',
  };
  if (!raw) return result;
  if (typeof raw === 'object') {
    objectFields(raw, result);
    return result;
  }

  for (const candidate of decodedVariants(raw)) {
    try {
      objectFields(JSON.parse(candidate), result);
    } catch {
      // Try form fields and direct regexes.
    }

    try {
      const queryCandidates = [candidate];
      const question = candidate.indexOf('?');
      if (question >= 0) queryCandidates.push(candidate.slice(question + 1).split('#', 1)[0]);
      for (const queryCandidate of queryCandidates) {
        const params = new URLSearchParams(queryCandidate);
        for (const key of ['goods_detail', 'basic_info', 'pass_through_params', 'common_params', 'data', 'result']) {
          const nested = params.get(key);
          if (nested) {
            try {
              objectFields(JSON.parse(nested), result);
            } catch {
              objectFields(extractProductFields(nested), result);
            }
          }
        }
        result.product_id ||= extractProductId(queryCandidate);
        result.promotion_id ||= validId(params.get('promotion_id') || params.get('promotion_ids'));
      }
    } catch {
      result.product_id ||= extractProductId(candidate);
    }

    result.product_id ||= extractProductId(candidate);
    if (result.product_id) break;
  }
  return result;
}

export function extractShareUrl(raw) {
  const match = text(raw).match(SHARE_URL_RE);
  if (!match) return '';
  return `${match[0].replace(/\/+$/, '')}/`;
}

export function isProductUrl(url) {
  return PRODUCT_URL_RE.test(text(url));
}

export function isProductBody(body) {
  return PRODUCT_BODY_RE.test(text(body));
}

export function makeEvent({
  run_id = '',
  event,
  stage = '',
  source = 'collector',
  ts = Date.now(),
  ...fields
}) {
  const productName = fields.product_name || fields.title || '';
  const title = fields.title || fields.product_name || '';
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: randomUUID(),
    run_id,
    ts: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
    event,
    stage,
    source,
    product_id: fields.product_id || '',
    promotion_id: fields.promotion_id || '',
    share_url: fields.share_url || '',
    title,
    product_name: productName,
    shop_name: fields.shop_name || '',
    min_price: fields.min_price || '',
    max_price: fields.max_price || '',
    price: fields.price || '',
    sales: fields.sales || '',
    url: fields.url || '',
    class: fields.class || '',
    method: fields.method || '',
    value: fields.value || '',
    ...fields,
    title,
    product_name: productName,
  };
}

function productStage(payloadStage, url, kind) {
  const stage = text(payloadStage).toLowerCase();
  const target = text(url);
  if (stage.includes('response') || kind === 'response' || kind === 'gson') {
    if (isProductUrl(target) || isProductBody(payloadStage)) return 'detail_response';
  }
  if (EC_GOODS_DETAIL_RE.test(target) || stage.includes('ec_goods_detail')) return 'ec_goods_detail';
  if (target.includes('/shorten/')) return 'shorten_request';
  if (target.includes('/social/before_share')) return 'before_share';
  if (isProductUrl(target)) return 'detail_request';
  if (stage) return text(payloadStage);
  return 'product_signal';
}

function shareStage(payloadStage, kind, url) {
  const value = `${text(payloadStage)} ${text(kind)} ${text(url)}`.toLowerCase();
  if (value.includes('clipboard') || value.includes('setprimaryclip')) return 'clipboard';
  if (value.includes('intent')) return 'intent';
  if (value.includes('shorten')) return 'shorten_response';
  return 'share_link';
}

function shareTriggerSource(payload, payloadStage, kind) {
  const className = text(payload?.class || payload?.className).trim();
  const method = text(payload?.method).trim();
  const hook = [className, method].filter(Boolean).join('.');
  return hook || text(payloadStage || kind).trim() || 'unknown';
}

function shareRawValue(payload, allText, shareUrl) {
  return limited(
    payload?.text
      || payload?.value
      || payload?.uri
      || payload?.url
      || payload?.body
      || payload?.share_url
      || allText
      || shareUrl,
  );
}

function payloadText(payload) {
  return [payload.url, payload.uri, payload.value, payload.text, payload.body, payload.params]
    .filter(Boolean)
    .map(text)
    .join('\n');
}

function mergeProductFields(...sources) {
  const result = {
    product_id: '',
    promotion_id: '',
    title: '',
    product_name: '',
    shop_name: '',
    min_price: '',
    max_price: '',
    price: '',
    sales: '',
  };
  for (const source of sources) {
    for (const key of Object.keys(result)) result[key] ||= text(source?.[key]).trim();
  }
  result.product_name ||= result.title;
  result.title ||= result.product_name;
  return result;
}

/** Convert one Frida payload into a raw JSON event plus canonical events. */
export function deriveCanonicalEvents(payload, {
  runId = '',
  receivedAt = Date.now(),
  pid = payload?.pid || '',
} = {}) {
  if (!payload || typeof payload !== 'object') return [];

  if (payload.debug === true) {
    return [makeEvent({
      run_id: runId,
      event: 'runtime_debug',
      stage: text(payload.stage || 'debug'),
      source: 'frida',
      ts: payload.ts || receivedAt,
      pid,
      class: payload.class || payload.className || '',
      method: payload.method || '',
      url: text(payload.url || ''),
      value: limited(payload.value || payload.target || payload.class_name || ''),
      class_name: text(payload.class_name || ''),
      length: payload.length ?? '',
      debug: true,
      raw: payload,
    })];
  }

  const payloadStage = payload.stage || payload.event || payload.type || payload.kind || 'unknown';
  const kind = text(payload.kind || payload.type || payload.event || '');
  const url = text(payload.url || '');
  const body = text(payload.body || '');
  const allText = payloadText(payload);
  const bodyFields = extractProductFields(body);
  const allFields = mergeProductFields(
    extractProductFields(payload.params),
    extractProductFields(url),
    extractProductFields(payload.uri),
    extractProductFields(payload.value),
    extractProductFields(payload.text),
    extractProductFields(allText),
  );
  const product_id = validId(payload.product_id || payload.productId || payload.extractedProductId)
    || bodyFields.product_id
    || allFields.product_id
    || extractProductId(allText);
  const promotion_id = validId(payload.promotion_id || payload.promotionId)
    || bodyFields.promotion_id
    || allFields.promotion_id
    || '';
  const productFields = {
    ...bodyFields,
    ...allFields,
    product_id,
    promotion_id,
  };
  productFields.title = text(
    payload.title
      || payload.product_name
      || bodyFields.title
      || allFields.title
      || allFields.product_name,
  ).trim();
  productFields.product_name = text(
    payload.product_name
      || payload.title
      || bodyFields.product_name
      || allFields.product_name
      || productFields.title,
  ).trim();
  productFields.title ||= productFields.product_name;
  productFields.shop_name = text(payload.shop_name || bodyFields.shop_name || allFields.shop_name).trim();
  productFields.min_price = text(payload.min_price || bodyFields.min_price || allFields.min_price).trim();
  productFields.max_price = text(payload.max_price || bodyFields.max_price || allFields.max_price).trim();
  productFields.price = text(payload.price || bodyFields.price || allFields.price).trim();
  productFields.sales = text(payload.sales || bodyFields.sales || allFields.sales).trim();

  const rawEvent = makeEvent({
    run_id: runId,
    event: 'frida_event',
    stage: text(payloadStage),
    source: 'frida',
    ts: payload.ts || receivedAt,
    pid,
    class: payload.class || payload.className || '',
    method: payload.method || '',
    url,
    value: limited(payload.value || payload.text || payload.body || payload.uri || ''),
    trigger_source: payload.trigger_source || '',
    share_url_raw: limited(payload.share_url_raw || ''),
    product_id_detected: payload.product_id_detected ?? '',
    share_url_detected: payload.share_url_detected ?? '',
    raw: payload,
  });
  const events = [rawEvent];

  // A generic ecom request can contain the app's device/install `iid` and is
  // not a product signal.  Only accept an explicit agent signal, a confirmed
  // product URL/body, or a structured product stage.  This prevents cold-start
  // requests from becoming fake product_found events.
  const structuredProductStage = /^(ec_goods_detail|home_page_product_found|product_detail_response|detail_response|gson_field_hit)$/i.test(text(payloadStage));
  const productSignal = Boolean(
    product_id
    && (
      payload.product_signal === true
      || isProductUrl(url)
      || isProductBody(body)
      || (structuredProductStage && Boolean(
        productFields.title
        || productFields.product_name
        || productFields.shop_name
        || productFields.price
        || productFields.sales
        || promotion_id
      ))
    )
    && !/^(clipboard|share_link|share_found)$/i.test(text(payloadStage))
  );
  if (productSignal) {
    events.push(makeEvent({
      run_id: runId,
      event: 'product_found',
      stage: productStage(payloadStage, url, kind),
      source: text(payload.source || 'frida') || 'frida',
      ts: payload.ts || receivedAt,
      pid,
      product_id,
      promotion_id,
      title: productFields.title,
      product_name: productFields.product_name,
      shop_name: productFields.shop_name,
      min_price: productFields.min_price,
      max_price: productFields.max_price,
      price: productFields.price,
      sales: productFields.sales,
      url,
      class: payload.class || payload.className || '',
      method: payload.method || '',
      value: limited(payload.value || payload.body || payload.uri || payload.text || ''),
      raw_event_id: rawEvent.event_id,
    }));
  }

  const share_url = text(payload.share_url || '')
    ? extractShareUrl(payload.share_url) || text(payload.share_url)
    : extractShareUrl(allText);
  const shareHookDebug = /^share_hook_debug$/i.test(text(payloadStage));
  if (share_url && !shareHookDebug) {
    const trigger_source = shareTriggerSource(payload, payloadStage, kind);
    const share_url_raw = shareRawValue(payload, allText, share_url);
    const shareFields = extractProductFields(payload.goods_detail || payload.share_info || body);
    events.push(makeEvent({
      run_id: runId,
      event: 'share_found',
      stage: shareStage(payloadStage, kind, url),
      source: 'frida',
      ts: payload.ts || receivedAt,
      pid,
      product_id,
      promotion_id,
      share_url,
      title: text(payload.title || shareFields.title || productFields.title).trim(),
      product_name: text(
        payload.product_name
          || payload.title
          || shareFields.product_name
          || productFields.product_name
          || productFields.title,
      ).trim(),
      shop_name: text(payload.shop_name || shareFields.shop_name || '').trim(),
      url,
      class: payload.class || payload.className || '',
      method: payload.method || '',
      value: limited(payload.text || payload.value || payload.body || share_url),
      trigger_source,
      share_url_raw,
      raw_event_id: rawEvent.event_id,
    }));
  }

  return events;
}

function nearestProduct(products, ts, productId = '') {
  const candidates = products.filter((item) => !productId || item.product_id === productId);
  let best = null;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.ts - ts);
    if (!best || distance < best.distance || (distance === best.distance && candidate.ts > best.item.ts)) {
      best = { item: candidate, distance };
    }
  }
  return best;
}

/** Correlates product and share events without changing the source crawler. */
export class ProductShareCorrelator {
  constructor({ runId = '', windowMs = DEFAULT_CORRELATION_WINDOW_MS } = {}) {
    this.runId = runId;
    this.windowMs = windowMs;
    this.productCache = new Map();
    this.shares = [];
    this.links = new Set();
  }

  prune(now) {
    const cutoff = now - this.windowMs;
    for (const [productId, product] of this.productCache) {
      if (product.ts < cutoff) this.productCache.delete(productId);
    }
    this.shares = this.shares.filter((item) => item.ts >= cutoff);
  }

  link(product, share, reason, confidence) {
    if (!product?.product_id || !share?.share_url) return null;
    const key = `${product.product_id}\u0000${share.share_url}`;
    if (this.links.has(key)) return null;
    this.links.add(key);
    share.linked = true;
    return makeEvent({
      run_id: this.runId,
      event: 'product_share_linked',
      stage: 'correlated',
      source: 'collector',
      ts: Math.max(product.ts, share.ts),
      product_id: product.product_id,
      promotion_id: product.promotion_id || share.promotion_id,
      share_url: share.share_url,
      title: product.title || product.product_name || share.title || share.product_name,
      product_name: product.product_name || product.title || share.product_name || share.title,
      shop_name: product.shop_name || share.shop_name,
      min_price: product.min_price || share.min_price,
      max_price: product.max_price || share.max_price,
      price: product.price || share.price,
      sales: product.sales || share.sales,
      url: product.url || share.url,
      correlation_reason: reason,
      confidence,
      trigger_source: share.trigger_source || '',
      share_url_raw: share.share_url_raw || share.share_url,
      product_id_associated: true,
      product_event_id: product.event_id,
      share_event_id: share.event_id,
    });
  }

  correlationDebug(share, {
    ts = share?.ts || Date.now(),
    associatedProductId = '',
    associated = false,
    status = 'pending',
    reason = '',
    confidence = 0,
    productCacheHit = false,
    linkedEventId = '',
  } = {}) {
    return makeEvent({
      run_id: this.runId,
      event: 'share_correlation_debug',
      stage: 'share_correlation',
      source: 'collector',
      ts,
      product_id: associatedProductId || share?.product_id || '',
      share_url: share?.share_url || '',
      value: share?.share_url_raw || share?.share_url || '',
      trigger_source: share?.trigger_source || '',
      share_url_raw: share?.share_url_raw || share?.share_url || '',
      observed_product_id: share?.product_id || '',
      associated_product_id: associatedProductId || '',
      product_id_associated: Boolean(associated),
      association_status: status,
      correlation_reason: reason,
      confidence,
      product_cache_hit: Boolean(productCacheHit),
      share_event_id: share?.event_id || '',
      linked_event_id: linkedEventId,
    });
  }

  accept(event) {
    if (!event || !event.event) return [];
    const ts = Number(event.ts) || Date.now();
    this.prune(ts);
    const generated = [];

    if (event.event === 'product_found' && event.product_id) {
      const previous = this.productCache.get(event.product_id) || {};
      const product = {
        product_id: event.product_id || previous.product_id,
        promotion_id: event.promotion_id || previous.promotion_id || '',
        title: event.title || event.product_name || previous.title || previous.product_name || '',
        product_name: event.product_name || event.title || previous.product_name || previous.title || '',
        shop_name: event.shop_name || previous.shop_name || '',
        min_price: event.min_price || previous.min_price || '',
        max_price: event.max_price || previous.max_price || '',
        price: event.price || previous.price || '',
        sales: event.sales || previous.sales || '',
        url: event.url || previous.url || '',
        event_id: event.event_id || previous.event_id,
        ts: Math.max(previous.ts || 0, ts),
      };
      this.productCache.set(product.product_id, product);
      for (const share of this.shares) {
        if (share.linked) continue;

        // A share can arrive before its product response. In that case an
        // explicit product_id must be matched when the product is cached
        // later; the old `share.product_id` skip made this path impossible.
        let nearest = null;
        let reason = 'time_window';
        let confidence = 0.75;
        if (share.product_id) {
          if (share.product_id !== product.product_id) continue;
          nearest = { item: product, distance: Math.abs(product.ts - share.ts) };
          reason = 'explicit_product_id';
          confidence = 1;
        } else {
          nearest = nearestProduct([...this.productCache.values()], share.ts);
          if (!nearest || nearest.item.product_id !== product.product_id) continue;
        }

        if (nearest && nearest.distance <= this.windowMs) {
          const linked = this.link(nearest.item, share, reason, confidence);
          if (linked) {
            generated.push(linked);
            generated.push(this.correlationDebug(share, {
              ts: linked.ts,
              associatedProductId: nearest.item.product_id,
              associated: true,
              status: 'linked',
              reason,
              confidence,
              productCacheHit: true,
              linkedEventId: linked.event_id,
            }));
          }
        }
      }
    }

    if (event.event === 'share_found' && event.share_url) {
      const share = {
        share_url: event.share_url,
        product_id: event.product_id || '',
        promotion_id: event.promotion_id || '',
        title: event.title || '',
        product_name: event.product_name || event.title || '',
        shop_name: event.shop_name || '',
        min_price: event.min_price || '',
        max_price: event.max_price || '',
        price: event.price || '',
        sales: event.sales || '',
        url: event.url || '',
        trigger_source: event.trigger_source || '',
        share_url_raw: event.share_url_raw || event.value || event.share_url || '',
        event_id: event.event_id,
        ts,
        linked: false,
      };
      this.shares.push(share);
      const nearest = nearestProduct([...this.productCache.values()], ts, share.product_id);
      if (nearest && nearest.distance <= this.windowMs) {
        const reason = share.product_id ? 'explicit_product_id' : 'time_window';
        const confidence = share.product_id ? 1 : 0.75;
        const linked = this.link(nearest.item, share, reason, confidence);
        if (linked) {
          generated.push(linked);
          generated.push(this.correlationDebug(share, {
            ts: linked.ts,
            associatedProductId: nearest.item.product_id,
            associated: true,
            status: 'linked',
            reason,
            confidence,
            productCacheHit: true,
            linkedEventId: linked.event_id,
          }));
        }
      } else {
        generated.push(this.correlationDebug(share, {
          ts,
          associatedProductId: '',
          associated: false,
          status: share.product_id ? 'waiting_for_product' : 'waiting_for_time_window_product',
          reason: share.product_id ? 'explicit_product_id_not_cached' : 'no_product_in_window',
          confidence: 0,
          productCacheHit: false,
        }));
      }
    }

    return generated;
  }
}
