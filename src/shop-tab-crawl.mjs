/**
 * Shop Tab Crawler — after search, taps "店铺" tab, enters each shop,
 * scrolls all products, filters by keyword (default use case: 小脏鞋).
 */
import { dumpUi, getScreenSize, bringDouyinMallToFront, searchGoldenGoose, copyCurrentProductShareLink } from './android.mjs';
import { nodeValue, centerOf } from './ui.mjs';
import { readCurrentDouyinShareUrl, waitForDouyinShareUrl } from './clipboard.mjs';
import { createSharePageEnricher } from './enrich.mjs';
import { createShareRateLimiter } from './rate-limit.mjs';
import { enrichOneProductId } from './h5-enrich.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OUTPUT_FIELDS = ['搜索关键词', '商品id', '商品品名', '店铺名', '价格', '销量', '分享的链接'];

function titleMatchesKeyword(title, keyword) {
  const t = String(title || '').toLowerCase();
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return true;
  if (t.includes(kw)) return true;
  // ggdb ≈ golden goose / 脏脏鞋 brand line
  if (kw === 'ggdb' && (t.includes('goldengoose') || t.includes('golden goose') || t.includes('ggdb') || t.includes('脏脏鞋'))) {
    return true;
  }
  if ((kw === 'golden goose' || kw === 'goldengoose') && (t.includes('ggdb') || t.includes('goldengoose'))) return true;
  // 小脏鞋 + generic 脏脏鞋 (exclude pure GGDB brand titles for this keyword)
  if (kw === '小脏鞋' || kw === '\u5c0f\u810f\u978b') {
    if (t.includes('小脏鞋') || t.includes('\u5c0f\u810f\u978b')) return true;
    if (t.includes('脏脏鞋') && !/golden\s*goose|goldengoose|\bggdb\b/i.test(t)) return true;
    return false;
  }
  return false;
}

function isShopName(value) {
  const v = String(value || '').trim();
  if (!v || v.length < 2 || v.length > 40) return false;
  if (/^(综合|销量|价格|筛选|店铺|商品|直播|视频|用户|全部|进店|关注|已售|券后)/.test(v)) return false;
  return /(?:官方旗舰店|旗舰店|专卖店|专营店|企业店|工厂店|概念店|集合店)$/.test(v)
    || /店$/.test(v);
}

async function ensureSearchSubmitted(device, screen) {
  // If still on suggestion list (no 综合/店铺 tabs), tap orange 搜索
  const { nodes } = await dumpUi(device);
  const values = nodes.map((n) => nodeValue(n));
  const onResults = values.includes('综合') || values.includes('店铺') || values.includes('销量');
  if (onResults) return true;

  const searchBtn = nodes.find((n) => nodeValue(n) === '搜索' && n.bounds && n.bounds.y < 160);
  if (searchBtn) {
    await device.shell(
      `input tap ${Math.round(searchBtn.bounds.x + searchBtn.bounds.width / 2)} ${Math.round(searchBtn.bounds.y + searchBtn.bounds.height / 2)}`,
    );
  } else {
    // 900x1600 orange 搜索 button
    await device.shell(`input tap ${Math.round(screen.width * 0.92)} ${Math.round(screen.height * 0.055)}`);
  }
  await sleep(2500);
  return true;
}

async function tapShopTab(device, screen) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { nodes } = await dumpUi(device);
    // Prefer top search-result tabs (店铺 next to 全部/直播/综合)
    const shopTab = nodes.find((n) => nodeValue(n) === '店铺' && n.bounds && n.bounds.y < 280);
    if (shopTab) {
      await device.shell(
        `input tap ${Math.round(shopTab.bounds.x + shopTab.bounds.width / 2)} ${Math.round(shopTab.bounds.y + shopTab.bounds.height / 2)}`,
      );
      await sleep(2200);
      return true;
    }
    // Coordinate fallbacks on tab row (~y=155 on 1600h)
    const xs = [260, 320, 380, 220];
    await device.shell(`input tap ${xs[attempt] || 300} 155`);
    await sleep(1800);
    const again = await dumpUi(device);
    if (again.nodes.some((n) => nodeValue(n) === '进店')) return true;
  }
  console.warn('[shop-tab] 店铺 tab not confirmed');
  return false;
}

