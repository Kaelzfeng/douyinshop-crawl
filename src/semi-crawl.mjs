/**
 * Semi-reverse crawler — NO share button.
 *
 * Flow:
 *   search keyword → open product card
 *   → Frida intercepts product_id / goods_detail / haohuo long URL
 *   → H5 pack (a_bogus) fills 商品品名/店铺名/价格/销量 when possible
 *   → write CSV (分享的链接 = long haohuo URL when short link unavailable)
 *
 * Stability notes (2026-07):
 *   - Prefer accessibility product cards over grid taps (grid often misses id).
 *   - Chinese search uses Windows clipboard seed + paste (setWindowsClipboard).
 *   - H5 pack may mask price without session; title/shop usually OK.
 *   - For production short links still use share-click / Frida shorten later.
 *
 * Prereq: adb root + frida-server as root + Douyin Mall running
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  bringDouyinMallToFront,
  captureDeviceScreenshot,
  connectMuMu,
  getScreenSize,
  openCandidate,
  readVisibleCandidates,
  returnToResults,
  scrollResults,
  searchGoldenGoose,
} from './android.mjs';
import { createSharePageEnricher } from './enrich.mjs';
import { createFridaCapture } from './frida-capture.mjs';
import { loadCheckpoint, productIdentityKey, writeArtifacts } from './output.mjs';
import { buildHaohuoLink, enrichFromAnySource } from './share-url-capture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function titleMatchesKeyword(title, keyword) {
  const t = String(title || '').toLowerCase();
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return true;
  if (t.includes(kw)) return true;
  // ggdb ≈ golden goose / 脏脏鞋 brand line
  if (kw === 'ggdb' && (t.includes('goldengoose') || t.includes('golden goose') || t.includes('ggdb') || t.includes('脏脏鞋'))) {
    return true;
  }
  // 小脏鞋 style — include generic 脏脏鞋 but not GGDB brand titles
  if (kw === '小脏鞋' || kw === '\u5c0f\u810f\u978b') {
    if (t.includes('小脏鞋') || t.includes('\u5c0f\u810f\u978b')) return true;
    if (t.includes('脏脏鞋') && !/golden\s*goose|goldengoose|ggdb/i.test(t)) return true;
    return false;
  }
  return false;
}

function gridTapPoints(screen, rows = 2) {
  const points = [];
  const xs = [0.28, 0.72];
  const y0 = 0.35;  // lower to avoid banner/live-stream zone
  const dy = 0.26;
  for (let r = 0; r < rows; r++) {
    for (const x of xs) {
      points.push({
        title: `grid-${r}-${x}`,
        tapPoint: { x: Math.round(screen.width * x), y: Math.round(screen.height * (y0 + r * dy)) },
        _grid: true,
      });
    }
  }
  return points;
}

/** Stable product URL builder — re-exported from orchestrator. */

export function productFromFrida(meta, keyword) {
  if (!meta) return null;
  const productId = meta.商品id || meta.productId || '';
  const title = meta.商品品名 || meta.title || '';
  const price = meta.价格 || meta.price || '';
  const sales = meta.销量 || meta.sales || '';
  const rawUrl = meta.分享的链接 || meta._detailUrl || meta.url || '';
  const share = /v\.douyin\.com/.test(rawUrl)
    ? rawUrl
    : buildHaohuoLink({ productId, title, sales, rawUrl });

  if (!productId && !title && !share) return null;

  return {
    搜索关键词: keyword,
    商品id: productId,
    商品品名: title,
    店铺名: meta.店铺名 || '',
    价格: price,
    销量: sales,
    分享的链接: share,
    _source: meta._source || meta.source || 'frida-semi',
  };
}

async function persist(config, products, errors, startedAt, completed = false) {
  await writeArtifacts({
    products,
    outputPath: config.outputPath,
    checkpointPath: config.checkpointPath,
    summaryPath: config.summaryPath,
    summary: {
      mode: 'semi',
      query: config.query,
      serial: config.serial,
      requested: config.all ? 'all' : config.limit,
      collected: products.length,
      completed,
      noShareClick: true,
      startedAt,
      updatedAt: new Date().toISOString(),
      errors,
    },
  });
}

