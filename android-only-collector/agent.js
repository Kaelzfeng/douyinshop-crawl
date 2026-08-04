import Java from 'frida-java-bridge';

'use strict';

// Standalone Frida agent for the Android-only collector.
// It intentionally emits plain JSON payloads and does not import the old crawler hooks.

const SCHEMA_VERSION = 1;
const MAX_VALUE = 16_000;
const RESPONSE_MAX_VALUE = 120_000;
const PRODUCT_DETAIL_STREAM_RE = /ecom\/product\/detail\/stream/i;
const PRODUCT_URL_RE = /ecom\/product\/detail\/pack|ecom\/product\/detail\/stream|promotion\/pack|ec_goods_detail/i;
const PRODUCT_REQUEST_RE = /ecom|product|detail|pack|promotion/i;
const PRODUCT_RESPONSE_RE = /product_id|productId|promotion_id|promotionId|promotion_ids|promotionIds|goods_id|goodsId|goods_detail|shop_info|shop_name|store_name|title|price|sales/i;
const SEARCH_RESPONSE_URL_RE = /aweme\/v2\/ecom\/search\/mid_page\/section_data|aweme\/v3\/shop\/search\/aggregate\/shopping\/stream/i;
const INTERESTING_URL_RE = /shorten|v\.douyin|haohuo|goods_detail|ec_goods|product_id|promotion_id|jinritemai|ecom|promotion\/pack|social\/before_share|share|sslocal/i;
const SHARE_URL_RE = /https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/i;
const EC_GOODS_DETAIL_RE = /^sslocal:\/\/ec_goods_detail(?:[?#]|$)/i;
const DEBUG_MODE = typeof globalThis !== 'undefined' && globalThis.__ANDROID_COLLECTOR_DEBUG__ === true;
const DEBUG_LIFECYCLE_RE = /^(agent_loaded|ready|hooked|hook_failed|hook_error)$/;
const GSON_DEBUG_PREVIEW_LENGTH = 200;
const GSON_DEBUG_KEYWORDS = ['product', 'promotion', 'goods', 'item', 'sku', 'shop', 'store', 'seller', 'title', 'price', 'sales', 'id'];
const GSON_DEBUG_MAX_PATH_HITS = 512;
const PRODUCT_DEBUG_KEY_RE = /shop|store|seller|merchant|sales|sold|sale|volume|count|num|price|title|name|product|goods|promotion|desc/i;
const PRODUCT_DEBUG_PRIORITY_KEY_RE = /shop|store|seller|merchant|sales|sold|sale|volume|count|num|subtitle|sub_title/i;
const PRODUCT_SALES_DEBUG_KEY_RE = /sales|sale|sold|volume|count|buyer/i;
const PRODUCT_DEBUG_MAX_PATHS = 256;
const PRODUCT_SALES_DEBUG_MAX_PATHS = 256;
const HOME_PAGE_DTO_CLASS = 'com.bytedance.android.legou.shopping.api.mall.model.HomePageDTO';
const HOME_PAGE_PRODUCT_SOURCE = 'HomePageDTO';
const PRODUCT_DETAIL_FIELD_RE = {
  product_id: /["'](?:product_id|productId)["']\s*:/i,
  promotion_id: /["'](?:promotion_id|promotionId|promotion_ids|promotionIds)["']\s*:/i,
  title: /["'](?:title|real_title)["']\s*:/i,
  price: /["'](?:price|min_price|max_price|show_price)["']\s*:/i,
  sales: /["'](?:sales|sold_num|sales_num|sales_count|sold_count|sale_num|sales_volume|sale_count|price_sales_num|price_sales_desc)["']\s*:/i,
  shop_name: /["'](?:shop_name|shopName|shop_title|shopTitle|store_name|seller_name|merchant_name|shop_info|shop)["']\s*:/i,
};
let lastProductUrl = '';
let current_product_request = false;
let current_product_request_url = '';
let current_product_context_id = '';
let current_product_context_ts = 0;
const PRODUCT_SHARE_CONTEXT_MS = 120_000;
let lastResponseBodyUrl = '';
const responseBodyHookedClasses = new Set();
const responseBodyMethodCache = new Map();
let teeInputStreamClass = null;
const TEE_INPUT_STREAM_MAX_BYTES = 4 * 1024 * 1024;

function asText(value) {
  if (value === null || value === undefined) return '';
  try { return String(value); } catch (_) { return ''; }
}

function targetClassName(value) {
  if (!value) return '';
  try {
    const name = value.getName();
    if (name) return asText(name);
  } catch (_) {}
  try {
    const typeName = value.getTypeName();
    if (typeName) return asText(typeName);
  } catch (_) {}
  try {
    if (value.$className) return asText(value.$className);
  } catch (_) {}
  try {
    const name = value.getClass().getName();
    if (name) return asText(name);
  } catch (_) {}
  return asText(value);
}

function scanGsonJsonPaths(json) {
  let root;
  try {
    root = JSON.parse(asText(json));
  } catch (_) {
    return { hits: [], truncated: false };
  }

  const hits = [];
  const pending = [{ value: root, path: '' }];
  let truncated = false;
  while (pending.length > 0) {
    const current = pending.pop();
    const value = current.value;
    const path = current.path;
    if (typeof value === 'string') {
      const nested = parseJsonValue(value);
      if (nested && typeof nested === 'object') {
        pending.push({
          value: nested,
          path: `${path}<json>`,
        });
      }
      continue;
    }
    if (!value || typeof value !== 'object') continue;

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: value[index],
          path: path ? `${path}[${index}]` : `[${index}]`,
        });
      }
      continue;
    }

    const keys = Object.keys(value);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const childPath = path ? `${path}.${key}` : key;
      const lowerKey = key.toLowerCase();
      if (GSON_DEBUG_KEYWORDS.some((keyword) => lowerKey.includes(keyword))) {
        if (hits.length < GSON_DEBUG_MAX_PATH_HITS) {
          hits.push({ key, path: childPath });
        } else {
          truncated = true;
        }
      }
      pending.push({ value: value[key], path: childPath });
    }
  }
  return { hits, truncated };
}

function isHomePageDto(className) {
  const value = asText(className).trim();
  return value === HOME_PAGE_DTO_CLASS || value.endsWith('.HomePageDTO');
}

function firstHomePageScalar(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstHomePageScalar(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') return '';
  return asText(value).trim();
}

function findHomePageField(value, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === 'string') {
      const parsed = parseJsonValue(current);
      if (parsed && typeof parsed === 'object') pending.push(parsed);
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
      continue;
    }
    if (typeof current !== 'object') continue;

    const entries = Object.entries(current);
    for (const [key, child] of entries) {
      if (!wanted.has(key.toLowerCase())) continue;
      const found = firstHomePageScalar(child);
      if (found) return found;
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      pending.push(entries[index][1]);
    }
  }
  return '';
}

function firstHomePageField(containers, names) {
  for (const container of containers) {
    const found = findHomePageField(container, names);
    if (found) return found;
  }
  return '';
}

// Confirmed card-model paths:
// CommonData.Product.shop_info.name and ECProductStruct.shop.name.
// Keep `name` scoped to one of those containers so it cannot become a title.
function findShopName(value, depth = 0) {
  if (value === null || value === undefined || depth > 8) return '';
  if (typeof value === 'string') {
    const parsed = parseJsonValue(value);
    return parsed && typeof parsed === 'object' ? findShopName(parsed, depth + 1) : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findShopName(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';

  const directNames = new Set(['shop_name', 'shopname', 'shop_title', 'shoptitle', 'store_name', 'seller_name', 'merchant_name']);
  const containerNames = new Set(['shop_info', 'shopinfo', 'shop']);
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (directNames.has(lower)) {
      const direct = firstHomePageScalar(child);
      if (direct) return direct;
    }
    if (containerNames.has(lower)) {
      if (child && typeof child === 'object') {
        const named = findHomePageField(child, ['name', 'shop_name', 'shopName', 'store_name', 'seller_name']);
        if (named) return named;
      }
      const nested = findShopName(child, depth + 1);
      if (nested) return nested;
    }
  }
  for (const child of Object.values(value)) {
    const nested = findShopName(child, depth + 1);
    if (nested) return nested;
  }
  return '';
}

function homePageProductFields(item) {
  const trackData = item?.track_data || {};
  const common = trackData.track_common_data || {};
  const itemData = item?.item_data;
  const exposureData = trackData.exposure_data;
  const itemContainers = [itemData, exposureData, item];
  const idContainers = [common, itemData, item];
  const product_id = firstHomePageField(idContainers, ['product_id', 'productId']);
  const promotion_id = firstHomePageField(idContainers, ['promotion_id', 'promotionId'])
    || firstHomePageField(idContainers, ['promotion_ids', 'promotionIds']);
  const title = firstHomePageField(itemContainers, ['title', 'goods_name', 'product_name'])
    || firstHomePageField(itemContainers, ['real_title']);
  const shop_name = findShopName(itemData)
    || findShopName(exposureData)
    || findShopName(item);
  const min_price = firstHomePageField(itemContainers, ['min_price', 'price_min']);
  const max_price = firstHomePageField(itemContainers, ['max_price', 'price_max']);
  const price = firstHomePageField(itemContainers, ['show_price', 'price', 'current_price'])
    || firstHomePageField(itemContainers, ['goods_discount_price', 'price_show_num'])
    || min_price
    || max_price;
  const sales = firstHomePageField(itemContainers, ['sales', 'sold_num', 'sales_volume', 'sale_count', 'campagin_sales'])
    || firstHomePageField(itemContainers, ['sales_num', 'price_sales_num', 'price_sales_desc']);
  return {
    product_id,
    promotion_id,
    title,
    product_name: title,
    shop_name,
    min_price,
    max_price,
    price,
    sales,
  };
}

function emitHomePageProducts(json, className, methodName) {
  if (DEBUG_MODE || !isHomePageDto(className)) return 0;
  const root = parseResponseJson(json);
  const sections = root?.bff_data?.feed?.sections;
  if (!Array.isArray(sections)) return 0;

  let count = 0;
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const items = sections[sectionIndex]?.items;
    if (!Array.isArray(items)) continue;
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const fields = homePageProductFields(items[itemIndex]);
      if (!fields.product_id) continue;
      const itemPath = `bff_data.feed.sections[${sectionIndex}].items[${itemIndex}]`;
      emit('home_page_product_found', {
        kind: 'gson',
        class: className,
        method: methodName,
        source: HOME_PAGE_PRODUCT_SOURCE,
        product_schema: HOME_PAGE_PRODUCT_SOURCE,
        product_signal: true,
        value: itemPath,
        item_path: itemPath,
        section_index: sectionIndex,
        item_index: itemIndex,
        ...fields,
      });
      count += 1;
    }
  }
  return count;
}

function cap(value, max = MAX_VALUE) {
  return asText(value).slice(0, max);
}

function shareUrl(value) {
  const match = asText(value).match(SHARE_URL_RE);
  return match ? `${match[0].replace(/\/+$/, '')}/` : '';
}

function decodeQueryPart(value) {
  let current = asText(value).replace(/\+/g, ' ');
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch (_) {
      break;
    }
  }
  return current;
}

function queryValue(uri, wantedKey) {
  const question = asText(uri).indexOf('?');
  if (question < 0) return '';
  const query = asText(uri).slice(question + 1).split('#', 1)[0];
  for (const part of query.split('&')) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const rawKey = separator < 0 ? part : part.slice(0, separator);
    const rawValue = separator < 0 ? '' : part.slice(separator + 1);
    if (decodeQueryPart(rawKey) === wantedKey) return decodeQueryPart(rawValue);
  }
  return '';
}

function parseGoodsDetailFromText(value) {
  const encoded = queryValue(value, 'goods_detail');
  return encoded ? parseJsonValue(encoded) : null;
}

function protectLargeIdNumbers(value) {
  return asText(value).replace(
    /((?:"|\\")?(?:product_id|productId|goods_id|goodsId|promotion_id|promotionId|promotion_ids|promotionIds)(?:"|\\")?\s*:\s*)(-?\d{10,22})(?=\s*[,}\]])/g,
    '$1"$2"',
  );
}