async function openSearchShopTab(device, screen, keyword) {
  await bringDouyinMallToFront(device, screen);
  try {
    await searchGoldenGoose(device, screen, keyword);
  } catch (e) {
    console.warn(`[shop-tab] search wait soft-fail: ${e.message}`);
  }
  // Always force-submit (suggestion page is common after Chinese paste)
  await ensureSearchSubmitted(device, screen);
  await sleep(800);
  await ensureSearchSubmitted(device, screen);
  await sleep(1500);
  // Confirm not on suggestion list
  let { nodes } = await dumpUi(device);
  const vals = nodes.map((n) => nodeValue(n));
  if (!vals.includes('综合') && !vals.includes('店铺') && !vals.includes('销量')) {
    console.warn('[shop-tab] still no result tabs — tap 搜索 once more');
    await device.shell(`input tap ${Math.round(screen.width * 0.92)} ${Math.round(screen.height * 0.055)}`);
    await sleep(2500);
  }
  await tapShopTab(device, screen);
  // Confirm 进店-like UI
  ({ nodes } = await dumpUi(device));
  const hasEnter = nodes.some((n) => nodeValue(n).includes('进店')) || findEnterButtons(nodes, screen).length > 0;
  console.log(`[shop-tab] on shop list? enterCandidates=${findEnterButtons(nodes, screen).length} hasEnterText=${hasEnter}`);
}

function findEnterButtons(nodes, screen) {
  // 1) explicit 进店 text/desc
  let btns = nodes.filter((n) => {
    if (!n.bounds || n.bounds.y < 200 || n.bounds.y > screen.height - 100) return false;
    const v = nodeValue(n);
    return v === '进店' || v.includes('进店');
  });
  // 2) right-side small clickable nodes (进店 often lacks a11y text)
  if (btns.length === 0) {
    btns = nodes.filter((n) => {
      if (!n.bounds) return false;
      const b = n.bounds;
      if (b.y < 220 || b.y > screen.height - 120) return false;
      if (b.x < screen.width * 0.72) return false;
      if (b.width < 60 || b.width > 220) return false;
      if (b.height < 36 || b.height > 90) return false;
      const clickable = String(n.clickable || '') === 'true';
      const v = nodeValue(n);
      if (v && !/进店|进|店/.test(v) && v.length > 6) return false;
      return clickable || !v;
    });
  }
  return btns;
}

/**
 * Collect shops from 店铺 tab via 「进店」 (+ coordinate fallback).
 * Returns array of { name, enterPoint }
 */
async function collectShops(device, screen, maxScrolls) {
  const shops = [];
  const seenKeys = new Set();

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    try {
      // Health check: abort if app crashed
      const { isAppAlive } = await import('./app-health.mjs');
      if (!(await isAppAlive(device))) {
        console.error('[shop-tab] App dead — aborting shop collection');
        break;
      }

      const { nodes } = await dumpUi(device);
      let enterBtns = findEnterButtons(nodes, screen);
      let newCount = 0;

      // 3) pure coordinate slots if dump still empty (900x1600 shop cards)
      if (enterBtns.length === 0) {
        const x = Math.round(screen.width * 0.88);
        const ys = [260, 720, 1180].map((y) => Math.round(y * (screen.height / 1600)));
        enterBtns = ys
          .filter((y) => y > 200 && y < screen.height - 100)
          .map((y) => ({ bounds: { x: x - 40, y: y - 20, width: 80, height: 40 }, _coord: true }));
        console.log(`[shop-tab] scroll=${scroll} using coord 进店 slots`);
      }

      for (const btn of enterBtns) {
        const pt = btn._coord
          ? { x: Math.round(btn.bounds.x + btn.bounds.width / 2), y: Math.round(btn.bounds.y + btn.bounds.height / 2) }
          : centerOf(btn);
        const key = `${pt.x},${Math.round(pt.y / 40)}`;
        if (seenKeys.has(key)) continue;

        const bandTop = btn.bounds.y - 100;
        const bandBot = btn.bounds.y + btn.bounds.height + 50;
        const nameNodes = nodes.filter((n) => {
          if (!n.bounds) return false;
          const v = nodeValue(n);
          if (!v || v === '进店' || v.length < 2 || v.length > 40) return false;
          if (/^(直播|关注|粉丝|已售|综合|销量|店铺|全部|视频|进店|抖音)/.test(v)) return false;
          if (n.bounds.y < bandTop || n.bounds.y > bandBot) return false;
          if (n.bounds.x >= (btn.bounds.x || screen.width * 0.7) - 10) return false;
          return true;
        });
        nameNodes.sort((a, b) => nodeValue(b).length - nodeValue(a).length);
        let name = nameNodes[0] ? nodeValue(nameNodes[0]) : `店铺${shops.length + 1}`;
        if (/^(官方旗舰店|旗舰店|专营店|专卖店)$/.test(name) && nameNodes[1]) {
          name = nodeValue(nameNodes[1]) + name;
        }

        // dedupe by name
        if (shops.some((s) => s.name === name)) continue;
        seenKeys.add(key);
        shops.push({ name, enterPoint: pt });
        newCount++;
      }

      console.log(`[shop-tab] scroll=${scroll} new=${newCount} total=${shops.length}`);
      if (newCount === 0 && scroll >= 3) break;
      await device.shell(
        `input swipe ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.82)} ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.28)} 400`,
      );
      await sleep(1100);
    } catch {
      break;
    }
  }
  return shops;
}