export async function runSemiCrawler(config) {
  const startedAt = new Date().toISOString();
  const query = config.query || '\u5c0f\u810f\u978b';
  const products = config.fresh ? [] : await loadCheckpoint(config.checkpointPath);
  const errors = [];
  const productKeys = new Set(products.map(productIdentityKey));
  const attemptedTitles = new Set(products.map((p) => p.商品品名).filter(Boolean));

  let androidConnection;
  let enricher;
  let fridaCapture;

  await fs.mkdir(config.diagnosticsDir, { recursive: true });

  try {
    androidConnection = await connectMuMu(config.serial);
    const { device } = androidConnection;
    const screen = await getScreenSize(device);

    await bringDouyinMallToFront(device, screen);

    fridaCapture = await createFridaCapture({
      serial: config.serial,
      bundlePath: path.resolve('hook/capture-semi.bundle.js'),
    });
    console.log('[semi] Frida attached — share button will NOT be used');

    if (!config.skipSearch) {
      if (!query || query.length > 40 || /[\\/]|\.md|claude|plans/i.test(query)) {
        throw new Error(`Refusing suspicious keyword: ${JSON.stringify(query)}`);
      }
      console.log(`[semi] search ${JSON.stringify(query)}`);
      try {
        await searchGoldenGoose(device, screen, query);
      } catch (e) {
        console.warn(`[semi] search soft-fail: ${e.message}`);
      }
      await captureDeviceScreenshot(device, path.join(config.diagnosticsDir, 'semi-search.png')).catch(() => {});
    }

    // Browser enrich only when Frida fields incomplete
    enricher = await createSharePageEnricher({
      headless: !config.headed,
      stealth: config.stealth !== false,
      proxy: config.proxy ? { server: config.proxy } : null,
    });

    const maxScrolls = config.all
      ? (Number.isFinite(config.maxScrolls) && config.maxScrolls < 1e9 ? config.maxScrolls : 60)
      : (config.maxScrolls || 30);
    const limit = config.all ? Number.POSITIVE_INFINITY : (config.limit || 20);
    let emptyScrolls = 0;

    for (let scrollIndex = 0; scrollIndex < maxScrolls && products.length < limit; scrollIndex++) {
      let candidates = (await readVisibleCandidates(device, query))
        .filter((c) => !c.isLive && (c.titleBounds?.y ?? 0) >= 200);

      if (!candidates.length) {
        // Grid taps are unreliable for product_id; only try once every few scrolls
        if (scrollIndex % 2 === 0) {
          console.log(`[semi] scroll=${scrollIndex} dump=0 → grid (fallback)`);
          candidates = gridTapPoints(screen, 1);
        } else {
          console.log(`[semi] scroll=${scrollIndex} dump=0 → skip grid, keep scrolling`);
          emptyScrolls += 1;
          if (emptyScrolls >= (config.all ? 10 : 5)) break;
          await scrollResults(device, screen);
          await sleep(800);
          continue;
        }
      } else {
        console.log(`[semi] scroll=${scrollIndex} candidates=${candidates.length}`);
      }

      let collectedThisScroll = 0;

      for (const candidate of candidates) {
        if (products.length >= limit) break;
        if (!candidate._grid && attemptedTitles.has(candidate.title)) continue;
        if (!candidate._grid) attemptedTitles.add(candidate.title);

        try {
          // Health check before each product: if app crashed, soft-restart + re-attach Frida
          const { ensureAppAlive } = await import('./app-health.mjs');
          const health = await ensureAppAlive(device, screen);
          if (!health.ok) {
            console.error('[health] App dead, cannot recover — aborting scroll');
            break;
          }
          if (health.restarted) {
            console.log('[semi] Re-attaching Frida after app restart...');
            await fridaCapture?.close().catch(() => {});
            try {
              fridaCapture = await createFridaCapture({
                serial: config.serial,
                bundlePath: path.resolve('hook/capture-semi.bundle.js'),
              });
              console.log('[semi] Frida re-attached.');
            } catch (e) {
              console.warn(`[semi] Frida re-attach failed: ${e.message} — continuing without Frida`);
              fridaCapture = null;
            }
            // Re-search after restart to get back to results
            await searchGoldenGoose(device, screen, query).catch(() => {});
          }

          fridaCapture?.clearEvents();

          if (candidate._grid) {
            await device.shell(`input tap ${candidate.tapPoint.x} ${candidate.tapPoint.y}`);
            await sleep(2800);
          } else {
            await openCandidate(device, candidate);
            await sleep(1200);
          }

          // Nudge detail page so pack / schema traffic fires for Frida
          // Skip nudge if we may have bounced off the product page
          await device.shell(
            `input swipe ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.7)} ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.55)} 300`,
          ).catch(() => {});
          await sleep(1200);

          // Wait for Frida product signals (NO share click)
          // NOTE: waitForProduct scans from event 0 because clearEvents was called above;
          // events from all tap attempts are in the array and will be checked.
          const meta = await fridaCapture.waitForProduct({ timeoutMs: 12_000, requireId: false });
          let product = productFromFrida(meta, query);

          // Last resort: scan raw events for product_id only
          if ((!product || !product.商品id) && fridaCapture.getEvents) {
            for (const e of fridaCapture.getEvents().slice(-80)) {
              const blob = JSON.stringify(e);
              const m = blob.match(/product_id[=%:\"]+(\d{15,})/i) || blob.match(/\"id\"\s*:\s*\"?(\d{15,})/);
              if (m) {
                product = product || productFromFrida({ 商品id: m[1], _detailUrl: '', _source: 'raw-scan' }, query);
                if (product && !product.商品id) product.商品id = m[1];
                break;
              }
            }
          }

          // Enrich from all available sources (Frida response body, H5 pack, browser)
          if (product?.商品id || meta?._detailUrl || meta?.url) {
            try {
              const enriched = await enrichFromAnySource({
                productId: product?.商品id || '',
                url: product?.分享的链接 || meta?._detailUrl || meta?.url || '',
                enricher,
                fridaMeta: meta,
              });
              if (enriched) {
                product = {
                  ...product,
                  商品品名: product.商品品名 || enriched.商品品名 || '',
                  店铺名: product.店铺名 || enriched.店铺名 || '',
                  价格: product.价格 || enriched.价格 || '',
                  销量: product.销量 || enriched.销量 || '',
                  分享的链接: product.分享的链接 || enriched.分享的链接 || '',
                  _source: `${product._source || 'semi'}+enrich`,
                };
                console.log(`[semi] enrich id=${product.商品id} title=${String(product.商品品名).slice(0, 28)} price=${product.价格}`);
              }
            } catch (e) {
              console.warn(`[semi] enrich skip: ${String(e.message).slice(0, 80)}`);
            }
          }

          // Fallback title from search card
          if (product && !product.商品品名 && candidate.title && !candidate._grid) {
            product.商品品名 = candidate.title;
          }

          if (!product || (!product.商品id && !product.商品品名)) {
            throw new Error('Frida did not capture product_id/title (no share path)');
          }

          if (!titleMatchesKeyword(product.商品品名, query) && !titleMatchesKeyword(candidate.title || '', query)) {
            console.warn(`[skip-keyword] ${String(product.商品品名 || candidate.title).slice(0, 40)}`);
            await returnToResults(device, query).catch(() => {});
            continue;
          }

          // Ensure keyword field and stable link
          product.搜索关键词 = query;
          if (!product.分享的链接 && product.商品id) {
            product.分享的链接 = buildHaohuoLink({
              productId: product.商品id,
              title: product.商品品名,
              sales: product.销量,
            });
          }

          const key = productIdentityKey(product);
          if (productKeys.has(key)) {
            console.log(`[dup] ${String(product.商品品名).slice(0, 40)}`);
          } else {
            productKeys.add(key);
            products.push(product);
            collectedThisScroll += 1;
            console.log(
              `[${products.length}] ${String(product.商品品名).slice(0, 42)} | ${product.价格} | id=${product.商品id} (${product._source})`,
            );
            await persist(config, products, errors, startedAt, false);
          }
        } catch (error) {
          errors.push({ title: candidate.title, message: error.message, at: new Date().toISOString() });
          console.warn(`[skip] ${candidate.title}: ${String(error.message).slice(0, 80)}`);
          await captureDeviceScreenshot(
            device,
            path.join(config.diagnosticsDir, `semi-err-${errors.length}.png`),
          ).catch(() => {});
        } finally {
          await returnToResults(device, query).catch(async () => {
            for (let b = 0; b < 2; b++) {
              await device.shell('input keyevent 4').catch(() => {});
              await sleep(400);
            }
          });
          await sleep(500);
          const { interProductCooldown } = await import('./app-health.mjs');
          await interProductCooldown();
        }
      }

      emptyScrolls = collectedThisScroll === 0 ? emptyScrolls + 1 : 0;
      if (emptyScrolls >= (config.all ? 10 : 5)) {
        console.log('[semi] exhausted idle scrolls');
        break;
      }
      await scrollResults(device, screen);
      await sleep(800);
    }

    const completed = products.length > 0 && (config.all ? emptyScrolls >= 10 : products.length >= limit);
    await persist(config, products, errors, startedAt, completed || Boolean(config.all));
    console.log(`[semi] done collected=${products.length} errors=${errors.length} (no share clicks)`);
    return { products, errors, completed: completed || Boolean(config.all && emptyScrolls >= 10) };
  } finally {
    await fridaCapture?.close().catch(() => {});
    await enricher?.close().catch(() => {});
    if (androidConnection) {
      await Promise.allSettled(androidConnection.devices.map((d) => d.close()));
    }
  }
}