function parseJsonValue(value) {
  let current = asText(value);
  for (let i = 0; i < 3; i += 1) {
    if (!current) return null;
    try {
      const parsed = JSON.parse(protectLargeIdNumbers(current));
      if (typeof parsed === 'string') {
        current = parsed;
        continue;
      }
      return parsed;
    } catch (_) {
      const decoded = decodeQueryPart(current);
      if (decoded === current) return null;
      current = decoded;
    }
  }
  return null;
}

function parseEcGoodsDetail(uri) {
  const value = asText(uri);
  if (!EC_GOODS_DETAIL_RE.test(value)) return null;

  const goodsDetail = parseGoodsDetailFromText(value) || {};
  const product_id = queryValue(value, 'product_id')
    || queryValue(value, 'promotion_id')
    || asText(goodsDetail.product_id || goodsDetail.id);
  const promotion_id = queryValue(value, 'promotion_id')
    || asText(goodsDetail.promotion_id || goodsDetail.promotionId)
    || product_id;
  const title = asText(goodsDetail.title || goodsDetail.product_name);
  return {
    product_id,
    promotion_id,
    title,
    product_name: title,
    sales: asText(goodsDetail.sales),
    min_price: asText(goodsDetail.min_price),
    max_price: asText(goodsDetail.max_price),
    product_schema: 'ec_goods_detail',
    product_signal: Boolean(product_id),
  };
}

function productId(value) {
  const raw = asText(value);
  // `iid` is the app install/device instance id, never a product id.
  const keys = ['product_id', 'promotion_id', 'promotion_ids', 'target_id', 'goods_id'];
  for (const key of keys) {
    const match = raw.match(new RegExp(`(?:^|[?&\\s])${key}=(?:%22|["']?)(\\d{10,22})`, 'i'));
    if (match) return match[1];
    const jsonMatch = raw.match(new RegExp(`(?:["']|%22)${key}(?:["']|%22)\\s*(?:[:=]|%3A)\\s*(?:["']|%22)?(\\d{10,22})`, 'i'));
    if (jsonMatch) return jsonMatch[1];
  }
  return '';
}

function rememberProductContext(value) {
  const id = validResponseId(value);
  if (!id) return '';
  current_product_context_id = id;
  current_product_context_ts = Date.now();
  return id;
}

function shareProductId(value) {
  const direct = productId(value);
  if (direct) return direct;
  if (!shareUrl(value)) return '';
  if (!current_product_context_id) return '';
  if (Date.now() - current_product_context_ts > PRODUCT_SHARE_CONTEXT_MS) return '';
  return current_product_context_id;
}

function isProductRequestUrl(value) {
  return PRODUCT_REQUEST_RE.test(asText(value));
}

function isProductDetailStreamUrl(value) {
  return PRODUCT_DETAIL_STREAM_RE.test(asText(value));
}

function markProductDetailRequest(url) {
  const value = asText(url);
  if (!isProductDetailStreamUrl(value)) return false;
  current_product_request = true;
  current_product_request_url = value;
  lastProductUrl = value;
  return true;
}

function currentProductDetailResponseUrl(responseUrlValue = '') {
  const value = asText(responseUrlValue);
  if (isProductDetailStreamUrl(value)) {
    markProductDetailRequest(value);
    return value;
  }
  if (value) return '';
  if (current_product_request && isProductDetailStreamUrl(current_product_request_url)) {
    return current_product_request_url;
  }
  return '';
}

function validResponseId(value) {
  const candidate = asText(value).trim().replace(/^['"]|['"]$/g, '');
  return /^\d{10,22}$/.test(candidate) ? candidate : '';
}

function scalarResponseValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  return asText(value).trim();
}

// Search-card payloads expose display metadata as a compact material string.
// These paths were confirmed at runtime in dynamic_patch.custom_server_data.
function materialContentFields(value) {
  const text = scalarResponseValue(value);
  if (!text) return { sales: '', shop_name: '' };

  const salesSection = (
    text.match(/\u533a\u57df\u540d\u79f0\s*:\s*sales\s+\u5185\u5bb9\s*:\s*\[([^\]]*)\]/i) || []
  )[1] || '';
  const sales = (
    salesSection.match(/\u7d20\u6750\u5185\u5bb9\s*:\s*([^;\]]+)/) || []
  )[1]?.trim() || '';

  const actionSection = (
    text.match(/\u533a\u57df\u540d\u79f0\s*:\s*action_info\s+\u5185\u5bb9\s*:\s*\[([^\]]*)\]/i) || []
  )[1] || '';
  const shop_name = (
    actionSection.match(/\u7d20\u6750id\s*:\s*601\s*,\s*\u7d20\u6750\u5185\u5bb9\s*:\s*([^;\]]+)/i) || []
  )[1]?.trim() || '';

  return { sales, shop_name };
}

function parseResponseJson(value) {
  let current = asText(value).trim();
  for (let index = 0; index < 3 && current; index += 1) {
    try {
      const parsed = JSON.parse(protectLargeIdNumbers(current));
      if (typeof parsed === 'string') {
        current = parsed;
        continue;
      }
      return parsed;
    } catch (_) {
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break;
        current = decoded;
      } catch (__) {
        break;
      }
    }
  }
  return null;
}