/** Enter shop by re-finding list and tapping stored enter point / name. */
async function findAndEnterShop(device, screen, shop, maxScrolls = 25) {
  // First try direct stored point after reopening list (list at top)
  if (shop.enterPoint && maxScrolls > 0) {
    await device.shell(`input tap ${shop.enterPoint.x} ${shop.enterPoint.y}`);
    await sleep(2800);
    // Heuristic: left shop list if we see 商品 tab or product-like content
    const { nodes } = await dumpUi(device);
    const vals = nodes.map((n) => nodeValue(n));
    if (vals.includes('商品') || vals.includes('进店') === false && vals.some((v) => v && v.length > 12)) {
      // might be inside shop if no 进店 and has long titles
      if (!vals.includes('进店') || vals.includes('商品')) return true;
    }
  }

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    const { nodes } = await dumpUi(device);
    const enterBtns = findEnterButtons(nodes, screen);
    for (const btn of enterBtns) {
      const pt = centerOf(btn) || {
        x: Math.round(btn.bounds.x + btn.bounds.width / 2),
        y: Math.round(btn.bounds.y + btn.bounds.height / 2),
      };
      const bandTop = btn.bounds.y - 100;
      const bandBot = btn.bounds.y + 80;
      const near = nodes.filter((n) => {
        if (!n.bounds) return false;
        const v = nodeValue(n);
        return v && n.bounds.y >= bandTop && n.bounds.y <= bandBot && n.bounds.x < btn.bounds.x;
      });
      const hit = near.some((n) => {
        const v = nodeValue(n);
        return v === shop.name || v.includes(shop.name) || shop.name.includes(v);
      });
      if (hit || Math.abs(pt.y - shop.enterPoint.y) < 80) {
        await device.shell(`input tap ${pt.x} ${pt.y}`);
        await sleep(3000);
        return true;
      }
    }
    const match = nodes.find((n) => n.bounds && nodeValue(n) === shop.name);
    if (match) {
      await device.shell(`input tap ${centerOf(match).x} ${centerOf(match).y}`);
      await sleep(3000);
      return true;
    }
    await device.shell(
      `input swipe ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.8)} ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.3)} 400`,
    );
    await sleep(1000);
  }
  // last resort: original coordinate
  if (shop.enterPoint) {
    await device.shell(`input tap ${shop.enterPoint.x} ${shop.enterPoint.y}`);
    await sleep(3000);
    return true;
  }
  return false;
}

async function collectShopProducts(device, screen, shopName, keyword, enricher, shareLimiter, config) {
  const cards = [];
  const seen = new Set();
  for (let scroll = 0; scroll < config.maxScrolls; scroll++) {
    try {
      const { nodes } = await dumpUi(device);
      const titleNodes = nodes.filter((n) => {
        if (!n.bounds || n.bounds.y < 400) return false;
        const v = nodeValue(n);
        return v.length >= 8 && v.length <= 200 && n.bounds.width >= 200;
      });
      let found = 0;
      for (const tn of titleNodes) {
        const title = nodeValue(tn);
        if (seen.has(title)) continue;
        if (/^(券后价|已售|官方正品|店铺销量|包邮|现价|¥|￥|\d+万|\d+件)/.test(title)) continue;
        seen.add(title);
        if (titleMatchesKeyword(title, keyword)) {
          cards.push({ title, tapPoint: centerOf(tn) });
          found++;
        }
      }
      if (found === 0 && scroll >= 2) break;
      await device.shell(
        `input swipe ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.8)} ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.3)} 400`,
      );
      await sleep(1200);
    } catch {
      break;
    }
  }
  console.log(`  [shop] ${shopName}: ${cards.length} matching products`);

  const products = [];
  for (const card of cards) {
    try {
      await device.shell(`input tap ${card.tapPoint.x} ${card.tapPoint.y}`);
      await sleep(2500);
      const prevUrl = await readCurrentDouyinShareUrl();
      await shareLimiter.waitForSlot();
      shareLimiter.recordAction();
      const share = await copyCurrentProductShareLink(device, screen, () => waitForDouyinShareUrl({ previousUrl: prevUrl }));
      let product = await enricher.enrich(share.url);
      product['搜索关键词'] = keyword;
      product['店铺名'] = shopName || product['店铺名'] || '';
      // H5 pack fill missing title/price/shop (no extra share click)
      if (product['商品id'] && (!product['商品品名'] || !product['价格'] || !product['店铺名'])) {
        try {
          const h5 = await enrichOneProductId(product['商品id'], product);
          if (h5) {
            product = {
              ...product,
              商品品名: product['商品品名'] || h5['商品品名'] || '',
              店铺名: product['店铺名'] || h5['店铺名'] || shopName || '',
              价格: product['价格'] || h5['价格'] || '',
              销量: product['销量'] || h5['销量'] || '',
            };
          }
        } catch {
          /* keep enricher result */
        }
      }
      if (!product['店铺名']) product['店铺名'] = shopName;
      products.push(product);
      console.log(`    [${products.length}] ${String(product['商品品名'] || '').slice(0, 40)} | ${product['价格']}`);
      await device.shell('input keyevent 4');
      await sleep(1500);
    } catch (e) {
      console.warn(`    skip: ${String(e.message || e).slice(0, 60)}`);
      await device.shell('input keyevent 4').catch(() => {});
      await sleep(1000);
    }
  }
  return products;
}

