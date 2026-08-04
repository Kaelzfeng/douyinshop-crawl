/**
 * Path B: enter shops from existing product seeds (main CSV), crawl in-shop products.
 * Does NOT use search → 店铺 tab.
 *
 * For each unique shop:
 *   open seed product by product_id (or resolve v.douyin.com)
 *   → enter shop → 商品 tab → scroll → filter keyword → share → enrich (+ H5)
 */
import fs from 'node:fs';
import path from 'node:path';
import { crawlShop } from './shop-crawler.mjs';
import { productIdentityKey, loadCheckpoint, writeArtifacts, OUTPUT_FIELDS } from './output.mjs';

function parseCsvLine(line) {
  const p = [];
  let c = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      p.push(c);
      c = '';
    } else c += ch;
  }
  p.push(c);
  return p;
}

function loadShopSeeds(csvPath) {
  const t = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = t.trim().split(/\r?\n/).slice(1);
  const shops = new Map();

  for (const line of lines) {
    if (!line.trim()) continue;
    const r = parseCsvLine(line);
    const kw = (r[0] || '').trim();
    const id = (r[1] || '').trim();
    const title = (r[2] || '').trim();
    const shop = (r[3] || '').trim();
    const link = (r[6] || '').trim();
    if (!shop || shop === '待确认-店铺') continue;
    if (!id && !/^https?:\/\//.test(link)) continue;

    if (!shops.has(shop)) {
      shops.set(shop, {
        shop,
        count: 0,
        xzCount: 0,
        seed: null,
        xzSeed: null,
      });
    }
    const s = shops.get(shop);
    s.count += 1;
    const seed = {
      productId: id,
      link: link || (id ? `https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=${id}` : ''),
      title,
      kw,
    };
    if (!s.seed) s.seed = seed;
    if (kw === '小脏鞋' || kw.includes('\u5c0f\u810f')) {
      s.xzCount += 1;
      if (!s.xzSeed) s.xzSeed = seed;
    }
  }

  return [...shops.values()]
    .map((s) => ({
      shop: s.shop,
      count: s.count,
      xzCount: s.xzCount,
      seed: s.xzSeed || s.seed,
    }))
    .filter((s) => s.seed)
    .sort((a, b) => b.xzCount - a.xzCount || b.count - a.count);
}

/**
 * @param {object} config
 * @param {string} [config.seedsCsv]
 * @param {string} [config.keyword] filter inside shop (default 小脏鞋)
 * @param {number} [config.maxShops]
 * @param {boolean} [config.onlyXiaozangShops] only shops that already have 小脏鞋 products
 */
export async function crawlShopsFromSeeds(config) {
  const seedsCsv = config.seedsCsv || 'output/all-products-final.csv';
  const keyword = config.keyword || '\u5c0f\u810f\u978b';
  const maxShops = config.maxShops || 30;
  const onlyXz = config.onlyXiaozangShops !== false;

  let shops = loadShopSeeds(seedsCsv);
  if (onlyXz) shops = shops.filter((s) => s.xzCount > 0);
  shops = shops.slice(0, maxShops);

  console.log(`[shop-seeds] shops=${shops.length} keyword=${keyword} seedsCsv=${seedsCsv}`);
  for (const s of shops.slice(0, 12)) {
    console.log(`  - ${s.shop} (xz=${s.xzCount}, n=${s.count}) seed=${s.seed.productId}`);
  }

  const outputPath = config.outputPath || 'output/shop-from-seeds-xiaozangxie.csv';
  const checkpointPath = config.checkpointPath || 'data/shop-from-seeds-checkpoint.json';
  const summaryPath = config.summaryPath || 'output/shop-from-seeds-summary.json';

  // Shared checkpoint across shops
  let allProducts = config.fresh ? [] : await loadCheckpoint(checkpointPath);
  const seenKeys = new Set(allProducts.map(productIdentityKey));
  const errors = [];
  const startedAt = new Date().toISOString();
  let shopsDone = 0;

  for (let i = 0; i < shops.length; i++) {
    const s = shops[i];
    const seedLink =
      s.seed.link ||
      `https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=${s.seed.productId}`;
    console.log(`\n[shop-seeds] === ${i + 1}/${shops.length} ${s.shop} ===`);
    console.log(`[shop-seeds] seed link=${seedLink.slice(0, 80)}`);

    try {
      // Per-shop temp paths then merge (crawlShop overwrites single output)
      const result = await crawlShop({
        productLink: seedLink,
        productId: s.seed.productId || '',
        // Prefer shop name for search (shows shop-card 进店); title as fallback
        productTitle: s.shop || s.seed.title || '',
        serial: config.serial || 'emulator-5554',
        keyword,
        // Always start empty for this call; we merge ourselves
        outputPath: `tmp/shop-seed-partial.csv`,
        checkpointPath: `tmp/shop-seed-partial-checkpoint.json`,
        summaryPath: `tmp/shop-seed-partial-summary.json`,
        fresh: true,
        maxScrolls: config.shopMaxScrolls || config.maxScrolls || 40,
      });

      let added = 0;
      for (const p of result.products || []) {
        p['搜索关键词'] = p['搜索关键词'] || keyword;
        p['店铺名'] = p['店铺名'] || s.shop;
        const key = productIdentityKey(p);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        allProducts.push(p);
        added += 1;
      }
      shopsDone += 1;
      errors.push(...(result.errors || []));
      console.log(`[shop-seeds] +${added} products (total ${allProducts.length}) from ${s.shop}`);

      await writeArtifacts({
        products: allProducts,
        outputPath,
        checkpointPath,
        summaryPath,
        summary: {
          mode: 'shop-from-seeds',
          keyword,
          shopsTotal: shops.length,
          shopsDone,
          collected: allProducts.length,
          completed: false,
          startedAt,
          updatedAt: new Date().toISOString(),
          errors: errors.slice(-50),
        },
      });
    } catch (e) {
      console.warn(`[shop-seeds] FAIL ${s.shop}: ${String(e.message || e).slice(0, 120)}`);
      errors.push({ shop: s.shop, message: String(e.message || e), at: new Date().toISOString() });
      await writeArtifacts({
        products: allProducts,
        outputPath,
        checkpointPath,
        summaryPath,
        summary: {
          mode: 'shop-from-seeds',
          keyword,
          shopsTotal: shops.length,
          shopsDone,
          collected: allProducts.length,
          completed: false,
          startedAt,
          updatedAt: new Date().toISOString(),
          errors: errors.slice(-50),
        },
      });
    }
  }

  await writeArtifacts({
    products: allProducts,
    outputPath,
    checkpointPath,
    summaryPath,
    summary: {
      mode: 'shop-from-seeds',
      keyword,
      shopsTotal: shops.length,
      shopsDone,
      collected: allProducts.length,
      completed: true,
      startedAt,
      updatedAt: new Date().toISOString(),
      errors,
    },
  });

  console.log(`[shop-seeds] DONE shops=${shopsDone}/${shops.length} products=${allProducts.length}`);
  return { products: allProducts, errors, completed: true, shopsDone, shopsTotal: shops.length };
}
