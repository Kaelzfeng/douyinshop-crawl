import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AccessDeniedError,
  bringDouyinMallToFront,
  captureDeviceScreenshot,
  connectMuMu,
  copyCurrentProductShareLink,
  getScreenSize,
  openCandidate,
  readVisibleCandidates,
  returnToResults,
  scrollResults,
  searchGoldenGoose,
} from './android.mjs';
import { readCurrentDouyinShareUrl, waitForDouyinShareUrl } from './clipboard.mjs';
import { createSharePageEnricher } from './enrich.mjs';
import { loadCheckpoint, writeArtifacts } from './output.mjs';
import { accessDeniedBackoff, createShareRateLimiter } from './rate-limit.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function productKey(product) {
  return product.productId || product.分享的链接 || product.商品品名;
}

async function persist(config, products, errors, startedAt, completed = false) {
  await writeArtifacts({
    products,
    outputPath: config.outputPath,
    checkpointPath: config.checkpointPath,
    summaryPath: config.summaryPath,
    summary: {
      query: 'golden goose',
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
  const errors = [];
  const attemptedTitles = new Set(products.map((product) => product.商品品名).filter(Boolean));
  const productKeys = new Set(products.map(productKey));
  let androidConnection;
  let enricher;

  await fs.mkdir(config.diagnosticsDir, { recursive: true });

  try {
    androidConnection = await connectMuMu(config.serial);
    const { device } = androidConnection;
    const screen = await getScreenSize(device);
    await bringDouyinMallToFront(device, screen);
    await searchGoldenGoose(device, screen, config.query);
    await captureDeviceScreenshot(device, path.join(config.diagnosticsDir, 'search-results.png'));

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

    crawlLoop: for (
      let scrollIndex = 0;
      scrollIndex < config.maxScrolls && (config.all || products.length < config.limit);
      scrollIndex += 1
    ) {
      const candidates = (await readVisibleCandidates(device))
        .filter((candidate) => (
          !candidate.isLive
          && candidate.titleBounds.y >= 520
          && !attemptedTitles.has(candidate.title)
        ));
      let collectedThisScroll = 0;
      let restartAfterCooldown = false;

      for (const candidate of candidates) {
        if (products.length >= config.limit) break;
        attemptedTitles.add(candidate.title);

        try {
          const previousShareUrl = await readCurrentDouyinShareUrl();
          await openCandidate(device, candidate);
          await shareRateLimiter.waitForSlot();
          shareRateLimiter.recordAction();
          const share = await copyCurrentProductShareLink(
            device,
            screen,
            () => waitForDouyinShareUrl({ previousUrl: previousShareUrl }),
          );
          const product = await enricher.enrich(share.url);
          if (!product.商品品名.toLowerCase().replace(/[^a-z]/g, '').includes('goldengoose')) {
            throw new Error(`Resolved product is outside Golden Goose scope: ${product.商品品名}`);
          }
          const key = productKey(product);
          if (!productKeys.has(key)) {
            products.push(product);
            productKeys.add(key);
            collectedThisScroll += 1;
          const target = config.all ? '全部' : config.limit;
          console.log(`[${products.length}/${target}] ${product.商品品名} | ${product.价格} | ${product.销量}`);
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

            // Access-denied is the strongest risk signal. Persist immediately, back out of
            // the share sheet, then either stop safely or cool down before continuing.
            await device.shell('input keyevent 4').catch(() => {});
            await sleep(600);
            await persist(config, products, errors, startedAt, false);

            if (accessDeniedCount >= config.maxAccessDeniedRetries) {
              console.warn(`[access-denied #${accessDeniedCount}] ${candidate.title} ? max retries reached; stopping to avoid a long cooldown/ban.`);
              break crawlLoop;
            }

            console.warn(`[access-denied #${accessDeniedCount}] ${candidate.title} ? cooling down ${Math.ceil(cooldownMs / 60_000)} minute(s) before continuing.`);
            await sleep(cooldownMs);

            // Refresh the visible candidates after cooldown; scroll position may have shifted.
            const refreshed = (await readVisibleCandidates(device))
              .filter(c => !c.isLive && c.titleBounds.y >= 520 && !attemptedTitles.has(c.title));
            candidates.length = 0;
            Array.prototype.push.apply(candidates, refreshed);
            collectedThisScroll += 1;
            continue;
          } else {
            errors.push({ title: candidate.title, message: error.message, at: new Date().toISOString() });
            const safeName = `error-${String(errors.length).padStart(3, '0')}.png`;
            await captureDeviceScreenshot(device, path.join(config.diagnosticsDir, safeName)).catch(() => {});
            console.warn(`[skip] ${candidate.title}: ${error.message}`);
          }
        } finally {
          await returnToResults(device).catch(() => {});
        }
      }

      emptyScrolls = collectedThisScroll === 0 ? emptyScrolls + 1 : 0;
      const idleScrollThreshold = config.all ? 8 : 4;
      if (emptyScrolls >= idleScrollThreshold) {
        exhausted = true;
        break;
      }
      await scrollResults(device, screen);
    }

    const completed = config.all ? exhausted : products.length >= config.limit;
    await persist(config, products, errors, startedAt, completed);
    return { products, errors, completed };
  } finally {
    await enricher?.close().catch(() => {});
    if (androidConnection) {
      await Promise.allSettled(androidConnection.devices.map((device) => device.close()));
    }
  }
}
