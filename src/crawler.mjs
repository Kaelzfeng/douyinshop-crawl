import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AccessDeniedError,
  PACKAGE_NAME,
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
import { createSharePageEnricher, parseResolvedProduct, extractShopName, formatPrice } from './enrich.mjs';
import { loadCheckpoint, productIdentityKey, writeArtifacts } from './output.mjs';
import { accessDeniedBackoff, createShareRateLimiter } from './rate-limit.mjs';
import { captureProductUrl, enrichFromAnySource } from './share-url-capture.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function persist(config, products, errors, startedAt, completed = false) {
  await writeArtifacts({
    products,
    outputPath: config.outputPath,
    checkpointPath: config.checkpointPath,
    summaryPath: config.summaryPath,
    summary: {
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

export async function runCrawler(config) {
  const startedAt = new Date().toISOString();
  const products = config.fresh ? [] : await loadCheckpoint(config.checkpointPath);
  const startingCount = config.limitPerQuery ? products.length : 0;
  const collectedForLimit = () => products.length - startingCount;
  const errors = [];
  const attemptedTitles = new Set(products.map((product) => product.商品品名).filter(Boolean));
  const productKeys = new Set(products.map(productIdentityKey));
  let androidConnection;
  let enricher;
  let fridaCapture = null;

  await fs.mkdir(config.diagnosticsDir, { recursive: true });

  try {
    androidConnection = await connectMuMu(config.serial);
    const { device } = androidConnection;
    const screen = await getScreenSize(device);
    if (!config.skipSearch) {
      await bringDouyinMallToFront(device, screen);
      await searchGoldenGoose(device, screen, config.query);
      await captureDeviceScreenshot(device, path.join(config.diagnosticsDir, 'search-results.png'));
    }

    // Try to attach Frida for API-based product capture (no share click needed)
    try {
      const { createFridaCapture } = await import('./frida-capture.mjs');
      fridaCapture = await createFridaCapture({ serial: config.serial });
      console.log('[frida] Product URL capture active — share button will NOT be clicked.');
    } catch (error) {
      console.warn(`[frida] Capture unavailable (${error.message}), falling back to share-click flow.`);
    }

    enricher = await createSharePageEnricher({
      headless: !config.headed,
      stealth: config.stealth !== false,
      proxy: config.proxy ? { server: config.proxy } : null,
    });
    const shareRateLimiter = createShareRateLimiter({
      maxActions: config.maxSharesPerWindow,
      windowMs: config.shareWindowMs,
      onWait: (delayMs) => console.warn(`[throttle] Waiting ${Math.ceil(delayMs / 60_000)} minute(s) before the next share action.`),
    });
    let emptyScrolls = 0;
    let exhausted = false;
    let accessDeniedCount = 0;
    let consecutiveFailures = 0;

    crawlLoop: for (
      let scrollIndex = 0;
      scrollIndex < config.maxScrolls && (config.all || collectedForLimit() < config.limit);
      scrollIndex += 1
    ) {
      const candidates = (await readVisibleCandidates(device, config.query))
        .filter((candidate) => (
          !candidate.isLive
          && candidate.titleBounds.y >= 520
          && !attemptedTitles.has(candidate.title)
        ));
      let collectedThisScroll = 0;
      let restartAfterCooldown = false;

      for (const candidate of candidates) {
        if (!config.all && collectedForLimit() >= config.limit) break;

        // Pre-filter: skip candidates that don't contain the keyword at all
        const kw = String(config.query || '').toLowerCase();
        const ct = (candidate.title || '').toLowerCase();
        if (kw && !ct.includes(kw) && !(kw === 'ggdb' && ct.includes('goldengoose'))) {
          attemptedTitles.add(candidate.title);
          continue;
        }

        attemptedTitles.add(candidate.title);

        try {
          // Health check: if app is dead, soft-restart before interacting
          const { ensureAppAlive } = await import('./app-health.mjs');
          const health = await ensureAppAlive(device, screen);
          if (!health.ok) {
            console.error('[health] App dead, cannot recover — breaking crawl');
            break crawlLoop;
          }

          await openCandidate(device, candidate);

          // Multi-source capture: races Frida + clipboard + share-click
          await shareRateLimiter.waitForSlot();
          shareRateLimiter.recordAction();
          const previousShareUrl = await readCurrentDouyinShareUrl();

          const capture = await captureProductUrl({
            device, screen,
            fridaCapture: fridaCapture || undefined,
            previousUrl: previousShareUrl,
            timeoutMs: 20_000,
          });

          // Unified enrichment: Frida response body > browser > H5 pack
          const product = await enrichFromAnySource({
            productId: capture?.productId || '',
            url: capture?.url || '',
            enricher,
            fridaMeta: capture?._fridaData || capture,
          });
          product.搜索关键词 = config.query;
          product.分享的链接 = product.分享的链接 || capture?.url || '';

          if (!product || (!product.商品id && !product.商品品名)) {
            throw new Error('Failed to extract product data');
          }

          // Verify keyword match before saving
          const title = (product.商品品名 || '').toLowerCase();
          const kw = String(config.query || '').trim().toLowerCase();
          if (kw && !title.includes(kw) && !title.includes('goldengoose') && !title.includes('ggdb')) {
            attemptedTitles.delete(candidate.title);
            console.warn('[skip-keyword] ' + product.商品品名.slice(0, 40));
            await returnToResults(device, config.query).catch(() => {});
            continue;
          }

          product.商品id = product.商品id || product.productId || '';
          product.店铺名 = product.店铺名 || '';
          product.价格 = product.价格 || '';
          product.销量 = product.销量 || '';
          const key = productIdentityKey(product);
          if (!productKeys.has(key)) {
            products.push(product);
            productKeys.add(key);
            collectedThisScroll += 1;
            const target = config.all ? '全部' : config.limit;
            console.log(`[${products.length}/${target}] ${product.商品品名} | ${product.价格} | ${product.销量}${product.分享的链接 ? '' : ' [no-link]'}`);
            await persist(config, products, errors, startedAt, false);
          }
        } catch (error) {
          if (error instanceof AccessDeniedError) {
            accessDeniedCount += 1;
            attemptedTitles.delete(candidate.title);
            const cooldownMs = accessDeniedBackoff(config.accessDeniedCooldownMs, accessDeniedCount);
            errors.push({
              title: candidate.title,
              type: 'access_denied',
              message: error.message,
              cooldownMs,
              at: new Date().toISOString(),
            });

            // Quick recovery: dismiss panel, persist, then restart app + re-search
            // instead of long passive cooldown (more human-like, less suspicious)
            await device.shell('input keyevent 4').catch(() => {});
            await sleep(600);
            await persist(config, products, errors, startedAt, false);

            if (accessDeniedCount >= config.maxAccessDeniedRetries) {
              console.warn(`[access-denied #${accessDeniedCount}] max retries reached; stopping.`);
              break crawlLoop;
            }

            console.warn(`[access-denied #${accessDeniedCount}] Quick restart + cooldown ${Math.ceil(cooldownMs / 60_000)} min...`);
            // Soft restart (NEVER force-stop — triggers flash-crash detection)
            const { softRestart } = await import('./app-health.mjs');
            await softRestart(device, screen, { startupWaitMs: 8000 });
            await searchGoldenGoose(device, screen, config.query);
            await sleep(cooldownMs);
            consecutiveFailures = 0;

            // Refresh candidates after recovery
            const refreshed = (await readVisibleCandidates(device, config.query))
              .filter(c => !c.isLive && c.titleBounds.y >= 520 && !attemptedTitles.has(c.title));
            candidates.length = 0;
            Array.prototype.push.apply(candidates, refreshed);
            collectedThisScroll += 1;
            continue;
          } else {
            consecutiveFailures += 1;
            errors.push({ title: candidate.title, message: error.message, at: new Date().toISOString() });
            const safeName = `error-${String(errors.length).padStart(3, '0')}.png`;
            await captureDeviceScreenshot(device, path.join(config.diagnosticsDir, safeName)).catch(() => {});
            console.warn(`[skip] ${candidate.title}: ${error.message}`);
            // After 8 consecutive non-access-denied failures, press Back to escape and re-search
            if (consecutiveFailures >= 8) {
              console.warn('[recovery] 8 consecutive failures — returning to search...');
              for (let b = 0; b < 3; b++) { await device.shell('input keyevent 4').catch(() => {}); await sleep(500); }
              await bringDouyinMallToFront(device, screen);
              await searchGoldenGoose(device, screen, config.query);
              consecutiveFailures = 0;
            }
          }
        } finally {
          await returnToResults(device, config.query).catch(() => {});
          const { interProductCooldown } = await import('./app-health.mjs');
          await interProductCooldown();
        }
      }

      emptyScrolls = collectedThisScroll === 0 ? emptyScrolls + 1 : 0;
      const idleScrollThreshold = config.all ? 12 : 6;
      if (emptyScrolls >= idleScrollThreshold) {
        exhausted = true;
        break;
      }
      await scrollResults(device, screen);
    }

    const completed = config.all ? exhausted : collectedForLimit() >= config.limit;
    await persist(config, products, errors, startedAt, completed);
    return { products, errors, completed };
  } finally {
    await fridaCapture?.close().catch(() => {});
    await enricher?.close().catch(() => {});
    if (androidConnection) {
      await Promise.allSettled(androidConnection.devices.map((device) => device.close()));
    }
  }
}
