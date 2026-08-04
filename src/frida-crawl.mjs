/**
 * Frida + light UI crawler for Douyin Mall.
 * Flow: search keyword → tap product cards (grid fallback when dump empty)
 *       → share → capture v.douyin.com via Frida (Windows clipboard fallback)
 *       → enrich → CSV
 *
 * Prerequisites:
 *   adb root
 *   /data/local/tmp/frida-server running as root
 *   Douyin Mall (livelite) running
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AccessDeniedError,
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
import { readCurrentDouyinShareUrl } from './clipboard.mjs';
import { createSharePageEnricher } from './enrich.mjs';
import { createFridaCapture } from './frida-capture.mjs';
import { loadCheckpoint, productIdentityKey, writeArtifacts } from './output.mjs';
import { accessDeniedBackoff, createShareRateLimiter } from './rate-limit.mjs';
import { captureProductUrl, enrichFromAnySource } from './share-url-capture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function titleMatchesKeyword(title, keyword) {
  const t = String(title || '').toLowerCase();
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return true;
  if (t.includes(kw)) return true;
  if (kw === 'ggdb' && (t.includes('goldengoose') || t.includes('golden goose'))) return true;
  if (kw === '小脏鞋' && t.includes('小脏鞋')) return true;
  return false;
}

/** 2-column mall grid tap points when accessibility has no titles. */
function gridTapPoints(screen, rows = 2) {
  const points = [];
  const xs = [0.28, 0.72];
  // First product row roughly mid-upper after search chrome
  const y0 = 0.42;
  const dy = 0.28;
  for (let r = 0; r < rows; r++) {
    for (const x of xs) {
      points.push({
        x: Math.round(screen.width * x),
        y: Math.round(screen.height * (y0 + r * dy)),
        title: `grid-${r}-${x}`,
      });
    }
  }
  return points;
}

async function persist(config, products, errors, startedAt, completed = false) {
  await writeArtifacts({
    products,
    outputPath: config.outputPath,
    checkpointPath: config.checkpointPath,
    summaryPath: config.summaryPath,
    summary: {
      mode: 'frida',
      query: config.query,
      serial: config.serial,
      requested: config.all ? 'all' : config.limit,
      collected: products.length,
      completed,
      startedAt,
      updatedAt: new Date().toISOString(),
      errors,
    },
  });
}

async function captureShare(device, screen, fridaCapture, shareLimiter) {
  const previousUrl = await readCurrentDouyinShareUrl();
  fridaCapture?.clearEvents?.();

  await shareLimiter.waitForSlot();
  shareLimiter.recordAction();

  // Use the multi-source orchestrator to race Frida + clipboard + share-click
  const result = await captureProductUrl({
    device, screen, fridaCapture,
    previousUrl,
    timeoutMs: 20_000,
  });

  if (!result?.url && !result?.productId) {
    throw new Error('No share URL from any capture source');
  }

  return {
    url: result.url || '',
    source: result.source || 'orchestrator',
    productId: result.productId || '',
  };
}

