/**
 * Shop crawler — enters a shop from a product link, scrolls ALL products,
 * extracts share links + product data. Uses instant search-reset on rate limit.
 *
 * Key difference from search crawler:
 *   - No keyword search — enters shop directly, all products are Golden Goose
 *   - Product cards in shop listing show full title/price/sales
 *   - Faster because no filtering/scoping needed
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { _android as android } from 'playwright';
import {
  dumpUi,
  getScreenSize,
  PACKAGE_NAME,
  AccessDeniedError,
  findAccessDenied,
  bringDouyinMallToFront,
} from './android.mjs';
import { nodeValue, centerOf, findByValue, findByResource } from './ui.mjs';
import { readCurrentDouyinShareUrl, waitForDouyinShareUrl } from './clipboard.mjs';
import { createSharePageEnricher, extractShopName } from './enrich.mjs';
import { loadCheckpoint, writeArtifacts } from './output.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shop navigation
// ---------------------------------------------------------------------------

async function openProductInApp(device, productId) {
  await device.shell(`am start -a android.intent.action.VIEW -d "sslocal://ec_goods_detail?product_id=${productId}&enter_from=copy"`);
  await sleep(4000);
}

async function enterShop(device, screen) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { nodes } = await dumpUi(device);

    // Look for shop name on product page
    const shopNode = nodes.find((n) => {
      const v = nodeValue(n);
      return n.bounds && /(?:官方旗舰店|旗舰店|专卖店|专营店)$/.test(v)
        && n.bounds.width < 700 && n.bounds.y > 180;
    });
    if (shopNode) {
      const name = nodeValue(shopNode);
      console.log(`[shop] Entering: ${name}`);
      await device.shell(`input tap ${Math.round(shopNode.bounds.x + shopNode.bounds.width / 2)} ${Math.round(shopNode.bounds.y + shopNode.bounds.height / 2)}`);
      await sleep(3000);
      return name;
    }

    // Try bottom "店铺" tab
    const shopTab = nodes.find((n) => nodeValue(n) === '店铺' && n.bounds && n.bounds.y > 1300);
    if (shopTab) {
      await device.shell(`input tap ${Math.round(shopTab.bounds.x + shopTab.bounds.width / 2)} ${Math.round(shopTab.bounds.y + shopTab.bounds.height / 2)}`);
      await sleep(3000);
      continue;
    }

    await sleep(800);
  }
  throw new Error('Could not enter shop');
}

async function ensureGoodsTab(device) {
  const { nodes } = await dumpUi(device);
  const goodsTab = nodes.find((n) => nodeValue(n) === '商品' && n.bounds && n.bounds.y < 550);
  if (goodsTab) {
    await device.shell(`input tap ${Math.round(goodsTab.bounds.x + goodsTab.bounds.width / 2)} ${Math.round(goodsTab.bounds.y + goodsTab.bounds.height / 2)}`);
    await sleep(1200);
  }
}

// ---------------------------------------------------------------------------
// Product card extraction
// ---------------------------------------------------------------------------

function extractCards(nodes) {
  const cards = [];
  const titleNodes = nodes.filter((n) => {
    if (!n.bounds) return false;
    const v = nodeValue(n);
    return v.length >= 10 && v.length <= 200
      && n.bounds.x >= 200 && n.bounds.width >= 300
      && n.bounds.height <= 100 && n.bounds.y > 500;
  });

  for (const tn of titleNodes) {
    const title = nodeValue(tn);
    if (/^(GOLDEN|GOOSE|\d+万|现价|已售|退货|顺丰|抖音|关注|粉丝|该商家)/.test(title)) continue;

    // Find nearby price and sales
    const nearby = nodes.filter((n) => {
      if (!n.bounds) return false;
      return n.bounds.y >= tn.bounds.y && n.bounds.y <= tn.bounds.y + 250
        && n.bounds.x >= tn.bounds.x - 50;
    });

    const priceNode = nearby.find((n) => /现价|¥|￥/.test(nodeValue(n)));
    let price = '';
    if (priceNode) {
      const m = nodeValue(priceNode).match(/([\d.]+)/);
      if (m) price = String(Number(m[1]));
    }

    const salesNode = nearby.find((n) => /已售/.test(nodeValue(n)));
    let sales = '';
    if (salesNode) {
      const m = nodeValue(salesNode).match(/已售(\S+)/);
      if (m) sales = `${m[1]}件`;
    }

    cards.push({ title, price, sales, tapPoint: centerOf(tn) });
  }

  // Deduplicate
  const seen = new Set();
  return cards.filter((c) => { if (seen.has(c.title)) return false; seen.add(c.title); return true; });
}

// ---------------------------------------------------------------------------
// Share link + enrichment
// ---------------------------------------------------------------------------

async function getShareLink(device, screen, card) {
  const tapPt = card.tapPoint;
  await device.shell(`input tap ${Math.round(tapPt.x)} ${Math.round(tapPt.y)}`);
  await sleep(2500);

  // Check access denied
  const { nodes } = await dumpUi(device);
  if (findAccessDenied(nodes)) throw new AccessDeniedError();

  // Tap share
  await device.shell(`input tap ${Math.round(screen.width * 0.895)} ${Math.round(screen.height * 0.052)}`);
  await sleep(1200);

  const previousUrl = await readCurrentDouyinShareUrl();
  const copyLink = nodes.find((n) => /复制链接/.test(nodeValue(n)));
  if (!copyLink) throw new Error('Share panel: no 复制链接');

  await device.shell(`input tap ${Math.round(copyLink.bounds.x + copyLink.bounds.width / 2)} ${Math.round(copyLink.bounds.y + copyLink.bounds.height / 2)}`);
  return waitForDouyinShareUrl({ previousUrl });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function crawlShop(config) {
  const { productLink, serial = '127.0.0.1:16384', outputPath, checkpointPath, summaryPath, fresh, maxScrolls = 50 } = config;

  const startedAt = new Date().toISOString();
  const products = fresh ? [] : await loadCheckpoint(checkpointPath);
  const errors = [];
  const seenTitles = new Set(products.map((p) => p.商品品名));
  const seenLinks = new Set(products.map((p) => p['分享的链接']).filter(Boolean));

  const androidDevices = await android.devices({ host: '127.0.0.1', port: 5037 });
  const device = androidDevices.find((c) => c.serial() === serial);
  if (!device) throw new Error(`Device ${serial} not found`);

  let enricher;
  try {
    const screen = await getScreenSize(device);

    // Resolve product_id from link
    const productId = await (async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ channel: 'msedge', headless: true });
      try {
        const page = await (await browser.newContext({ viewport: { width: 430, height: 932 } })).newPage();
        await page.goto(productLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.locator('body').waitFor({ state: 'visible', timeout: 10_000 });
        const url = new URL(page.url());
        return url.searchParams.get('id') || url.searchParams.get('product_id');
      } finally { await browser.close().catch(() => {}); }
    })();
    if (!productId) throw new Error('Could not extract product_id from link');

    // Step 1: Open product → enter shop
    console.log('[shop] Opening product...');
    await bringDouyinMallToFront(device, screen);
    await openProductInApp(device, productId);

    console.log('[shop] Entering shop...');
    const shopName = await enterShop(device, screen);
    await ensureGoodsTab(device);

    // Step 2: Scroll and collect all cards
    console.log('[shop] Scanning products...');
    const allCards = [];
    const seenCardTitles = new Set();

    for (let scrollIdx = 0; scrollIdx < maxScrolls; scrollIdx++) {
      const { nodes } = await dumpUi(device);
      const cards = extractCards(nodes);
      let newCards = 0;
      for (const card of cards) {
        if (!seenCardTitles.has(card.title)) {
          seenCardTitles.add(card.title);
          allCards.push(card);
          newCards++;
        }
      }
      console.log(`[shop] Scroll ${scrollIdx + 1}: ${newCards} new (total: ${allCards.length})`);

      if (newCards === 0 && scrollIdx >= 3) {
        console.log('[shop] No new products, done scanning.');
        break;
      }

      // Scroll
      await device.shell(`input swipe ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.82)} ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.28)} 400`);
      await sleep(1200);
    }

    console.log(`[shop] Total cards: ${allCards.length}`);

    // Step 3: Process each card — get share link + enrich
    enricher = await createSharePageEnricher({ headless: true, stealth: true });
    const newCards = allCards.filter((c) => !seenTitles.has(c.title));
    console.log(`[shop] Processing ${newCards.length} new products...`);

    let accessDeniedCount = 0;

    for (let i = 0; i < newCards.length; i++) {
      const card = newCards[i];
      try {
        console.log(`[${i + 1}/${newCards.length}] ${card.title.slice(0, 50)}...`);

        const share = await getShareLink(device, screen, card);

        // Enrich via browser to get exact price/sales (more accurate than shop listing)
        const product = await enricher.enrich(share.url);
        if (!product.商品品名) {
          // Fallback: use shop listing data
          product.商品品名 = card.title;
          product.店铺名 = shopName;
          product.价格 = card.price || product.价格;
          product.销量 = card.sales || product.销量;
        }

        products.push(product);
        seenTitles.add(card.title);
        console.log(`  → ¥${product.价格} | ${product.销量}`);

        // Save checkpoint
        await writeArtifacts({
          products, outputPath, checkpointPath, summaryPath,
          summary: { query: 'shop-crawl', requested: newCards.length, collected: products.length,
            completed: false, startedAt, updatedAt: new Date().toISOString(), errors },
        });

        // Back to shop
        await device.shell('input keyevent 4');
        await sleep(1500);

        // Re-find the card position (shop might have scrolled)
        await ensureGoodsTab(device);

      } catch (error) {
        if (error instanceof AccessDeniedError) {
          accessDeniedCount++;
          console.warn(`[access-denied #${accessDeniedCount}] Instant reset: re-entering shop...`);
          errors.push({ title: card.title, type: 'access_denied', message: error.message, at: new Date().toISOString() });

          // Instant reset: exit and re-enter shop
          for (let b = 0; b < 5; b++) { await device.shell('input keyevent 4'); await sleep(400); }
          await bringDouyinMallToFront(device, screen);
          await openProductInApp(device, productId);
          await enterShop(device, screen);
          await ensureGoodsTab(device);
          // Continue to next product
        } else {
          errors.push({ title: card.title, message: error.message, at: new Date().toISOString() });
          console.warn(`  ✗ ${error.message}`);
          // Try to return
          await device.shell('input keyevent 4').catch(() => {});
          await sleep(1000);
        }
      }
    }

    const completed = true;
    await writeArtifacts({
      products, outputPath, checkpointPath, summaryPath,
      summary: { query: 'shop-crawl', requested: newCards.length, collected: products.length,
        completed, startedAt, updatedAt: new Date().toISOString(), errors },
    });

    return { products, errors, completed };
  } finally {
    await enricher?.close().catch(() => {});
    await Promise.allSettled(androidDevices.map((c) => c.close()));
  }
}
