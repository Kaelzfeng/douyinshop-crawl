/**
 * Standalone link crawler — scrapes Douyin product detail pages directly
 * from a list of v.douyin.com share links, bypassing the Android app phase.
 *
 * Uses isolated browser contexts with rotated fingerprints to evade detection.
 */

import fs from 'node:fs/promises';
import { createSharePageEnricher } from './enrich.mjs';
import { humanDelay } from './rate-limit.mjs';
import { loadCheckpoint, writeArtifacts } from './output.mjs';

/**
 * Parse links from a file (one per line, CSV, or JSON array).
 */
export async function readLinksFromFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');

  // Try JSON array first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => {
        if (typeof item === 'string') return /v\.douyin\.com/.test(item);
        if (item && typeof item === 'object') return /v\.douyin\.com/.test(item['分享的链接'] || item.url || '');
        return false;
      }).map((item) => (typeof item === 'string' ? item : (item['分享的链接'] || item.url)));
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.links)) {
      return parsed.links.filter((l) => typeof l === 'string' && /v\.douyin\.com/.test(l));
    }
  } catch {
    // Not JSON, fall through
  }

  // Try CSV (skip header, take last column or find douyin URL)
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const links = [];
  for (const line of lines) {
    const match = line.match(/https:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/);
    if (match) {
      links.push(match[0]);
    }
  }
  if (links.length > 0) return links;

  // Plain text: one link per line
  return lines
    .map((l) => l.trim())
    .filter((l) => /^https:\/\/v\.douyin\.com\//.test(l));
}

/**
 * Crawl a list of share links concurrently.
 *
 * @param {string[]} links — array of v.douyin.com share URLs
 * @param {object} options
 * @param {number}  options.concurrency — max parallel enrichments (default 1)
 * @param {number}  options.limit — max products to collect (default all)
 * @param {boolean} options.headless — run browser headless (default true)
 * @param {boolean} options.stealth — enable anti-detection (default true)
 * @param {object}  [options.proxy] — optional proxy { server: 'http://host:port' }
 * @param {number}  options.minDelayMs — minimum delay between requests per worker (default 3000)
 * @param {string}  options.outputPath — CSV output path
 * @param {string}  options.checkpointPath — checkpoint JSON path
 * @param {string}  options.summaryPath — run summary path
 * @param {boolean} options.fresh — ignore existing checkpoint (default false)
 * @returns {Promise<{ products: object[], errors: object[], completed: boolean }>}
 */
export async function crawlLinks(links, options = {}) {
  const {
    concurrency = 1,
    limit = links.length,
    headless = true,
    stealth = true,
    proxy = null,
    minDelayMs = 3000,
    outputPath = 'output/golden-goose-products.csv',
    checkpointPath = 'data/checkpoint.json',
    summaryPath = 'output/run-summary.json',
    fresh = false,
  } = options;

  const startedAt = new Date().toISOString();
  const products = fresh ? [] : await loadCheckpoint(checkpointPath);
  const errors = [];
  const seenLinks = new Set(products.map((p) => p['分享的链接']).filter(Boolean));
  const remaining = links.filter((l) => !seenLinks.has(l));
  const targetCount = Math.min(limit, remaining.length);
  const productKeys = new Set(products.map((p) => p.productId || p['分享的链接']));

  if (remaining.length === 0) {
    console.log('[direct-crawl] All links already in checkpoint. Nothing to do.');
    return { products, errors, completed: true };
  }

  console.log(`[direct-crawl] ${remaining.length} links queued, target ${targetCount} products, concurrency ${concurrency}`);
  const enricher = await createSharePageEnricher({ headless, stealth, proxy });

  let index = 0;
  let completed = false;

  try {
    /**
     * Process a single link: enrich, deduplicate, persist.
     */
    async function processOne(link) {
      const product = await enricher.enrich(link);
      const key = product.productId || product['分享的链接'];
      if (!productKeys.has(key)) {
        products.push(product);
        productKeys.add(key);
        const progress = products.length;
        console.log(`[${progress}/${targetCount}] ${product.商品品名} | ${product.价格} | ${product.销量}`);
        await writeArtifacts({
          products,
          outputPath,
          checkpointPath,
          summaryPath,
          summary: {
            query: 'direct-crawl',
            requested: targetCount,
            collected: products.length,
            completed: false,
            startedAt,
            updatedAt: new Date().toISOString(),
            errors,
          },
        });
      }
    }

    // Simple concurrency: process in waves of `concurrency` size
    while (index < remaining.length && products.length < targetCount) {
      const batch = [];
      const batchEnd = Math.min(index + concurrency, remaining.length);
      for (let i = index; i < batchEnd && products.length < targetCount; i++) {
        batch.push(remaining[i]);
        index++;
      }

      // Process batch concurrently
      const results = await Promise.allSettled(
        batch.map(async (link, batchIdx) => {
          // Stagger requests within the batch to avoid burst patterns
          if (batchIdx > 0) {
            const stagger = humanDelay(minDelayMs * 0.3);
            await new Promise((r) => setTimeout(r, stagger));
          }
          return processOne(link);
        }),
      );

      // Collect errors
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          const err = results[i].reason;
          errors.push({
            link: batch[i],
            message: err.message,
            at: new Date().toISOString(),
          });
          console.warn(`[skip] ${batch[i]}: ${err.message}`);
        }
      }

      // Delay between batches
      if (index < remaining.length && products.length < targetCount) {
        const delay = humanDelay(minDelayMs);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    completed = products.length >= targetCount;
    await writeArtifacts({
      products,
      outputPath,
      checkpointPath,
      summaryPath,
      summary: {
        query: 'direct-crawl',
        requested: targetCount,
        collected: products.length,
        completed,
        startedAt,
        updatedAt: new Date().toISOString(),
        errors,
      },
    });

    return { products, errors, completed };
  } finally {
    await enricher.close().catch(() => {});
  }
}

/**
 * Crawl links from a file. Convenience wrapper around crawlLinks().
 */
export async function crawlLinksFromFile(filePath, options = {}) {
  const links = await readLinksFromFile(filePath);
  if (links.length === 0) throw new Error(`No v.douyin.com links found in ${filePath}`);
  console.log(`[direct-crawl] Found ${links.length} link(s) in ${filePath}`);
  return crawlLinks(links, options);
}
