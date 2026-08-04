const PRODUCT_SALES_MATERIAL_IDS = new Set(['541', '546']);

const MATERIAL_ENTRY_RE = /(?:素材|绱犳潗)\s*id\s*[:：]\s*(\d+)\s*[,，]\s*(?:素材内容|绱犧潗鍐呭)\s*[:：]\s*([^;\]，,]*)/giu;
const REGION_RE = /(?:区域名称|鍖哄煙鍚嶇О)\s*[:：]\s*([^,，;\]]+)/iu;

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

export function normalizeText(value) {
  return text(value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim();
}

function materialText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(materialText).filter(Boolean).join(';');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return text(value);
}

function regionForSegment(segment) {
  const match = segment.match(REGION_RE);
  return normalizeText(match?.[1] || '').toLowerCase();
}

/**
 * Parse MaterialContentInfo without treating a material ID as a semantic
 * field mapping. The ID is retained as provenance; the text and region decide
 * whether a value is product-level or shop-level.
 */
export function parseMaterialContentInfo(value) {
  const source = materialText(value);
  if (!source) return [];

  const entries = [];
  const segments = source.split(/(?=(?:区域名称|鍖哄煙鍚嶇О)\s*[:：])/u);
  for (const segment of segments) {
    const region = regionForSegment(segment);
    MATERIAL_ENTRY_RE.lastIndex = 0;
    for (const match of segment.matchAll(MATERIAL_ENTRY_RE)) {
      entries.push({
        material_id: match[1],
        content: normalizeText(match[2]),
        region,
      });
    }
  }

  // Some fixtures do not carry a region prefix. Parse them once as a
  // fallback, while keeping the region empty rather than inventing one.
  if (!entries.length) {
    MATERIAL_ENTRY_RE.lastIndex = 0;
    for (const match of source.matchAll(MATERIAL_ENTRY_RE)) {
      entries.push({
        material_id: match[1],
        content: normalizeText(match[2]),
        region: '',
      });
    }
  }
  return entries;
}

function salesMatch(value) {
  const candidate = normalizeText(value);
  if (!candidate) return null;

  const patterns = [
    /(?:已售|已销售)\s*[0-9]+(?:\.[0-9]+)?(?:万|千|亿|[kKmMwW])?\+?\s*(?:件|个)?/u,
    /[0-9]+(?:\.[0-9]+)?(?:万|千|亿|[kKmMwW])?\+?\s*人付款/u,
    /月售\s*[0-9]+(?:\.[0-9]+)?(?:万|千|亿|[kKmMwW])?\+?\s*(?:件|个)?/u,
  ];
  for (const pattern of patterns) {
    const match = candidate.match(pattern);
    if (match) return match[0].trim();
  }
  return null;
}

function isSalesRegion(region) {
  return /(?:sales|sale|sold|销量|销量|已售|付款|购买)/iu.test(region);
}

function isShopSales(value) {
  return /全店\s*已售/iu.test(normalizeText(value));
}

/**
 * Return product-level sales and retain shop-level candidates separately.
 * Shop-level values never become the product `sales` field.
 */
export function extractSalesFromMaterial(value) {
  const entries = parseMaterialContentInfo(value);
  const productCandidates = [];
  const shopCandidates = [];

  for (const entry of entries) {
    const matched = salesMatch(entry.content);
    if (!matched) continue;

    const shopLevel = isShopSales(entry.content);
    const productLevel = !shopLevel && (
      isSalesRegion(entry.region)
      || PRODUCT_SALES_MATERIAL_IDS.has(entry.material_id)
      || /(?:已售|已销售|月售|人付款)/iu.test(entry.content)
    );
    const candidate = {
      value: matched,
      raw_text: entry.content,
      material_id: entry.material_id,
      region: entry.region,
      scope: shopLevel ? 'shop' : (productLevel ? 'product' : 'unknown'),
    };

    if (shopLevel) shopCandidates.push(candidate);
    else if (productLevel) productCandidates.push(candidate);
  }

  return {
    product: productCandidates[0] || null,
    shop: shopCandidates[0] || null,
    candidates: [...productCandidates, ...shopCandidates],
  };
}

function scalar(value) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  return normalizeText(value);
}

function firstScalar(object, keys) {
  for (const key of keys) {
    const value = scalar(object?.[key]);
    if (value) return value;
  }
  return '';
}

function priceText(value) {
  const candidate = scalar(value);
  if (!candidate) return '';
  const numeric = Number(candidate);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return numeric > 10000 ? (numeric / 100).toFixed(2) : String(numeric);
}

export function extractProductFields(card = {}) {
  const materialInfo = card.MaterialContentInfo ?? card.material_content_info ?? '';
  const materials = parseMaterialContentInfo(materialInfo);
  const shopMaterial = materials.find((entry) => entry.material_id === '601' && entry.content);
  const materialSales = extractSalesFromMaterial(materialInfo);

  const shop = card.shop_info || card.shopInfo || card.shop || {};
  const productId = firstScalar(card, ['ProductID', 'product_id', 'productId', 'promotion_id']);
  const promotionId = firstScalar(card, ['promotion_id', 'promotionId']);
  const title = firstScalar(card, ['Title', 'title', 'product_name', 'goods_name', 'real_title']);
  const shopName = shopMaterial?.content
    || firstScalar(card, ['shop_name', 'shopName', 'store_name', 'seller_name', 'merchant_name'])
    || firstScalar(shop, ['name', 'shop_name', 'shopName', 'store_name', 'seller_name']);
  const price = priceText(firstScalar(card, ['Price', 'price', 'show_price', 'min_price']));
  const directSales = firstScalar(card, [
    'sales',
    'sold_num',
    'sales_volume',
    'sales_text',
    'sales_num',
    'price_sales_num',
    'price_sales_desc',
  ]);
  const productSales = materialSales.product?.value || directSales;

  return {
    product_id: productId,
    promotion_id: promotionId,
    product_name: title,
    title,
    shop_name: shopName,
    price,
    sales: productSales,
    sales_metadata: {
      product: materialSales.product,
      shop: materialSales.shop,
      candidates: materialSales.candidates,
    },
  };
}

export function isCompleteProduct(row = {}) {
  return [
    row.product_id,
    row.product_name,
    row.shop_name,
    row.price,
    row.sales,
    row.share_url,
  ].every((value) => normalizeText(value) && normalizeText(value) !== '0');
}

export function missingProductFields(rows = []) {
  const fields = ['product_name', 'shop_name', 'price', 'sales', 'share_url'];
  return Object.fromEntries(fields.map((field) => [
    `missing_${field}`,
    rows.filter((row) => !normalizeText(row?.[field])).length,
  ]));
}