function jsonDocumentEnd(text, start) {
  const opening = text[start];
  if (opening !== '{' && opening !== '[') return -1;
  const stack = [opening === '{' ? '}' : ']'];
  let quoted = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') stack.push('}');
    else if (character === '[') stack.push(']');
    else if (character === '}' || character === ']') {
      if (stack[stack.length - 1] !== character) return -1;
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

function parseResponseJsonDocuments(value) {
  const text = asText(value).trim();
  if (!text) return [];
  const documents = [];
  let cursor = 0;
  while (cursor < text.length && documents.length < 32) {
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (cursor >= text.length) break;
    const end = jsonDocumentEnd(text, cursor);
    if (end < 0) break;
    const document = parseResponseJson(text.slice(cursor, end));
    if (document !== null && typeof document === 'object') documents.push(document);
    cursor = end;
  }
  if (documents.length === 0) {
    const document = parseResponseJson(text);
    if (document !== null && typeof document === 'object') documents.push(document);
  }
  return documents;
}

function scanResponseFields(value, result, depth = 0) {
  if (!value || depth > 12) return;
  if (Array.isArray(value)) {
    for (const item of value) scanResponseFields(item, result, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const entries = Object.entries(value);
  const localProduct = entries.some(([key]) => /product|goods|promotion|price|sales|title|shop/i.test(key));
  if (depth === 0 && !result.shop_name) result.shop_name = findShopName(value);
  for (const [key, child] of entries) {
    const lower = key.toLowerCase();
    const scalar = scalarResponseValue(child);
    const goodsDetail = scalar ? parseGoodsDetailFromText(scalar) : null;
    if (lower.replace(/_/g, '') === 'materialcontentinfo' && scalar) {
      const material = materialContentFields(scalar);
      result.sales ||= material.sales;
      result.shop_name ||= material.shop_name;
    }
    if (/^(product_id|productid|goods_id|goodsid)$/.test(lower) && !result.product_id) {
      result.product_id = validResponseId(child);
    }
    if (/^(promotion_id|promotionid)$/.test(lower) && !result.promotion_id) {
      result.promotion_id = validResponseId(child);
    }
    if (/^promotion_ids?$/.test(lower) && !result.promotion_id) {
      if (Array.isArray(child)) {
        for (const item of child) {
          result.promotion_id ||= validResponseId(item);
          if (result.promotion_id) break;
        }
      } else {
        result.promotion_id = validResponseId(child);
      }
    }
    if (/^(title|goods_name|product_name|product_title)$/.test(lower) && scalar) {
      result.title ||= scalar;
      result.product_name ||= scalar;
    }
    if (lower === 'name' && scalar && localProduct && !result.title) {
      result.title = scalar;
    }
    if (/^(price|min_price|max_price|sale_price|current_price|show_price|goods_discount_price|product_price)$/.test(lower) && scalar) {
      if (!result.price || lower === 'price') result.price = scalar;
      if (lower === 'min_price' && !result.min_price) result.min_price = scalar;
      if (lower === 'max_price' && !result.max_price) result.max_price = scalar;
    }
    if (/^(sales|sold_num|sales_num|sales_count|sold_count|sale_num|sale_count|sales_volume|sale_text|sold_text|sales_desc|campagin_sales|price_sales_num|price_sales_desc|product_sales)$/.test(lower) && scalar && !result.sales) {
      result.sales = scalar;
    }
    if (lower === 'id' && localProduct && !result.product_id) {
      result.product_id = validResponseId(child);
    }
    if (goodsDetail && typeof goodsDetail === 'object') {
      scanResponseFields(goodsDetail, result, depth + 1);
    }
  }

  for (const child of Object.values(value)) {
    const nested = typeof child === 'string' ? parseJsonValue(child) : null;
    scanResponseFields(nested || child, result, depth + 1);
  }
}

function firstRawResponseId(value, keys) {
  for (const key of keys) {
    const found = idForKey(value, key);
    if (found) return found;
  }
  return '';
}

function findProductObject(value, depth = 0) {
  if (!value || depth > 16) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProductObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const hasProductId = Object.entries(value).some(([key, child]) => (
    /^(product_id|productid|goods_id|goodsid|promotion_id|promotionid)$/.test(key.toLowerCase())
    && validResponseId(child)
  ));
  if (hasProductId) return value;
  for (const child of Object.values(value)) {
    const found = findProductObject(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function collectContentTokens(value, output, depth = 0) {
  if (!value || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectContentTokens(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === 'content' && scalarResponseValue(child)) output.push(scalarResponseValue(child));
    else collectContentTokens(child, output, depth + 1);
  }
}

function displayPrice(value, depth = 0) {
  if (value === null || value === undefined || depth > 8) return '';
  const scalar = scalarResponseValue(value);
  if (scalar) return scalar;
  if (Array.isArray(value)) {
    const tokens = [];
    collectContentTokens(value, tokens);
    const joined = tokens.join('').trim();
    if (/\d/.test(joined)) return joined.replace(/^¥\s*/u, '');
    for (const item of value) {
      const found = displayPrice(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['show_price', 'min_price', 'max_price', 'price', 'product_price']) {
    const found = displayPrice(value[key], depth + 1);
    if (found) return found;
  }
  for (const key of ['effective_price', 'price_info']) {
    const found = displayPrice(value[key], depth + 1);
    if (found) return found;
  }
  return '';
}

function debugScalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return cap(value, 400);
  try { return cap(JSON.stringify(value), 800); } catch (_) { return cap(value, 400); }
}

function productObjectDebugSnapshot(candidate) {
  const known = new Set([
    'product_id', 'productid', 'promotion_id', 'promotionid', 'title', 'product_name',
    'shop_name', 'shopname', 'price', 'min_price', 'max_price', 'sales',
  ]);
  const topLevelKeys = Object.keys(candidate || {});
  const unknownTopLevelKeys = topLevelKeys.filter((key) => !known.has(key.toLowerCase()));
  const fieldPaths = [];
  const priorityFieldPaths = [];
  const salesFieldPaths = [];
  let visited = 0;
  let truncated = false;

  function walk(value, path, depth) {
    if (!value || depth > 8 || visited > 2_000) {
      if (visited > 2_000) truncated = true;
      return;
    }
    if (typeof value === 'string') {
      const goodsDetail = parseGoodsDetailFromText(value);
      if (goodsDetail && typeof goodsDetail === 'object') {
        walk(goodsDetail, `${path}.goods_detail`, depth + 1);
      }
      const parsed = parseJsonValue(value);
      if (parsed && typeof parsed === 'object') walk(parsed, `${path}<json>`, depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < Math.min(value.length, 32); index += 1) {
        walk(value[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      visited += 1;
      const childPath = path ? `${path}.${key}` : key;
      if (PRODUCT_DEBUG_KEY_RE.test(key)) {
        if (fieldPaths.length < PRODUCT_DEBUG_MAX_PATHS) {
          fieldPaths.push({ key, path: childPath, value: debugScalar(child) });
        } else {
          truncated = true;
        }
      }
      if (PRODUCT_DEBUG_PRIORITY_KEY_RE.test(key) && priorityFieldPaths.length < PRODUCT_DEBUG_MAX_PATHS) {
        priorityFieldPaths.push({ key, path: childPath, value: debugScalar(child) });
      }
      if (PRODUCT_SALES_DEBUG_KEY_RE.test(key)) {
        if (salesFieldPaths.length < PRODUCT_SALES_DEBUG_MAX_PATHS) {
          salesFieldPaths.push({ key, path: childPath, value: debugScalar(child) });
        } else {
          truncated = true;
        }
      }
      if (child !== null && child !== undefined) walk(child, childPath, depth + 1);
    }
  }

  walk(candidate, '', 0);
  return {
    top_level_keys: topLevelKeys,
    unknown_top_level_keys: unknownTopLevelKeys,
    field_paths: fieldPaths,
    field_path_count: fieldPaths.length,
    priority_field_paths: priorityFieldPaths,
    sales_field_paths: salesFieldPaths,
    sales_field_path_count: salesFieldPaths.length,
    truncated,
  };
}

function emitProductObjectDebug(candidate, extracted, responseRoot) {
  try {
    const snapshot = productObjectDebugSnapshot(candidate);
    const responseSnapshot = responseRoot && responseRoot !== candidate
      ? productObjectDebugSnapshot(responseRoot)
      : null;
    const debug = {
      extracted: {
        product_id: extracted.product_id || '',
        product_name: extracted.product_name || extracted.title || '',
        shop_name: extracted.shop_name || '',
        price: extracted.price || '',
        sales: extracted.sales || '',
      },
      ...snapshot,
      response_priority_field_paths: responseSnapshot?.priority_field_paths || [],
      response_sales_field_paths: responseSnapshot?.sales_field_paths || [],
    };
    emit('product_fields_debug', {
      kind: 'product_fields_debug',
      source: 'frida',
      class: 'android-only.product-parser',
      method: 'preferredResponseFields',
      product_id: extracted.product_id || '',
      product_signal: false,
      value: cap(JSON.stringify(debug), 12_000),
      fields: debug,
    });
  } catch (error) {
    emit('hook_error', { target: 'product_fields_debug', error: cap(error) });
  }
}

function preferredResponseFields(value) {
  const candidate = findProductObject(value);
  if (!candidate) return null;
  const result = {
    product_id: '',
    promotion_id: '',
    title: '',
    product_name: '',
    min_price: '',
    max_price: '',
    price: '',
    sales: '',
    shop_name: '',
  };
  scanResponseFields(candidate, result);
  result.product_name ||= scalarResponseValue(candidate.product_name || candidate.goods_name || candidate.title);
  result.title ||= result.product_name;
  result.price ||= displayPrice(candidate.effective_price || candidate.price_info || candidate.price);
  result.shop_name ||= findShopName(value);
  emitProductObjectDebug(candidate, result, value);
  return result;
}

function extractResponseProductFields(body) {
  const raw = asText(body).slice(0, RESPONSE_MAX_VALUE);
  const result = {
    product_id: firstRawResponseId(raw, ['product_id', 'productId', 'goods_id', 'goodsId', 'promotion_id', 'promotionId', 'promotion_ids', 'promotionIds']) || productId(raw),
    promotion_id: firstRawResponseId(raw, ['promotion_id', 'promotionId', 'promotion_ids', 'promotionIds']),
    title: '',
    product_name: '',
    min_price: '',
    max_price: '',
    price: '',
    sales: '',
    shop_name: '',
  };
  const parsed = parseResponseJson(raw);
  scanResponseFields(parsed, result);
  const preferred = preferredResponseFields(parsed);
  if (preferred) {
    for (const key of Object.keys(result)) {
      if (preferred[key]) result[key] = preferred[key];
    }
  }
  result.product_id ||= productId(raw);
  result.promotion_id ||= firstRawResponseId(raw, ['promotion_id', 'promotionId']);
  result.product_name ||= result.title;
  result.title ||= result.product_name;
  return result;
}

function directResponseProductId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const [key, child] of Object.entries(value)) {
    if (/^(product_id|productid|goods_id|goodsid|promotion_id|promotionid)$/.test(key.toLowerCase())) {
      const id = validResponseId(child);
      if (id) return id;
    }
  }
  return '';
}

function responseProductObjectScore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  let score = 0;
  for (const key of Object.keys(value)) {
    const lower = key.toLowerCase();
    if (/^(title|real_title|goods_name|product_name|product_title)$/.test(lower)) score += 4;
    else if (/^(sales|sold_num|sales_num|sales_count|sold_count|sale_num|sale_count|sales_volume|sale_text|sold_text|sales_desc|campagin_sales|price_sales_num|price_sales_desc|product_sales)$/.test(lower)) score += 4;
    else if (/^(shop_info|shop|shop_name|shopname|shop_title|shoptitle|store_name|seller_name|merchant_name)$/.test(lower)) score += 4;
    else if (/^material_?content_?info$/.test(lower)) score += 8;
    else if (/^(price|min_price|max_price|sale_price|current_price|show_price|goods_discount_price|product_price|price_info|effective_price)$/.test(lower)) score += 3;
    else if (/product|goods|promotion|sku|card|track/i.test(lower)) score += 1;
  }
  return score;
}

function isBroadProductCollection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    Array.isArray(child)
    && child.length > 1
    && /^(products?|items?|cards?|goods|sections?|list|feeds?)$/i.test(key)
  ));
}

function responseProductEnvelope(value, path, ancestors) {
  let best = { value, path, score: responseProductObjectScore(value) };
  const first = Math.max(0, ancestors.length - 6);
  for (let index = ancestors.length - 1; index >= first; index -= 1) {
    const ancestor = ancestors[index];
    if (!ancestor?.value || typeof ancestor.value !== 'object' || Array.isArray(ancestor.value)) continue;
    if (isBroadProductCollection(ancestor.value)) continue;
    const keys = Object.keys(ancestor.value);
    const normalizedKeys = keys.map((key) => key.toLowerCase());
    const hasSplitAwemePayload = normalizedKeys.includes('anchor_info') && normalizedKeys.includes('rawdata');
    const hasCardFields = keys.some((key) => (
      /^(title|real_title|goods_name|product_name|product_title|shop_info|shop|shop_name|shopname|shop_title|shoptitle|store_name|seller_name|merchant_name|price|min_price|max_price|sale_price|current_price|show_price|goods_discount_price|product_price|price_info|effective_price|sales|sold_num|sales_num|sales_count|sold_count|sale_num|sale_count|sales_volume|sale_text|sold_text|sales_desc|campagin_sales|price_sales_num|price_sales_desc|product_sales|material_?content_?info)$/i.test(key)
    ));
    if (!hasCardFields && !hasSplitAwemePayload) continue;
    // In split aweme cards, product fields live in anchor_info.extra while the
    // confirmed shop fields live in the sibling rawdata JSON. Prefer that
    // single-card envelope even when the anchor object has many scored keys.
    const score = responseProductObjectScore(ancestor.value) + (hasSplitAwemePayload ? 32 : 0);
    if (score > best.score) best = { value: ancestor.value, path: ancestor.path, score };
  }
  return best;
}

function collectResponseProductObjects(value, candidates, state, path = '', depth = 0, ancestors = []) {
  if (value === null || value === undefined || depth > 18 || state.nodes >= 30_000) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || (text[0] !== '{' && text[0] !== '[')) return;
    for (const document of parseResponseJsonDocuments(text)) {
      collectResponseProductObjects(document, candidates, state, `${path}<json>`, depth + 1, ancestors);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && state.nodes < 30_000; index += 1) {
      collectResponseProductObjects(value[index], candidates, state, `${path}[${index}]`, depth + 1, ancestors);
    }
    return;
  }
  if (typeof value !== 'object') return;

  state.nodes += 1;
  const product_id = directResponseProductId(value);
  if (product_id) {
    const existing = candidates.get(product_id);
    const envelope = responseProductEnvelope(value, path, ancestors);
    if (!existing || envelope.score > existing.score) {
      candidates.set(product_id, { product_id, ...envelope });
    }
  }
  const nextAncestors = [...ancestors, { value, path }].slice(-6);
  for (const [key, child] of Object.entries(value)) {
    collectResponseProductObjects(child, candidates, state, path ? `${path}.${key}` : key, depth + 1, nextAncestors);
  }
}

function responseProductCandidateFields(candidate) {
  const value = candidate?.value;
  const result = {
    product_id: candidate?.product_id || '',
    promotion_id: '',
    title: '',
    product_name: '',
    min_price: '',
    max_price: '',
    price: '',
    sales: '',
    shop_name: '',
  };
  scanResponseFields(value, result);
  result.product_id ||= candidate?.product_id || '';
  result.product_name ||= scalarResponseValue(value?.product_name || value?.product_title || value?.goods_name || value?.title);
  result.title ||= result.product_name;
  result.price ||= displayPrice(value?.effective_price || value?.price_info || value?.price || value?.product_price);
  result.shop_name ||= findShopName(value);
  return result;
}

function responseProductCandidates(body, parsedDocuments = null) {
  const candidates = new Map();
  const state = { nodes: 0 };
  const documents = parsedDocuments || parseResponseJsonDocuments(body);
  for (const document of documents) {
    collectResponseProductObjects(document, candidates, state);
  }
  return Array.from(candidates.values()).slice(0, 256);
}

function bytesToText(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (typeof bytes === 'string') return bytes;
  try {
    let output = '';
    for (let index = 0; index < bytes.length; index += 1) {
      let code = Number(bytes[index]);
      if (code < 0) code += 256;
      output += String.fromCharCode(code);
    }
    return output;
  } catch (_) {
    return '';
  }
}

function byteValue(bytes, index) {
  let value = Number(bytes[index]);
  if (value < 0) value += 256;
  return value;
}

function decodeChunkedBytes(bytes) {
  if (!bytes || typeof bytes === 'string') return bytes;
  let offset = 0;
  let sawChunk = false;
  let outputStream = null;
  try {
    const ByteArrayOutputStream = getClass('java.io.ByteArrayOutputStream');
    if (!ByteArrayOutputStream) return bytes;
    while (offset < bytes.length) {
      let lineEnd = -1;
      let lineTerminatorLength = 0;
      for (let index = offset; index < bytes.length; index += 1) {
        const value = byteValue(bytes, index);
        if (value === 10) {
          lineEnd = index;
          lineTerminatorLength = index > offset && byteValue(bytes, index - 1) === 13 ? 2 : 1;
          break;
        }
      }
      if (lineEnd < 0) return sawChunk && outputStream ? outputStream.toByteArray() : bytes;

      let sizeLine = '';
      const sizeLineEnd = lineEnd - (lineTerminatorLength === 2 ? 1 : 0);
      for (let index = offset; index < sizeLineEnd; index += 1) {
        sizeLine += String.fromCharCode(byteValue(bytes, index));
      }
      const sizeToken = sizeLine.split(';', 1)[0].trim();
      if (!/^[0-9a-f]+$/i.test(sizeToken)) {
        return sawChunk && outputStream ? outputStream.toByteArray() : bytes;
      }
      const chunkSize = parseInt(sizeToken, 16);
      if (!Number.isFinite(chunkSize)) return bytes;
      sawChunk = true;
      if (!outputStream) outputStream = ByteArrayOutputStream.$new();
      offset = lineEnd + 1;
      if (chunkSize === 0) return outputStream.toByteArray();
      if (offset + chunkSize > bytes.length) return bytes;
      outputStream.write(bytes, offset, chunkSize);
      offset += chunkSize;
      if (offset + 1 < bytes.length && byteValue(bytes, offset) === 13 && byteValue(bytes, offset + 1) === 10) {
        offset += 2;
      } else if (offset < bytes.length && byteValue(bytes, offset) === 10) {
        offset += 1;
      } else {
        return bytes;
      }
    }
  } catch (_) {
    return bytes;
  } finally {
    try { if (outputStream) outputStream.close(); } catch (_) {}
  }
  return sawChunk && outputStream ? outputStream.toByteArray() : bytes;
}

function bytesToUtf8Text(bytes) {
  if (!bytes || typeof bytes === 'string') return '';
  try {
    const StringClass = getClass('java.lang.String');
    if (!StringClass) return '';
    const constructor = StringClass.$new.overload('[B', 'java.lang.String');
    return asText(constructor.call(StringClass, bytes, 'UTF-8'));
  } catch (_) {}
  return '';
}

function responseBodyText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const normalized = decodeChunkedBytes(value);
  return bytesToUtf8Text(normalized) || bytesToText(normalized);
}

function bodyBytes(body) {
  if (!body) return null;
  try {
    if (body.getOriginBody) return body.getOriginBody();
  } catch (_) {}
  try {
    if (body.getBytes) return body.getBytes();
  } catch (_) {}
  return null;
}

function bodyMimeType(body) {
  if (!body) return '';
  try { return asText(body.mimeType()); } catch (_) {}
  return '';
}

function bodyDeclaredLength(body) {
  if (!body) return 0;
  try { return Number(body.length()) || 0; } catch (_) {}
  return 0;
}

// BaseSsCall$1 is a streaming response-body wrapper.  Its byte accessors are
// not exposed consistently by Frida, while the existing runtime hook proved
// that the actual bytes can be read through in(). Keep this fallback debug
// scoped and bounded until one real response has been identified.
function bodyInputStreamBytes(body) {
  if (!body) return null;
  let inputStream = null;
  let outputStream = null;
  try {
    if (!body.in) return null;
    inputStream = body.in();
    if (!inputStream) return null;
    const ByteArrayOutputStream = getClass('java.io.ByteArrayOutputStream');
    if (!ByteArrayOutputStream) return null;
    outputStream = ByteArrayOutputStream.$new();
    const buffer = Java.array('byte', new Array(8_192).fill(0));
    let total = 0;
    let loops = 0;
    const maxBytes = 4 * 1024 * 1024;
    while (loops < 2_048 && total < maxBytes) {
      const count = Number(inputStream.read(buffer));
      if (count < 0) break;
      if (count === 0) {
        loops += 1;
        continue;
      }
      const writable = Math.min(count, maxBytes - total);
      outputStream.write(buffer, 0, writable);
      total += writable;
      loops += 1;
      if (writable < count) break;
    }
    return outputStream.toByteArray();
  } catch (_) {
    return null;
  } finally {
    try { if (inputStream) inputStream.close(); } catch (_) {}
    try { if (outputStream) outputStream.close(); } catch (_) {}
  }
}

// BaseSsCall$1.in() is the real response-body read boundary.  Reading it
// directly consumes the stream and makes the app report a network error.  A
// small Java InputStream proxy lets the app consume the original stream while
// copying the same bytes to the collector at EOF.
function getTeeInputStreamClass() {
  if (teeInputStreamClass) return teeInputStreamClass;
  try {
    const FilterInputStream = getClass('java.io.FilterInputStream');
    const ByteArrayOutputStream = getClass('java.io.ByteArrayOutputStream');
    if (!FilterInputStream || !ByteArrayOutputStream) return null;
    teeInputStreamClass = Java.registerClass({
      name: `com.reverse_lab.androidcollector.TeeInputStream${Process.id}`,
      superClass: FilterInputStream,
      fields: {
        collector_delegate: 'java.io.InputStream',
        collector_buffer: 'java.io.ByteArrayOutputStream',
        collector_url: 'java.lang.String',
        collector_class: 'java.lang.String',
        collector_total: 'int',
        collector_read_calls: 'int',
        collector_done: 'boolean',
      },
      methods: {
        '$init': [{
          returnType: 'void',
          argumentTypes: ['java.io.InputStream'],
          implementation: function (delegate) {
            this.$super.$init(delegate);
            this.collector_delegate.value = delegate;
            this.collector_buffer.value = ByteArrayOutputStream.$new();
            this.collector_total.value = 0;
            this.collector_read_calls.value = 0;
            this.collector_done.value = false;
          },
        }],
        read: [
          {
            returnType: 'int',
            argumentTypes: [],
            implementation: function () {
              noteTeeRead(this, 'read()');
              const result = this.$super.read();
              if (Number(result) < 0) finishTeeInputStream(this);
              else appendTeeByte(this, result);
              return result;
            },
          },
          {
            returnType: 'int',
            argumentTypes: ['[B'],
            implementation: function (buffer) {
              noteTeeRead(this, 'read([B)');
              const result = this.$super.read(buffer);
              if (Number(result) < 0) finishTeeInputStream(this);
              else appendTeeBytes(this, buffer, 0, Number(result));
              return result;
            },
          },
          {
            returnType: 'int',
            argumentTypes: ['[B', 'int', 'int'],
            implementation: function (buffer, offset, length) {
              noteTeeRead(this, 'read([B,int,int)');
              const result = this.$super.read(buffer, offset, length);
              if (Number(result) < 0) finishTeeInputStream(this);
              else appendTeeBytes(this, buffer, Number(offset), Number(result));
              return result;
            },
          },
        ],
        available: {
          returnType: 'int',
          argumentTypes: [],
          implementation: function () {
            try { return this.$super.available(); } catch (_) { return 0; }
          },
        },
        close: {
          returnType: 'void',
          argumentTypes: [],
          implementation: function () {
            finishTeeInputStream(this);
            try { this.$super.close(); } catch (_) {}
          },
        },
        skip: {
          returnType: 'long',
          argumentTypes: ['long'],
          implementation: function (count) {
            try { return this.$super.skip(count); } catch (_) { return 0; }
          },
        },
        mark: {
          returnType: 'void',
          argumentTypes: ['int'],
          implementation: function (limit) {
            try { this.$super.mark(limit); } catch (_) {}
          },
        },
        reset: {
          returnType: 'void',
          argumentTypes: [],
          implementation: function () {
            try { this.$super.reset(); } catch (_) {}
          },
        },
        markSupported: {
          returnType: 'boolean',
          argumentTypes: [],
          implementation: function () {
            try { return this.$super.markSupported(); } catch (_) { return false; }
          },
        },
      },
    });
  } catch (error) {
    emitDebug('runtime_debug_tee_class_failed', { error: cap(error) });
    teeInputStreamClass = null;
  }
  return teeInputStreamClass;
}

function appendTeeByte(wrapper, value) {
  try {
    if (Number(wrapper.collector_total.value) >= TEE_INPUT_STREAM_MAX_BYTES) return;
    const byte = Java.array('byte', [Number(value) & 0xff]);
    wrapper.collector_buffer.value.write(byte, 0, 1);
    wrapper.collector_total.value = Number(wrapper.collector_total.value) + 1;
  } catch (_) {}
}

function noteTeeRead(wrapper, method) {
  try {
    const calls = Number(wrapper.collector_read_calls.value) || 0;
    wrapper.collector_read_calls.value = calls + 1;
    if (calls === 0) {
      emit('response_body_tee_read', {
        kind: 'response_body_tee_read',
        method,
        url: cap(asText(wrapper.collector_url.value), 4_000),
      });
    }
  } catch (_) {}
}

function appendTeeBytes(wrapper, bytes, offset, count) {
  try {
    if (!bytes || count <= 0 || Number(wrapper.collector_total.value) >= TEE_INPUT_STREAM_MAX_BYTES) return;
    const writable = Math.min(count, TEE_INPUT_STREAM_MAX_BYTES - Number(wrapper.collector_total.value));
    if (writable <= 0) return;
    wrapper.collector_buffer.value.write(bytes, offset, writable);
    wrapper.collector_total.value = Number(wrapper.collector_total.value) + writable;
  } catch (_) {}
}

function finishTeeInputStream(wrapper) {
  try {
    if (!wrapper || wrapper.collector_done.value) return;
    wrapper.collector_done.value = true;
    const buffer = wrapper.collector_buffer.value;
    const bytes = buffer ? buffer.toByteArray() : null;
    emit('response_body_tee_finish', {
      kind: 'response_body_tee_finish',
      url: cap(asText(wrapper.collector_url.value), 4_000),
      bytes: byteLength(bytes),
      reads: Number(wrapper.collector_read_calls.value) || 0,
    });
    if (!bytes || byteLength(bytes) === 0) return;
    const url = asText(wrapper.collector_url.value);
    const className = asText(wrapper.collector_class.value) || 'java.io.InputStream';
    const text = responseBodyText(bytes);
    const candidate = extractResponseProductFields(text);
    emit('response_body_tee_parse', {
      kind: 'response_body_tee_parse',
      url: cap(url, 4_000),
      response_length: text.length,
      json_preview: cap(text, 200),
      contains_product_id: /product_id|productId|goods_id|goodsId/i.test(text),
      candidate_product_id: candidate.product_id || '',
      candidate_title: candidate.title || candidate.product_name || '',
      candidate_shop_name: candidate.shop_name || '',
      candidate_price: candidate.price || '',
      candidate_sales: candidate.sales || '',
    });
    handleResponseBodyValue(bytes, url, className, 'in.tee');
  } catch (error) {
    emitDebug('runtime_debug_tee_finish_failed', { error: cap(error) });
  }
}

function wrapResponseInputStream(input, url, className) {
  if (!input || DEBUG_MODE || !SEARCH_RESPONSE_URL_RE.test(asText(url))) return input;
  try {
    const inputClass = javaObjectClassName(input);
    if (/androidcollector\.TeeInputStream/i.test(inputClass)) return input;
    const Wrapper = getTeeInputStreamClass();
    if (!Wrapper) return input;
    const wrapper = Wrapper.$new(input);
    wrapper.collector_url.value = asText(url);
    wrapper.collector_class.value = asText(className);
    emit('response_body_tee', {
      kind: 'response_body_tee',
      url: cap(url, 4_000),
      input_class: inputClass,
      wrapper_class: asText(Wrapper.$className || javaObjectClassName(wrapper)),
    });
    return wrapper;
  } catch (error) {
    emit('response_body_tee_failed', {
      url: cap(url, 4_000),
      error: cap(error),
    });
    return input;
  }
}

function byteLength(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length;
  try { return Number(value.length) || 0; } catch (_) { return 0; }
}

function javaObjectClassName(value) {
  if (!value) return '';
  try { return asText(value.getClass().getName()); } catch (_) {}
  try { return asText(value.$className); } catch (_) {}
  return '';
}

function responseBodyMethodNames(value) {
  if (!DEBUG_MODE || !value) return [];
  const className = javaObjectClassName(value);
  if (className && responseBodyMethodCache.has(className)) {
    return responseBodyMethodCache.get(className);
  }
  const names = [];
  try {
    const queries = [];
    if (className) queries.push(`${className}*!*/u`);
    queries.push('*BaseSsCall$1*!*/u');
    for (const query of queries) {
      let groups = [];
      try { groups = Java.enumerateMethods(query) || []; } catch (_) { groups = []; }
      for (const group of groups) {
        for (const method of (group.methods || [])) {
          const name = asText(method.name);
          if (name && !names.includes(name)) names.push(name);
          if (names.length >= 64) break;
        }
        if (names.length >= 64) break;
      }
      if (names.length >= 64) break;
    }
  } catch (_) {}
  if (className) responseBodyMethodCache.set(className, names);
  return names;
}

function emitResponseBodyDebug(className, method, value, url = '', bodyObject = null, extra = {}) {
  if (!DEBUG_MODE) return;
  const raw = responseBodyText(value);
  const normalized = decodeChunkedBytes(value);
  emitDebug('runtime_debug_response_body', {
    class: className,
    method,
    url: cap(url, 4_000),
    byte_length: byteLength(value),
    decoded_byte_length: byteLength(normalized),
    length: raw.length,
    preview: cap(raw, 200),
    body_class: javaObjectClassName(bodyObject),
    body_methods: responseBodyMethodNames(bodyObject),
    mime_type: bodyMimeType(bodyObject),
    declared_length: bodyDeclaredLength(bodyObject),
    ...extra,
  });
}

function responseUrl(response) {
  try { return asText(response.getUrl()); } catch (_) { return ''; }
}

function shouldReadResponseBodyStream(url, bodyObject) {
  if (!DEBUG_MODE || !bodyObject || !SEARCH_RESPONSE_URL_RE.test(asText(url))) return false;
  const className = javaObjectClassName(bodyObject);
  return /BaseSsCall\$\d+$/i.test(className);
}

function emitResponseProductCandidates(body, url, className, method) {
  const raw = asText(body);
  if (!raw || !PRODUCT_RESPONSE_RE.test(raw)) return 0;
  const confirmedProductUrl = PRODUCT_URL_RE.test(url);
  const explicitProductBody = /(?:["'])(?:product_id|productId|goods_id|goodsId|promotion_id|promotionId|promotion_ids|promotionIds)(?:["'])\s*[:=]/i.test(raw);
  if (!confirmedProductUrl && !explicitProductBody) return 0;

  const documents = parseResponseJsonDocuments(raw);
  const candidates = responseProductCandidates(raw, documents);
  let emitted = 0;
  for (const candidate of candidates) {
    const fields = responseProductCandidateFields(candidate);
    if (!fields.product_id) continue;
    const numericPrice = Number(String(fields.price || fields.min_price || fields.max_price || '').replace(/[^\d.]/g, ''));
    if (!(numericPrice > 0) && !fields.shop_name && !fields.sales) continue;
    const candidateJson = (() => {
      try { return JSON.stringify(candidate.value); } catch (_) { return ''; }
    })();
    emit('detail_response', {
      kind: 'response_json',
      class: className,
      method,
      url: cap(url, 4_000),
      value: cap(candidateJson, RESPONSE_MAX_VALUE),
      body: cap(candidateJson, RESPONSE_MAX_VALUE),
      ...fields,
      product_schema: 'response_product_candidate',
      product_path: cap(candidate.path, 2_000),
      product_signal: true,
    });
    emitted += 1;
  }
  return emitted;
}

function emitProductResponse(body, url, className, method) {
  if (DEBUG_MODE) return false;
  if (isProductDetailStreamUrl(url)) return false;
  const raw = asText(body);
  if (!raw || !PRODUCT_RESPONSE_RE.test(raw)) return false;
  const candidateCount = emitResponseProductCandidates(raw, url, className, method);
  if (candidateCount > 0) {
    if (PRODUCT_URL_RE.test(url)) lastProductUrl = url;
    return true;
  }
  const fields = extractResponseProductFields(raw);
  const confirmedProductUrl = PRODUCT_URL_RE.test(url);
  const explicitProductBody = /(?:["'])(?:product_id|productId|goods_id|goodsId|promotion_id|promotionId|promotion_ids|promotionIds)(?:["'])\s*[:=]/i.test(raw);
  // Generic ecom/Gson payloads may contain unrelated `id`, `title`, or
  // `price` fields (for example address settings).  They are not products
  // unless the URL or JSON carries an explicit product identifier.
  if (!fields.product_id || (!confirmedProductUrl && !explicitProductBody)) return false;
  if (confirmedProductUrl) lastProductUrl = url;
  emit('detail_response', {
    kind: 'response_json',
    class: className,
    method,
    url: cap(url, 4_000),
    body: cap(raw, RESPONSE_MAX_VALUE),
    ...fields,
    product_schema: 'response_json',
    product_signal: true,
  });
  return true;
}

function extractProductDetailStreamFields(raw) {
  const fields = extractResponseProductFields(raw);
  const parsed = parseResponseJson(raw);
  if (parsed) {
    fields.product_id ||= findHomePageField(parsed, ['product_id', 'productId']);
    fields.promotion_id ||= findHomePageField(parsed, ['promotion_id', 'promotionId', 'promotion_ids', 'promotionIds']);
    fields.title ||= findHomePageField(parsed, ['title', 'real_title']);
    fields.product_name ||= findHomePageField(parsed, ['product_name', 'title', 'real_title']);
    fields.price ||= findHomePageField(parsed, ['price', 'min_price', 'max_price', 'show_price']);
    fields.sales ||= findHomePageField(parsed, ['sales', 'sold_num', 'sales_volume', 'sale_count', 'price_sales_num', 'price_sales_desc']);
    fields.shop_name ||= findShopName(parsed);
  }
  fields.product_name ||= fields.title;
  fields.title ||= fields.product_name;
  return fields;
}

function emitProductDetailStreamResponse(body, url, className, method) {
  const raw = asText(body);
  const responseUrlValue = currentProductDetailResponseUrl(url);
  if (!raw || !responseUrlValue) return false;

  // The marker belongs to one response. Keeping it set makes unrelated
  // response bodies look like product-detail payloads and steadily increases
  // CPU/memory usage during a long session.
  current_product_request = false;
  current_product_request_url = '';

  const debugFields = {
    class: className,
    method,
    url: cap(responseUrlValue, 4_000),
    response_length: raw.length,
    json_preview: cap(raw, GSON_DEBUG_PREVIEW_LENGTH),
    contains_product_id: PRODUCT_DETAIL_FIELD_RE.product_id.test(raw),
    contains_promotion_id: PRODUCT_DETAIL_FIELD_RE.promotion_id.test(raw),
    contains_title: PRODUCT_DETAIL_FIELD_RE.title.test(raw),
    contains_price: PRODUCT_DETAIL_FIELD_RE.price.test(raw),
    contains_sales: PRODUCT_DETAIL_FIELD_RE.sales.test(raw),
    contains_shop_name: PRODUCT_DETAIL_FIELD_RE.shop_name.test(raw),
  };
  emitDebug('product_detail_response_debug', debugFields);
  if (DEBUG_MODE) return false;

  const fields = extractProductDetailStreamFields(raw);
  const completeProduct = Boolean(
    debugFields.contains_product_id
    && debugFields.contains_promotion_id
    && debugFields.contains_title
    && debugFields.contains_price
    && debugFields.contains_sales
    && fields.product_id
    && fields.promotion_id
    && fields.title
    && fields.price
    && fields.sales,
  );
  if (!completeProduct) return false;

  emit('detail_response', {
    kind: 'response_json',
    class: className,
    method,
    url: cap(responseUrlValue, 4_000),
    value: debugFields.json_preview,
    ...fields,
    product_schema: 'product_detail_stream',
    product_signal: true,
  });
  return true;
}

function handleResponseBodyValue(value, url, className, method) {
  emitResponseBodyDebug(className, method, value, url);
  const body = responseBodyText(value);
  if (!body) return;
  const detailUrl = currentProductDetailResponseUrl(url);
  if (detailUrl) {
    emitProductDetailStreamResponse(body, detailUrl, className, method);
  } else {
    emitProductResponse(body, url || lastProductUrl, className, method);
  }
}

function hookConcreteResponseBodyClass(className) {
  if (!className || responseBodyHookedClasses.has(className)) return;
  if (!/BaseSsCall\$\d+$/i.test(className)) return;
  responseBodyHookedClasses.add(className);

  const Owner = getClass(className);
  if (!Owner) {
    emitDebug('runtime_debug_response_body_class', { class_name: className, methods: [], error: 'class_not_found' });
    return;
  }

  const wrapperKeys = [];
  try {
    for (const key of Object.getOwnPropertyNames(Owner)) {
      if (key && !wrapperKeys.includes(key)) wrapperKeys.push(key);
    }
  } catch (_) {}
  try {
    for (const key of Object.keys(Owner)) {
      if (key && !wrapperKeys.includes(key)) wrapperKeys.push(key);
    }
  } catch (_) {}
  let wrapperMethods = [];
  try {
    if (Array.isArray(Owner.$methods)) wrapperMethods = Owner.$methods.slice(0, 128).map(asText);
  } catch (_) {}

  const candidateMethods = ['bytes', 'string', 'getBytes', 'getOriginBody', 'byteStream', 'content', 'getContent', 'getBody'];
  const hookedMethods = [];
  for (const methodName of candidateMethods) {
    try {
      if (!Owner[methodName]) continue;
      const overloads = Owner[methodName].overloads || [Owner[methodName]];
      for (const overload of overloads) {
        overload.implementation = function () {
          let result;
          try {
            result = overload.apply(this, arguments);
          } catch (error) {
            emit('hook_error', { target: `${className}.${methodName}`, error: cap(error) });
            throw error;
          }
          try {
            handleResponseBodyValue(result, lastResponseBodyUrl || lastProductUrl, className, methodName);
          } catch (error) {
            emitDebug('runtime_debug_response_body_error', {
              class_name: className,
              method: methodName,
              error: cap(error),
            });
          }
          return result;
        };
      }
      hookedMethods.push(methodName);
    } catch (error) {
      emitDebug('runtime_debug_response_body_hook_failed', {
        class_name: className,
        method: methodName,
        error: cap(error),
      });
    }
  }
  if (!DEBUG_MODE) {
    try {
      if (Owner.in) {
        const overloads = Owner.in.overloads || [Owner.in];
        for (const overload of overloads) {
          overload.implementation = function () {
            let result;
            try {
              result = overload.apply(this, arguments);
            } catch (error) {
              emit('hook_error', { target: `${className}.in`, error: cap(error) });
              throw error;
            }
            return wrapResponseInputStream(
              result,
              lastResponseBodyUrl || lastProductUrl,
              className,
            );
          };
        }
        hookedMethods.push('in(tee)');
      }
    } catch (error) {
      emitDebug('runtime_debug_response_body_hook_failed', {
        class_name: className,
        method: 'in(tee)',
        error: cap(error),
      });
    }
  }
  emitDebug('runtime_debug_response_body_class', {
    class_name: className,
    methods: hookedMethods,
    wrapper_keys: wrapperKeys.slice(0, 128),
    wrapper_methods: wrapperMethods,
  });
}

function emitDebug(stage, fields = {}) {
  if (!DEBUG_MODE) return;
  emit(stage, { debug: true, ...fields });
}

function emit(stage, fields = {}) {
  if (DEBUG_MODE && fields.debug !== true && !DEBUG_LIFECYCLE_RE.test(stage)) return;
  try {
    send({
      schema_version: SCHEMA_VERSION,
      event: 'frida_event',
      stage,
      ts: Date.now(),
      pid: Process.id,
      ...fields,
    });
  } catch (_) {
    // A hook must never break the host application because event serialization failed.
  }
}

function emitShareHookDebug(triggerSource, raw, extra = {}) {
  if (!DEBUG_MODE) return;
  const rawValue = cap(raw, 8_000);
  if (!rawValue) return;
  const url = shareUrl(rawValue);
  const product_id = shareProductId(rawValue);
  emit('share_hook_debug', {
    kind: 'share_hook_debug',
    source: 'frida',
    trigger_source: triggerSource,
    share_url_raw: rawValue,
    share_url: url,
    product_id,
    product_id_detected: Boolean(product_id),
    share_url_detected: Boolean(url),
    ...extra,
  });
}

function interesting(url, body = '') {
  return INTERESTING_URL_RE.test(`${asText(url)} ${asText(body)}`);
}

function shouldEmitLinkEvent(value) {
  const raw = asText(value);
  return DEBUG_MODE
    || Boolean(shareUrl(raw))
    || Boolean(productId(raw))
    || EC_GOODS_DETAIL_RE.test(raw)
    || PRODUCT_URL_RE.test(raw);
}

function getClass(name) {
  try { return Java.use(name); } catch (_) {}
  try {
    for (const loader of Java.enumerateClassLoadersSync()) {
      try { return loader.use(name); } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function hookAllOverloads(className, methodName, target, callback) {
  try {
    const Owner = getClass(className);
    if (!Owner || !Owner[methodName]) throw new Error('class or method not found');
    const overloads = Owner[methodName].overloads || [Owner[methodName]];
    for (const overload of overloads) {
      overload.implementation = function () {
        const args = Array.prototype.slice.call(arguments);
        let result;
        try {
          result = overload.apply(this, args);
        } catch (error) {
          emit('hook_error', { target, error: cap(error) });
          throw error;
        }
        try { callback.call(this, args, result); } catch (error) {
          emit('hook_error', { target, error: cap(error) });
        }
        return result;
      };
    }
    emit('hooked', { target, overloads: overloads.length });
    return true;
  } catch (error) {
    emit('hook_failed', { target, error: cap(error) });
    return false;
  }
}

// The bridge payload is a Lynx ReadableMap, not a normal Java Map.  Frida's
// wrapper therefore cannot rely on toHashMap(); read the documented
// ReadableMap/ReadableArray accessors directly and keep the original keys.
const LYNX_CARD_NAME_RE = /^ec\.lynxCard(?:SetData|GetDynamicData)$/i;
const LYNX_MAX_DEPTH = 10;
const LYNX_MAX_NODES = 2_500;
const LYNX_MAX_ENTRIES = 256;
let lynxReadableMapClass = null;
let lynxReadableArrayClass = null;
let lynxRecentCardFingerprint = '';
let lynxRecentCardAt = 0;

function lynxClassName(value) {
  if (!value) return '';
  try { return asText(value.getClass().getName()); } catch (_) {}
  try { return asText(value.$className); } catch (_) {}
  return '';
}

function lynxLoadTypes() {
  if (!lynxReadableMapClass) {
    try { lynxReadableMapClass = getClass('com.lynx.react.bridge.ReadableMap'); } catch (_) {}
  }
  if (!lynxReadableArrayClass) {
    try { lynxReadableArrayClass = getClass('com.lynx.react.bridge.ReadableArray'); } catch (_) {}
  }
}

function lynxIsMap(value) {
  if (!value) return false;
  lynxLoadTypes();
  try {
    if (lynxReadableMapClass && lynxReadableMapClass.class.isInstance(value)) return true;
  } catch (_) {}
  return /(?:ReadableMap|JavaOnlyMap|Map$)/i.test(lynxClassName(value));
}

function lynxIsArray(value) {
  if (!value) return false;
  lynxLoadTypes();
  try {
    if (lynxReadableArrayClass && lynxReadableArrayClass.class.isInstance(value)) return true;
  } catch (_) {}
  return /(?:ReadableArray|JavaOnlyArray|ArrayList|List$)/i.test(lynxClassName(value));
}

function lynxCall(receiver, methodName, args = []) {
  // JavaOnlyMap often does not expose ReadableMap methods on its concrete
  // Frida wrapper. Cast it to the interface first; this is the same runtime
  // object and keeps the existing event/schema logic unchanged.
  try {
    lynxLoadTypes();
    if (lynxReadableMapClass && lynxReadableMapClass.class.isInstance(receiver)) {
      const mapView = Java.cast(receiver, lynxReadableMapClass);
      const mapMember = mapView && mapView[methodName];
      if (mapMember) return mapMember.apply(mapView, args);
    }
  } catch (_) {}
  try {
    lynxLoadTypes();
    if (lynxReadableArrayClass && lynxReadableArrayClass.class.isInstance(receiver)) {
      const arrayView = Java.cast(receiver, lynxReadableArrayClass);
      const arrayMember = arrayView && arrayView[methodName];
      if (arrayMember) return arrayMember.apply(arrayView, args);
    }
  } catch (_) {}
  const member = receiver && receiver[methodName];
  if (!member) {
    let lastError = null;
    try {
      const methods = receiver.getClass().getMethods();
      for (let index = 0; index < methods.length; index += 1) {
        const method = methods[index];
        if (asText(method.getName()) !== methodName) continue;
        if (Number(method.getParameterTypes().length) !== args.length) continue;
        try {
          return method.invoke(receiver, Java.array('java.lang.Object', args));
        } catch (error) {
          lastError = error;
        }
      }
    } catch (error) {
      lastError = error;
    }
    if (lastError) throw lastError;
    throw new Error(`method not found: ${methodName}`);
  }
  try { return member.apply(receiver, args); } catch (first) {
    if (!member.overload) throw first;
    const signatures = args.map((arg) => typeof arg === 'number' ? 'int' : 'java.lang.String');
    try { return member.overload(...signatures).call(receiver, ...args); } catch (_) { throw first; }
  }
}

function lynxNumber(value) {
  const raw = asText(value).trim();
  if (/^-?\d+$/.test(raw) && raw.replace(/^-/, '').length > 15) return raw;
  const number = Number(raw);
  return Number.isFinite(number) ? number : raw;
}

function lynxReadableValue(map, key, state, depth) {
  let type = '';
  try { type = asText(lynxCall(map, 'getType', [key])).toLowerCase(); } catch (_) {}
  if (type.includes('null')) return null;
  if (type.includes('boolean')) {
    try { return Boolean(lynxCall(map, 'getBoolean', [key])); } catch (_) {}
  }
  if (type.includes('number')) {
    try { return lynxNumber(lynxCall(map, 'getDouble', [key])); } catch (_) {}
    try { return lynxNumber(lynxCall(map, 'getLong', [key])); } catch (_) {}
    try { return lynxNumber(lynxCall(map, 'getInt', [key])); } catch (_) {}
  }
  if (type.includes('string')) {
    try { return cap(lynxCall(map, 'getString', [key])); } catch (_) {}
  }
  if (type.includes('map')) {
    try { return lynxSerialize(lynxCall(map, 'getMap', [key]), state, depth + 1); } catch (_) {}
  }
  if (type.includes('array')) {
    try { return lynxSerialize(lynxCall(map, 'getArray', [key]), state, depth + 1); } catch (_) {}
  }
  if (type.includes('dynamic')) {
    try { return lynxSerializeDynamic(lynxCall(map, 'getDynamic', [key]), state, depth + 1); } catch (_) {}
  }

  for (const [methodName, converter] of [
    ['getString', (value) => cap(value)],
    ['getMap', (value) => lynxSerialize(value, state, depth + 1)],
    ['getArray', (value) => lynxSerialize(value, state, depth + 1)],
    ['getDynamic', (value) => lynxSerializeDynamic(value, state, depth + 1)],
  ]) {
    try { return converter(lynxCall(map, methodName, [key])); } catch (_) {}
  }
  return `<unreadable:${type}>`;
}

function lynxMapToObject(map, state, depth) {
  const result = {};
  let iterator;
  let hasNextMethod = 'hasNextKey';
  let nextMethod = 'nextKey';
  let entryIterator = false;
  try {
    iterator = lynxCall(map, 'keySetIterator', []);
  } catch (_) {
    try {
      // This Lynx JavaOnlyMap exposes entries directly, but not the
      // ReadableMap keySetIterator()/java.util.Map keySet() methods.
      iterator = lynxCall(map, 'getEntryIterator', []);
      hasNextMethod = 'hasNext';
      nextMethod = 'next';
      entryIterator = true;
    } catch (_) {
      const keySet = lynxCall(map, 'keySet', []);
      iterator = lynxCall(keySet, 'iterator', []);
      hasNextMethod = 'hasNext';
      nextMethod = 'next';
    }
  }
  let count = 0;
  while (count < LYNX_MAX_ENTRIES && Boolean(lynxCall(iterator, hasNextMethod, []))) {
    const next = lynxCall(iterator, nextMethod, []);
    if (entryIterator) {
      const key = asText(lynxCall(next, 'getKey', []));
      result[key] = lynxSerialize(lynxCall(next, 'getValue', []), state, depth + 1);
    } else {
      const key = asText(next);
      result[key] = lynxReadableValue(map, key, state, depth + 1);
    }
    count += 1;
  }
  if (count >= LYNX_MAX_ENTRIES) result.__ec_truncated__ = 'max_entries';
  return result;
}

function lynxArrayToArray(array, state, depth) {
  const result = [];
  const size = Number(lynxCall(array, 'size', []));
  const limit = Math.min(Number.isFinite(size) ? size : 0, LYNX_MAX_ENTRIES);
  for (let index = 0; index < limit; index += 1) {
    let type = '';
    try { type = asText(lynxCall(array, 'getType', [index])).toLowerCase(); } catch (_) {}
    if (type.includes('null')) result.push(null);
    else if (type.includes('boolean')) result.push(Boolean(lynxCall(array, 'getBoolean', [index])));
    else if (type.includes('number')) result.push(lynxNumber(lynxCall(array, 'getDouble', [index])));
    else if (type.includes('string')) result.push(cap(lynxCall(array, 'getString', [index])));
    else if (type.includes('map')) result.push(lynxSerialize(lynxCall(array, 'getMap', [index]), state, depth + 1));
    else if (type.includes('array')) result.push(lynxSerialize(lynxCall(array, 'getArray', [index]), state, depth + 1));
    else {
      try { result.push(lynxSerializeDynamic(lynxCall(array, 'getDynamic', [index]), state, depth + 1)); }
      catch (_) { result.push(`<unreadable:${type}>`); }
    }
  }
  if (size > limit) result.push('__ec_truncated__:max_entries');
  return result;
}

function lynxSerializeDynamic(dynamic, state, depth) {
  if (!dynamic) return null;
  for (const [methodName, converter] of [
    ['asMap', (value) => lynxSerialize(value, state, depth + 1)],
    ['asArray', (value) => lynxSerialize(value, state, depth + 1)],
    ['asString', (value) => cap(value)],
    ['asBoolean', (value) => Boolean(value)],
    ['asDouble', (value) => lynxNumber(value)],
  ]) {
    try { return converter(lynxCall(dynamic, methodName, [])); } catch (_) {}
  }
  return cap(dynamic, 5_000);
}

function lynxSerialize(value, state = { nodes: 0 }, depth = 0) {
  if (value === null || value === undefined) return null;
  state.nodes += 1;
  if (state.nodes > LYNX_MAX_NODES) return '__ec_truncated__:max_nodes';
  if (depth > LYNX_MAX_DEPTH) return '__ec_truncated__:max_depth';
  if (typeof value === 'string' || typeof value === 'boolean') return typeof value === 'string' ? cap(value) : value;
  if (typeof value === 'number') return value;
  const name = lynxClassName(value);
  if (/java\.lang\.String$/.test(name)) return cap(value);
  if (/java\.lang\.Boolean$/.test(name)) return asText(value).toLowerCase() === 'true';
  if (/java\.lang\.(?:Byte|Short|Integer|Long|Float|Double|BigDecimal|BigInteger)$/.test(name)) return lynxNumber(value);
  if (lynxIsMap(value)) return lynxMapToObject(value, state, depth);
  if (lynxIsArray(value)) return lynxArrayToArray(value, state, depth);
  return cap(value, 5_000);
}

function lynxCardNameFromArgs(args) {
  for (const arg of args) {
    const value = asText(arg).trim();
    if (/^ec\./i.test(value)) return value;
  }
  return '';
}

function lynxParamsFromArgs(args) {
  for (const arg of args) {
    if (lynxIsMap(arg) || lynxIsArray(arg)) return arg;
  }
  return null;
}

function lynxBridgeCallName(call) {
  for (const methodName of ['getName', 'getMethodName', 'getBridgeName', 'getUrl']) {
    try {
      const value = asText(lynxCall(call, methodName, [])).trim();
      if (value) return value;
    } catch (_) {}
  }
  return '';
}

function emitLynxCardData(name, params, source) {
  const cardName = asText(name).trim();
  if (!LYNX_CARD_NAME_RE.test(cardName) || !params) return false;
  if (/GetDynamicData$/i.test(cardName)) return true;
  let serialized;
  try {
    serialized = lynxSerialize(params);
  } catch (error) {
    emit('hook_error', {
      target: 'ec.lynxCardSetData.params',
      error: cap(error),
      params_class: lynxClassName(params),
    });
    return false;
  }
  let json = '';
  try { json = JSON.stringify(serialized); } catch (_) { json = asText(serialized); }
  const now = Date.now();
  const fingerprint = `${cardName}|${json}`;
  if (fingerprint === lynxRecentCardFingerprint && now - lynxRecentCardAt < 250) return true;
  lynxRecentCardFingerprint = fingerprint;
  lynxRecentCardAt = now;

  const fields = extractResponseProductFields(json);
  emit('ec_card_data', {
    kind: 'lynx_card',
    class: 'com.bytedance.sdk.xbridge.cn.platform.lynx.LynxBridgeCall',
    method: source || 'ec.lynxCardSetData',
    name: cardName,
    params: serialized,
    value: cap(json),
    ...fields,
    product_name: fields.product_name || fields.title,
    product_signal: Boolean(fields.product_id),
    product_schema: 'ec_lynx_card',
  });
  return true;
}

function hookLynxCardBridge() {
  const className = 'com.bytedance.sdk.xbridge.cn.platform.lynx.LynxBridgeCall';
  const BridgeCall = getClass(className);
  if (!BridgeCall) {
    emit('hook_failed', { target: className, error: 'class not found' });
    return;
  }

  const constructorHooked = hookAllOverloads(className, '$init', `${className}.$init`, (args) => {
    const name = lynxCardNameFromArgs(args);
    if (name) emitLynxCardData(name, lynxParamsFromArgs(args), 'LynxBridgeCall.$init');
  });
  const paramsHooked = hookAllOverloads(className, 'getParams', `${className}.getParams`, function (_args, result) {
    const name = lynxBridgeCallName(this);
    if (name) emitLynxCardData(name, result, 'LynxBridgeCall.getParams');
  });

  let executionHooks = 0;
  for (const executionClass of [
    'com.bytedance.sdk.xbridge.cn.platform.lynx.XBridgeLynxModule',
    'com.bytedance.sdk.xbridge.cn.platform.lynx.LynxBDXBridge',
  ]) {
    const Owner = getClass(executionClass);
    if (!Owner) continue;
    for (const methodName of ['call', 'invoke', 'execute', 'dispatch', 'handle']) {
      if (!Owner[methodName]) continue;
      if (hookAllOverloads(executionClass, methodName, `${executionClass}.${methodName}`, (args) => {
        const name = lynxCardNameFromArgs(args);
        if (name) emitLynxCardData(name, lynxParamsFromArgs(args), `${executionClass}.${methodName}`);
      })) executionHooks += 1;
    }
  }
  emit('hooked', {
    target: 'ec.lynxCardSetData',
    constructor: constructorHooked,
    getParams: paramsHooked,
    execution_hooks: executionHooks,
  });
}

function requestInfo(request, includeBody = true) {
  let url = '';
  let body = '';
  try { url = asText(request.getUrl()); } catch (_) {
    try { url = asText(request.url()); } catch (__) {}
  }
  if (includeBody) try {
    const requestBody = request.getBody ? request.getBody() : request.body();
    if (requestBody) {
      const BAOS = Java.use('java.io.ByteArrayOutputStream');
      const output = BAOS.$new();
      requestBody.writeTo(output);
      body = cap(output.toString('UTF-8'));
    }
  } catch (_) {}
  return { url, body };
}

function requestStage(url, body) {
  const target = `${url} ${body}`;
  if (/\/shorten\//i.test(target)) return 'shorten_request';
  if (/\/social\/before_share/i.test(target)) return 'before_share';
  if (isProductRequestUrl(url)) return 'detail_request';
  return 'request';
}

function isCollectorRequestUrl(value) {
  const url = asText(value);
  return DEBUG_MODE
    || SEARCH_RESPONSE_URL_RE.test(url)
    || PRODUCT_URL_RE.test(url)
    || isProductDetailStreamUrl(url)
    || /\/shorten\/|\/social\/before_share|v\.douyin\.com/i.test(url);
}

function emitRequest(request, kind = 'retrofit') {
  const { url } = requestInfo(request, false);
  if (!interesting(url) || !isCollectorRequestUrl(url)) return;
  const { body } = requestInfo(request, true);
  if (!markProductDetailRequest(url) && isProductRequestUrl(url)) lastProductUrl = url;
  emit(requestStage(url, body), {
    kind: 'request',
    transport: kind,
    class: 'com.bytedance.retrofit2.client.Request',
    method: 'getUrl/getBody',
    url: cap(url, 4_000),
    body,
    product_id: productId(`${url}\n${body}`),
    product_signal: PRODUCT_URL_RE.test(url) || /promotion_ids|basic_info|pass_through_params/i.test(body),
  });
}

function hookClipboard() {
  try {
    const ClipboardManager = getClass('android.content.ClipboardManager');
    if (!ClipboardManager) throw new Error('class not found');
    const original = ClipboardManager.setPrimaryClip.overload('android.content.ClipData');
    original.implementation = function (clip) {
      try {
        const item = clip ? clip.getItemAt(0) : null;
        const value = item ? asText(item.getText()) : '';
        const url = shareUrl(value);
        if (value) {
          emitShareHookDebug('android.content.ClipboardManager.setPrimaryClip', value, {
            share_signal: Boolean(url),
          });
        }
        if (value && url) {
          emit('clipboard', {
            kind: 'clipboard',
            class: 'android.content.ClipboardManager',
            method: 'setPrimaryClip',
            text: cap(value),
            value: cap(value),
            share_url: url,
            product_id: shareProductId(value),
            share_signal: true,
          });
        }
      } catch (error) {
        emit('hook_error', { target: 'ClipboardManager.setPrimaryClip', error: cap(error) });
      }
      return original.call(this, clip);
    };
    emit('hooked', { target: 'ClipboardManager.setPrimaryClip' });
  } catch (error) {
    emit('hook_failed', { target: 'ClipboardManager.setPrimaryClip', error: cap(error) });
  }
}

function hookUriAndUrl() {
  try {
    const Uri = getClass('android.net.Uri');
    const original = Uri.parse.overload('java.lang.String');
    original.implementation = function (value) {
      const uri = asText(value);
      if (interesting(uri) && shouldEmitLinkEvent(uri)) {
        emitShareHookDebug('android.net.Uri.parse', uri);
      }
      const ecGoodsDetail = parseEcGoodsDetail(uri);
      if (ecGoodsDetail) {
        rememberProductContext(ecGoodsDetail.product_id);
        emit('ec_goods_detail', {
          kind: 'ec_goods_detail',
          class: 'android.net.Uri',
          method: 'parse',
          uri: cap(uri, 8_000),
          url: cap(uri, 8_000),
          value: cap(uri, 8_000),
          ...ecGoodsDetail,
        });
      } else if (interesting(uri) && shouldEmitLinkEvent(uri)) {
        emit(shareUrl(uri) ? 'share_link' : (PRODUCT_URL_RE.test(uri) ? 'deeplink' : 'uri'), {
          kind: 'uri',
          class: 'android.net.Uri',
          method: 'parse',
          uri: cap(uri, 4_000),
          url: cap(uri, 4_000),
          share_url: shareUrl(uri),
          product_id: shareProductId(uri) || productId(uri),
          product_signal: PRODUCT_URL_RE.test(uri) || /ec_goods_detail/i.test(uri),
        });
      }
      return original.call(this, value);
    };
    emit('hooked', { target: 'android.net.Uri.parse' });
  } catch (error) {
    emit('hook_failed', { target: 'android.net.Uri.parse', error: cap(error) });
  }

  try {
    const URL = getClass('java.net.URL');
    const original = URL.$init.overload('java.lang.String');
    original.implementation = function (value) {
      const url = asText(value);
      if (interesting(url) && shouldEmitLinkEvent(url)) {
        emitShareHookDebug('java.net.URL(String)', url);
      }
      if (interesting(url) && shouldEmitLinkEvent(url)) {
        emit(shareUrl(url) ? 'share_link' : 'url', {
          kind: 'url',
          class: 'java.net.URL',
          method: '$init(String)',
          url: cap(url, 4_000),
          share_url: shareUrl(url),
          product_id: shareProductId(url) || productId(url),
          product_signal: PRODUCT_URL_RE.test(url),
        });
      }
      return original.call(this, value);
    };
    emit('hooked', { target: 'java.net.URL(String)' });
  } catch (error) {
    emit('hook_failed', { target: 'java.net.URL(String)', error: cap(error) });
  }
}

function intentToText(intent) {
  if (!intent) return '';
  try {
    const uri = intent.toUri(0);
    if (uri) return asText(uri);
  } catch (_) {}
  try { return asText(intent.toString()); } catch (_) { return ''; }
}

function idForKey(value, key) {
  const raw = asText(value);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const queryMatch = raw.match(new RegExp(`(?:^|[?&\\s])${escapedKey}=(?:%22|["']?)(\\d{10,22})`, 'i'));
  if (queryMatch) return queryMatch[1];
  const jsonMatch = raw.match(new RegExp(`(?:["']|%22)${escapedKey}(?:["']|%22)\\s*(?:[:=]|%3A)\\s*(?:\\[\\s*)?(?:["']|%22)?(\\d{10,22})`, 'i'));
  return jsonMatch ? jsonMatch[1] : '';
}

function parseIntentGoods(value) {
  const raw = asText(value);
  const direct = parseEcGoodsDetail(raw);
  if (direct) return direct;
  const embedded = raw.match(/sslocal:\/\/ec_goods_detail[^\\s;{}"']*/i);
  return embedded ? parseEcGoodsDetail(embedded[0]) : null;
}

function intentPayload(value) {
  const raw = asText(value);
  const goods = parseIntentGoods(raw);
  if (!goods && !interesting(raw)) return null;

  const product_id = goods?.product_id || productId(raw);
  if (goods?.product_id) rememberProductContext(goods.product_id);
  const promotion_id = goods?.promotion_id || idForKey(raw, 'promotion_id');
  const product_signal = Boolean(
    goods?.product_id
    || product_id
    || PRODUCT_URL_RE.test(raw)
    || /ec_goods_detail|product_id|promotion_id/i.test(raw),
  );

  return {
    eventStage: goods ? 'ec_goods_detail' : (shareUrl(raw) ? 'intent' : 'deeplink'),
    kind: goods ? 'ec_goods_detail' : 'intent',
    value: cap(raw, 8_000),
    url: cap(raw, 8_000),
    share_url: shareUrl(raw),
    product_id: shareUrl(raw) ? (shareProductId(raw) || product_id) : product_id,
    promotion_id,
    product_signal,
    ...(goods || {}),
  };
}

function emitIntentValue(className, method, value, extra = {}) {
  const raw = asText(value);
  const payload = intentPayload(value);
  if (raw && interesting(raw)) {
    emitShareHookDebug(`${className}.${method}`, raw, {
      intent_payload_detected: Boolean(payload),
      ...extra,
    });
  }
  if (!payload) return false;
  const { eventStage, ...fields } = payload;
  emit(eventStage, {
    ...fields,
    class: className,
    method,
    ...extra,
  });
  return true;
}

function hookIntent() {
  const Intent = getClass('android.content.Intent');
  if (!Intent) {
    emit('hook_failed', { target: 'android.content.Intent', error: 'class not found' });
    return;
  }

  try {
    const setData = Intent.setData.overload('android.net.Uri');
    setData.implementation = function (uri) {
      const value = uri ? asText(uri.toString()) : '';
      emitIntentValue('android.content.Intent', 'setData', value);
      return setData.call(this, uri);
    };
    emit('hooked', { target: 'android.content.Intent.setData' });
  } catch (error) {
    emit('hook_failed', { target: 'android.content.Intent.setData', error: cap(error) });
  }

  try {
    const getData = Intent.getData.overload();
    getData.implementation = function () {
      const uri = getData.call(this);
      const value = uri ? asText(uri.toString()) : '';
      emitIntentValue('android.content.Intent', 'getData', value);
      return uri;
    };
    emit('hooked', { target: 'android.content.Intent.getData' });
  } catch (error) {
    emit('hook_failed', { target: 'android.content.Intent.getData', error: cap(error) });
  }

  try {
    const putExtra = Intent.putExtra.overload('java.lang.String', 'java.lang.String');
    putExtra.implementation = function (name, value) {
      const key = asText(name);
      const stringValue = asText(value);
      const payload = intentPayload(stringValue);
      if (/^_(real|origin)_deeplink_$|product_id|promotion_id|goods_detail/i.test(key) || payload) {
        if (payload) {
          const { eventStage, ...fields } = payload;
          emit(eventStage, {
            ...fields,
            class: 'android.content.Intent',
            method: 'putExtra',
            extra_name: key,
          });
        } else {
          emit('intent', {
            kind: 'intent',
            class: 'android.content.Intent',
            method: 'putExtra',
            value: cap(stringValue, 4_000),
            extra_name: key,
            share_url: shareUrl(stringValue),
            product_id: shareProductId(stringValue) || productId(stringValue),
            promotion_id: idForKey(stringValue, 'promotion_id'),
            product_signal: /ec_goods_detail|product_id|promotion_id/i.test(stringValue),
          });
        }
      }
      return putExtra.call(this, name, value);
    };
    emit('hooked', { target: 'android.content.Intent.putExtra(String,String)' });
  } catch (error) {
    emit('hook_failed', { target: 'android.content.Intent.putExtra(String,String)', error: cap(error) });
  }

  for (const [className, methodName] of [
    ['android.app.Activity', 'android.app.Activity.startActivity(Intent)'],
    ['android.content.Context', 'android.content.Context.startActivity(Intent)'],
  ]) {
    try {
      const Owner = getClass(className);
      if (!Owner) throw new Error('class not found');
      const startActivity = Owner.startActivity.overload('android.content.Intent');
      startActivity.implementation = function (intent) {
        emitIntentValue(className, 'startActivity', intentToText(intent));
        return startActivity.call(this, intent);
      };
      emit('hooked', { target: methodName });
    } catch (error) {
      emit('hook_failed', { target: methodName, error: cap(error) });
    }
  }
}

function hookRetrofitRequest() {
  try {
    const Builder = getClass('com.bytedance.retrofit2.client.Request$Builder');
    if (!Builder) throw new Error('class not found');
    hookAllOverloads(
      'com.bytedance.retrofit2.client.Request$Builder',
      'url',
      'com.bytedance.retrofit2.client.Request$Builder.url',
      (args) => {
        const url = args.map(asText).find((value) => /^https?:\/\//i.test(value)) || args.map(asText).join(' | ');
        if (!isProductRequestUrl(url)) return;
        markProductDetailRequest(url);
        if (!isCollectorRequestUrl(url)) return;
        emitDebug('runtime_debug_request_url', {
          class: 'com.bytedance.retrofit2.client.Request$Builder',
          method: 'url',
          url: cap(url, 4_000),
          current_product_request,
        });
        lastProductUrl = url;
        emit('detail_request', {
          kind: 'request',
          transport: 'retrofit',
          class: 'com.bytedance.retrofit2.client.Request$Builder',
          method: 'url',
          url: cap(url, 4_000),
          product_id: productId(url),
          product_signal: Boolean(productId(url)),
        });
      },
    );
    const build = Builder.build.overload();
    build.implementation = function () {
      const request = build.call(this);
      try { emitRequest(request, 'retrofit'); } catch (error) {
        emit('hook_error', { target: 'Retrofit Request.Builder.build', error: cap(error) });
      }
      return request;
    };
    emit('hooked', { target: 'com.bytedance.retrofit2.client.Request$Builder.build' });
  } catch (error) {
    emit('hook_failed', { target: 'com.bytedance.retrofit2.client.Request$Builder.build', error: cap(error) });
  }
}

function hookOkHttpRequest() {
  try {
    const Builder = getClass('okhttp3.Request$Builder');
    if (!Builder) throw new Error('class not found');
    const build = Builder.build.overload();
    build.implementation = function () {
      const request = build.call(this);
      try { emitRequest(request, 'okhttp'); } catch (error) {
        emit('hook_error', { target: 'OkHttp Request.Builder.build', error: cap(error) });
      }
      return request;
    };
    emit('hooked', { target: 'okhttp3.Request$Builder.build' });
  } catch (error) {
    emit('hook_failed', { target: 'okhttp3.Request$Builder.build', error: cap(error) });
  }
}

function hookResponseBody() {
  hookAllOverloads(
    'com.bytedance.retrofit2.client.Response',
    'getUrl',
    'com.bytedance.retrofit2.client.Response.getUrl',
    (_, result) => {
      const url = asText(result);
      markProductDetailRequest(url);
      if (!isProductRequestUrl(url) || !isCollectorRequestUrl(url)) return;
      emitDebug('runtime_debug_response_url', {
        class: 'com.bytedance.retrofit2.client.Response',
        method: 'getUrl',
        url: cap(url, 4_000),
      });
      lastProductUrl = url;
      emit('response_url', {
        kind: 'response',
        class: 'com.bytedance.retrofit2.client.Response',
        method: 'getUrl',
        url: cap(url, 4_000),
      });
    },
  );

  hookAllOverloads(
    'com.bytedance.retrofit2.client.Response',
    'getBody',
    'com.bytedance.retrofit2.client.Response.getBody',
    function (_, result) {
      const responseUrlValue = responseUrl(this);
      lastResponseBodyUrl = responseUrlValue || lastProductUrl;
      const relevantUrl = responseUrlValue || lastProductUrl;
      if (!DEBUG_MODE
        && !SEARCH_RESPONSE_URL_RE.test(relevantUrl)
        && !isProductDetailStreamUrl(relevantUrl)) return;
      hookConcreteResponseBodyClass(javaObjectClassName(result));
      let rawBytes = bodyBytes(result);
      let bodyReadMethod = byteLength(rawBytes) > 0 ? 'getBytes' : '';
      if (byteLength(rawBytes) === 0 && shouldReadResponseBodyStream(responseUrlValue || lastProductUrl, result)) {
        rawBytes = bodyInputStreamBytes(result);
        bodyReadMethod = byteLength(rawBytes) > 0 ? 'in' : 'in_failed';
      }
      emitResponseBodyDebug(
        'com.bytedance.retrofit2.client.Response',
        'getBody',
        rawBytes,
        responseUrlValue || lastProductUrl,
        result,
        { body_read_method: bodyReadMethod },
      );
      const body = responseBodyText(rawBytes);
      const detailUrl = currentProductDetailResponseUrl(responseUrlValue);
      if (!body) return;
      if (detailUrl) {
        emitProductDetailStreamResponse(body, detailUrl, 'com.bytedance.retrofit2.client.Response', 'getBody');
      } else {
        emitProductResponse(body, responseUrlValue || lastProductUrl, 'com.bytedance.retrofit2.client.Response', 'getBody');
      }
    },
  );

  for (const methodName of ['getBytes', 'getOriginBody']) {
    hookAllOverloads(
      'com.bytedance.retrofit2.mime.TypedByteArray',
      methodName,
      `com.bytedance.retrofit2.mime.TypedByteArray.${methodName}`,
      (_, result) => {
        if (!DEBUG_MODE
          && !SEARCH_RESPONSE_URL_RE.test(lastProductUrl)
          && !currentProductDetailResponseUrl()) return;
        emitResponseBodyDebug(
          'com.bytedance.retrofit2.mime.TypedByteArray',
          methodName,
          result,
          lastProductUrl,
        );
        const body = responseBodyText(result);
        if (!body) return;
        const detailUrl = currentProductDetailResponseUrl();
        if (detailUrl) {
          emitProductDetailStreamResponse(body, detailUrl, 'com.bytedance.retrofit2.mime.TypedByteArray', methodName);
        } else {
          emitProductResponse(body, lastProductUrl, 'com.bytedance.retrofit2.mime.TypedByteArray', methodName);
        }
      },
    );
  }

  hookAllOverloads(
    'okhttp3.ResponseBody',
    'string',
    'okhttp3.ResponseBody.string',
    (_, result) => {
      if (!DEBUG_MODE
        && !SEARCH_RESPONSE_URL_RE.test(lastProductUrl)
        && !currentProductDetailResponseUrl()) return;
      const body = asText(result);
      emitDebug('runtime_debug_response_body', {
        class: 'okhttp3.ResponseBody',
        method: 'string',
        length: body.length,
        preview: cap(body, 200),
      });
      if (!body) return;
      const detailUrl = currentProductDetailResponseUrl();
      if (detailUrl) {
        emitProductDetailStreamResponse(body, detailUrl, 'okhttp3.ResponseBody', 'string');
      } else {
        emitProductResponse(body, lastProductUrl, 'okhttp3.ResponseBody', 'string');
      }
    },
  );

  hookAllOverloads(
    'okhttp3.ResponseBody',
    'bytes',
    'okhttp3.ResponseBody.bytes',
    (_, result) => {
      if (!DEBUG_MODE
        && !SEARCH_RESPONSE_URL_RE.test(lastResponseBodyUrl || lastProductUrl)
        && !currentProductDetailResponseUrl()) return;
      handleResponseBodyValue(result, lastResponseBodyUrl || lastProductUrl, 'okhttp3.ResponseBody', 'bytes');
    },
  );
}

function hookGson() {
  try {
    const Gson = getClass('com.google.gson.Gson');
    if (!Gson) throw new Error('class not found');
    const install = (overload, methodName) => {
      overload.implementation = function () {
        const className = targetClassName(arguments[1]);
        if (!DEBUG_MODE && !isHomePageDto(className)) {
          return overload.call(this, ...arguments);
        }

        const json = asText(arguments[0]);
        const result = overload.call(this, ...arguments);
        const jsonLength = json.length;
        const jsonPreview = cap(json, GSON_DEBUG_PREVIEW_LENGTH);
        const pathScan = DEBUG_MODE
          ? scanGsonJsonPaths(json)
          : { hits: [], truncated: false };
        const pathHits = pathScan.hits;
        const debugFields = {
          class: 'com.google.gson.Gson',
          method: methodName,
          class_name: className,
          length: jsonLength,
          value: jsonPreview,
          json_length: jsonLength,
          json_preview: jsonPreview,
          field_hits: pathHits.map((hit) => hit.key),
          field_path_hits: pathHits,
          field_path_hits_truncated: pathScan.truncated,
        };
        emitDebug('runtime_debug_gson_from_json', debugFields);
        if (pathHits.length > 0) {
          emitDebug('gson_field_path_hit', {
            class: 'com.google.gson.Gson',
            method: methodName,
            class_name: className,
            length: jsonLength,
            value: JSON.stringify(pathHits),
            json_length: jsonLength,
            hits: pathHits,
            hit_count: pathHits.length,
            hits_truncated: pathScan.truncated,
          });
        }

        let homePageProductCount = 0;
        try {
          homePageProductCount = emitHomePageProducts(json, className, methodName);
        } catch (error) {
          emit('hook_error', {
            target: 'com.google.gson.Gson.fromJson HomePageDTO',
            error: cap(error),
          });
        }

        if (!homePageProductCount) {
          try {
            emitProductResponse(json, lastProductUrl, 'com.google.gson.Gson', methodName);
          } catch (_) {}
        }
        return result;
      };
    };
    install(Gson.fromJson.overload('java.lang.String', 'java.lang.Class'), 'fromJson(String,Class)');
    try { install(Gson.fromJson.overload('java.lang.String', 'java.lang.reflect.Type'), 'fromJson(String,Type)'); } catch (_) {}
    emit('hooked', { target: 'com.google.gson.Gson.fromJson' });
  } catch (error) {
    emit('hook_failed', { target: 'com.google.gson.Gson.fromJson', error: cap(error) });
  }
}

function hookTypeAdapter() {
  if (!DEBUG_MODE) return;
  hookAllOverloads(
    'com.google.gson.TypeAdapter',
    'fromJson',
    'com.google.gson.TypeAdapter.fromJson',
    function () {
      emitDebug('runtime_debug_type_adapter_from_json', {
        class: 'com.google.gson.TypeAdapter',
        method: 'fromJson',
        class_name: targetClassName(this),
      });
    },
  );
}

function hookShareLinkManager() {
  try {
    const Manager = getClass('com.ss.android.ugc.aweme.share.link.ShareLinkManager');
    if (!Manager || !Manager.LIZLLL) throw new Error('class or method not found');
    for (const overload of Manager.LIZLLL.overloads) {
      overload.implementation = function () {
        const values = [];
        for (const argument of arguments) {
          try { values.push(asText(argument)); } catch (_) {}
        }
        const value = values.join(' | ');
        if (interesting(value) || shareUrl(value)) {
          emitShareHookDebug(
            'com.ss.android.ugc.aweme.share.link.ShareLinkManager.LIZLLL',
            value,
          );
          emit('share_link', {
            kind: 'share_link',
            class: 'com.ss.android.ugc.aweme.share.link.ShareLinkManager',
            method: 'LIZLLL',
            value: cap(value),
            share_url: shareUrl(value),
            product_id: shareProductId(value),
          });
        }
        return overload.apply(this, arguments);
      };
    }
    emit('hooked', { target: 'ShareLinkManager.LIZLLL' });
  } catch (error) {
    emit('hook_failed', { target: 'ShareLinkManager.LIZLLL', error: cap(error) });
  }
}

function install() {
  if (!Java.available) {
    setTimeout(install, 400);
    return;
  }
  Java.perform(() => {
    emit('ready', { mode: 'android-only', process: Process.id, arch: Process.arch });
    hookClipboard();
    hookUriAndUrl();
    hookIntent();
    hookLynxCardBridge();
    hookRetrofitRequest();
    hookOkHttpRequest();
    hookResponseBody();
    hookGson();
    hookTypeAdapter();
    hookShareLinkManager();
  });
}

emit('agent_loaded', { mode: 'android-only' });
setTimeout(install, 400);