function toCsv(products) {
  const body = products
    .map((p) =>
      OUTPUT_FIELDS.map((f) => {
        const v = String(p[f] ?? '');
        return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(','),
    )
    .join('\r\n');
  return `\uFEFF${OUTPUT_FIELDS.join(',')}\r\n${body}${body ? '\r\n' : ''}`;
}

async function writeProducts(outFile, products) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, toCsv(products), 'utf8');
}

export async function crawlShopTab(config) {
  const {
    serial = 'emulator-5554',
    keyword = '小脏鞋',
    outputPath,
    maxScrolls = 20,
    gentle = true,
  } = config;

  const devices = await (await import('playwright'))._android.devices({ host: '127.0.0.1', port: 5037 });
  const device = devices.find((d) => d.serial() === serial);
  if (!device) throw new Error(`Device ${serial} not found`);

  const outFile = outputPath || `output/shop-tab-${keyword === '小脏鞋' ? 'xiaozangxie' : keyword}.csv`;

  try {
    const screen = await getScreenSize(device);
    console.log(`[shop-tab] keyword=${keyword} serial=${serial} gentle=${gentle}`);
    await openSearchShopTab(device, screen, keyword);

    console.log('[shop-tab] Collecting shop list (进店 buttons)...');
    const shops = await collectShops(device, screen, maxScrolls);
    console.log(`[shop-tab] Found ${shops.length} shops: ${shops.slice(0, 8).map((s) => s.name).join(', ')}${shops.length > 8 ? '...' : ''}`);

    const allProducts = [];
    const enricher = await createSharePageEnricher({ headless: true, stealth: true });
    const shareLimiter = createShareRateLimiter({
      maxActions: gentle ? 8 : 20,
      windowMs: gentle ? 15 * 60_000 : 10 * 60_000,
      onWait: (d) => console.warn(`[throttle] wait ${Math.ceil(d / 60000)}m...`),
    });

    try {
      for (let i = 0; i < shops.length; i++) {
        const shop = shops[i];
        const name = shop.name;
        console.log(`\n[shop] (${i + 1}/${shops.length}) ${name}`);

        // Health check before re-entering shop list
        const { isAppAlive } = await import('./app-health.mjs');
        if (!(await isAppAlive(device))) {
          console.error('[shop-tab] App dead before entering shop — aborting');
          break;
        }

        // Fresh search + 店铺 tab so list is at top, then scroll to name
        await openSearchShopTab(device, screen, keyword);
        const opened = await findAndEnterShop(device, screen, shop, maxScrolls);
        if (!opened) {
          console.warn(`  [shop] could not re-find: ${name}`);
          continue;
        }

        // Prefer 商品 tab inside shop
        try {
          const { nodes: sn } = await dumpUi(device);
          const goodsTab = sn.find((n) => nodeValue(n) === '商品' && n.bounds && n.bounds.y < 550);
          if (goodsTab) {
            await device.shell(
              `input tap ${Math.round(goodsTab.bounds.x + goodsTab.bounds.width / 2)} ${Math.round(goodsTab.bounds.y + goodsTab.bounds.height / 2)}`,
            );
            await sleep(1200);
          }
        } catch {
          /* ignore */
        }

        const products = await collectShopProducts(device, screen, name, keyword, enricher, shareLimiter, {
          maxScrolls: 15,
        });
        allProducts.push(...products);
        await writeProducts(outFile, allProducts);
        console.log(`  [checkpoint] ${allProducts.length} products → ${outFile}`);

        for (let b = 0; b < 3; b++) {
          await device.shell('input keyevent 4').catch(() => {});
          await sleep(400);
        }
      }
    } finally {
      await enricher.close().catch(() => {});
    }

    await writeProducts(outFile, allProducts);
    console.log(`\nDone: ${allProducts.length} products written to ${outFile}`);
    return allProducts;
  } finally {
    await Promise.allSettled(devices.map((d) => d.close()));
  }
}