export async function runFridaCrawler(config) {
  const startedAt = new Date().toISOString();
  const query = config.query || '小脏鞋';
  const products = config.fresh ? [] : await loadCheckpoint(config.checkpointPath);
  const errors = [];
  const productKeys = new Set(products.map(productIdentityKey));
  const attemptedKeys = new Set(products.map((p) => p.商品品名).filter(Boolean));

  let androidConnection;
  let enricher;
  let fridaCapture;

  await fs.mkdir(config.diagnosticsDir, { recursive: true });

  try {
    androidConnection = await connectMuMu(config.serial);
    const { device } = androidConnection;
    const screen = await getScreenSize(device);

    await bringDouyinMallToFront(device, screen);
    try {
      fridaCapture = await createFridaCapture({ serial: config.serial });
    } catch (e) {
      console.warn(`[frida] attach failed: ${e.message}`);
      console.warn('[frida] continuing with Windows clipboard only');
    }

    if (!config.skipSearch) {
      // Hard-validate keyword — refuse garbage (paths, plan files, chat logs)
      if (!query || query.length > 40 || /[\\/]|\.md|HANDoFF|ctrl\+|claude|plans/i.test(query)) {
        throw new Error(`Refusing suspicious search keyword: ${JSON.stringify(query)}`);
      }
      console.log(`[frida-crawl] search: ${JSON.stringify(query)}`);
      try {
        await searchGoldenGoose(device, screen, query);
      } catch (searchErr) {
        // 39.6.0 often has empty accessibility text; still try coordinate grid crawl
        console.warn(`[frida-crawl] search wait soft-fail: ${searchErr.message}`);
        console.warn('[frida-crawl] continuing with grid taps on current screen');
      }
      await captureDeviceScreenshot(device, path.join(config.diagnosticsDir, 'frida-search.png')).catch(() => {});
    }

    enricher = await createSharePageEnricher({
      headless: !config.headed,
      stealth: config.stealth !== false,
      proxy: config.proxy ? { server: config.proxy } : null,
    });

    const shareLimiter = createShareRateLimiter({
      maxActions: config.maxSharesPerWindow ?? (config.gentle ? 8 : 20),
      windowMs: config.shareWindowMs ?? (config.gentle ? 15 * 60_000 : 10 * 60_000),
      onWait: (d) => console.warn(`[throttle] wait ${Math.ceil(d / 60_000)}m`),
    });

    let emptyScrolls = 0;
    let accessDeniedCount = 0;
    const maxScrolls = config.all
      ? (Number.isFinite(config.maxScrolls) ? config.maxScrolls : 80)
      : (config.maxScrolls || 30);
    const limit = config.all ? Number.POSITIVE_INFINITY : (config.limit || 20);

    for (let scrollIndex = 0; scrollIndex < maxScrolls && products.length < limit; scrollIndex++) {
      // 1) Prefer accessibility candidates
      let candidates = (await readVisibleCandidates(device, query))
        .filter((c) => !c.isLive && c.titleBounds?.y >= 400);

      // 2) Grid fallback when dump is empty (common on 39.6.0 mall search)
      if (!candidates.length) {
        console.log(`[frida-crawl] scroll=${scrollIndex} dump candidates=0 → grid taps`);
        candidates = gridTapPoints(screen, 2).map((pt) => ({
          title: pt.title,
          isLive: false,
          titleBounds: { y: pt.y },
          tapPoint: { x: pt.x, y: pt.y },
          _grid: true,
        }));
      } else {
        console.log(`[frida-crawl] scroll=${scrollIndex} candidates=${candidates.length}`);
      }

      let collectedThisScroll = 0;

      for (const candidate of candidates) {
        if (products.length >= limit) break;
        if (!candidate._grid && attemptedKeys.has(candidate.title)) continue;
        if (!candidate._grid) attemptedKeys.add(candidate.title);

        try {
          // Health check before each product: if app crashed, soft-restart + re-attach Frida
          const { ensureAppAlive } = await import('./app-health.mjs');
          const health = await ensureAppAlive(device, screen);
          if (!health.ok) {
            console.error('[health] App dead, cannot recover — aborting scroll');
            break;
          }
          if (health.restarted) {
            console.log('[frida] Re-attaching Frida after app restart...');
            await fridaCapture?.close().catch(() => {});
            try {
              fridaCapture = await createFridaCapture({ serial: config.serial });
              console.log('[frida] Frida re-attached.');
            } catch (e) {
              console.warn(`[frida] Frida re-attach failed: ${e.message} — continuing without Frida`);
              fridaCapture = null;
            }
            await searchGoldenGoose(device, screen, query).catch(() => {});
          }

          if (candidate._grid) {
            await device.shell(`input tap ${candidate.tapPoint.x} ${candidate.tapPoint.y}`);
            await sleep(2200);
          } else {
            await openCandidate(device, candidate);
          }

          // Optional: detail meta from Frida while on product page
          const detailMeta = fridaCapture
            ? await fridaCapture.waitForProduct({ timeoutMs: 3_500 })
            : null;

          const share = await captureShare(device, screen, fridaCapture, shareLimiter);

          // Use unified enrichment — tries Frida response body, browser, H5 pack
          const product = await enrichFromAnySource({
            productId: share.productId || detailMeta?.商品id || '',
            url: share.url || '',
            enricher,
            fridaMeta: detailMeta,
          });
          product.搜索关键词 = query;
          // Merge any Frida detail meta not captured by enrich
          product.商品品名 = product.商品品名 || detailMeta?.商品品名 || '';
          product.分享的链接 = product.分享的链接 || share.url;

          // Keyword filter (grid may open unrelated cards)
          if (!titleMatchesKeyword(product.商品品名, query)) {
            console.warn(`[skip-keyword] ${String(product.商品品名).slice(0, 40)}`);
            await returnToResults(device, query).catch(() => {});
            continue;
          }

          const key = productIdentityKey(product);
          if (productKeys.has(key)) {
            console.log(`[dup] ${String(product.商品品名).slice(0, 40)}`);
          } else {
            productKeys.add(key);
            products.push(product);
            collectedThisScroll += 1;
            console.log(
              `[${products.length}] ${String(product.商品品名).slice(0, 42)} | ${product.价格} | ${product.分享的链接} (${share.source})`,
            );
            await persist(config, products, errors, startedAt, false);
          }
        } catch (error) {
          if (error instanceof AccessDeniedError) {
            accessDeniedCount += 1;
            errors.push({ title: candidate.title, type: 'access_denied', message: error.message, at: new Date().toISOString() });
            await device.shell('input keyevent 4').catch(() => {});
            await persist(config, products, errors, startedAt, false);
            if (accessDeniedCount >= (config.maxAccessDeniedRetries || 3)) {
              console.warn('[access-denied] max retries — stop');
              await persist(config, products, errors, startedAt, false);
              return { products, errors, completed: false };
            }
            const cool = accessDeniedBackoff(config.accessDeniedCooldownMs || 15 * 60_000, accessDeniedCount);
            console.warn(`[access-denied] cooldown ${Math.ceil(cool / 60_000)}m`);
            await sleep(cool);
            await bringDouyinMallToFront(device, screen);
            await searchGoldenGoose(device, screen, query);
            // re-attach frida after long wait (app may have restarted)
            try {
              await fridaCapture?.close().catch(() => {});
              fridaCapture = await createFridaCapture({ serial: config.serial });
            } catch {
              /* ignore */
            }
            break;
          }
          errors.push({ title: candidate.title, message: error.message, at: new Date().toISOString() });
          console.warn(`[skip] ${candidate.title}: ${String(error.message).slice(0, 80)}`);
          await captureDeviceScreenshot(
            device,
            path.join(config.diagnosticsDir, `frida-err-${errors.length}.png`),
          ).catch(() => {});
        } finally {
          await returnToResults(device, query).catch(async () => {
            for (let b = 0; b < 2; b++) {
              await device.shell('input keyevent 4').catch(() => {});
              await sleep(400);
            }
          });
          await sleep(600);
          const { interProductCooldown } = await import('./app-health.mjs');
          await interProductCooldown();
        }
      }

      emptyScrolls = collectedThisScroll === 0 ? emptyScrolls + 1 : 0;
      if (emptyScrolls >= (config.all ? 10 : 5)) {
        console.log('[frida-crawl] exhausted (idle scrolls)');
        break;
      }
      await scrollResults(device, screen);
      await sleep(900);
    }

    const completed = products.length > 0 && (config.all ? emptyScrolls >= 10 : products.length >= limit);
    await persist(config, products, errors, startedAt, completed || config.all);
    console.log(`[frida-crawl] done collected=${products.length} errors=${errors.length}`);
    return { products, errors, completed: completed || Boolean(config.all && emptyScrolls >= 10) };
  } finally {
    await fridaCapture?.close().catch(() => {});
    await enricher?.close().catch(() => {});
    if (androidConnection) {
      await Promise.allSettled(androidConnection.devices.map((d) => d.close()));
    }
  }
}
