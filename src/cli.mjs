import { parseArgs } from './args.mjs';
import { runCrawler } from './crawler.mjs';
import { crawlLinks, readLinksFromFile } from './direct-crawl.mjs';
import { crawlShop } from './shop-crawler.mjs';
import { chromium } from 'playwright';

/**
 * Resolve a v.douyin.com short link to extract the product_id.
 */
async function resolveProductId(shareLink) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
      viewport: { width: 430, height: 932 },
      locale: 'zh-CN',
    });
    const page = await ctx.newPage();
    await page.goto(shareLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('body').waitFor({ state: 'visible', timeout: 10_000 });
    const url = page.url();
    const u = new URL(url);
    const productId = u.searchParams.get('id') || u.searchParams.get('product_id');
    if (!productId) throw new Error('Could not extract product_id from resolved URL');
    return productId;
  } finally {
    await browser.close().catch(() => {});
  }
}

function printUsage() {
  console.error([
    '',
    'Usage:',
    '  # Android crawler mode (default) — search & collect from MuMu emulator',
    '  npm start -- [--all] [--limit N] [--fresh] [--headed]',
    '',
    '  # Shop crawl mode — given a product link, crawl the ENTIRE shop',
    '  npm start -- --shop <v.douyin.com-link> [--max-scrolls N] [--fresh]',
    '',
    '  # Direct link crawling mode — scrape v.douyin.com links from a file',
    '  npm start -- --direct --input <file-or-link> [--limit N] [--concurrency N]',
    '',
    'Anti-detection flags:',
    '  --stealth           Enable stealth mode (default: true, applies to direct mode)',
    '  --no-stealth        Disable stealth / anti-fingerprinting',
    '  --proxy <url>       Use proxy server (e.g. http://host:port)',
    '',
    'Examples:',
    '  # Crawl entire Golden Goose shop from one product link',
    '  npm start -- --shop "https://v.douyin.com/viCdgejRd7s/"',
    '',
    '  # Crawl links from file',
    '  npm start -- --direct --input links.txt --limit 50',
    '',
    '  # Original android crawler',
    '  npm start -- --all --fresh',
    '',
  ].join('\n'));
}

try {
  const config = parseArgs(process.argv.slice(2));

  if (config.mode === 'shop') {
    // ---- Shop crawl mode ----
    if (!config.shopLink) {
      console.error('Error: --shop requires a v.douyin.com product link.');
      printUsage();
      process.exit(1);
    }

    console.log(`[cli] Shop crawl mode`);
    console.log(`[cli] Product link: ${config.shopLink}`);

    const result = await crawlShop({
      productLink: config.shopLink,
      serial: config.serial,
      outputPath: config.outputPath,
      checkpointPath: config.checkpointPath,
      summaryPath: config.summaryPath,
      maxScrolls: config.shopMaxScrolls || 50,
      fresh: config.fresh,
    });

    console.log(JSON.stringify({
      completed: result.completed,
      collected: result.products.length,
      errors: result.errors.length,
      output: config.outputPath,
    }, null, 2));

    if (!result.completed) process.exitCode = 2;
  } else if (config.mode === 'direct') {
    // ---- Direct link crawling mode ----
    if (!config.inputPath) {
      console.error('Error: --direct mode requires --input <file-or-link>');
      printUsage();
      process.exit(1);
    }

    let links;
    if (/^https?:\/\//.test(config.inputPath)) {
      links = [config.inputPath];
    } else {
      links = await readLinksFromFile(config.inputPath);
    }

    if (links.length === 0) {
      console.error('Error: No v.douyin.com links found in input.');
      process.exit(1);
    }

    console.log(`[cli] Direct crawl mode: ${links.length} link(s) found`);
    console.log(`[cli] Stealth: ${config.stealth ? 'ON' : 'OFF'}, Concurrency: ${config.concurrency}`);

    const result = await crawlLinks(links, {
      concurrency: config.concurrency,
      limit: config.limit === Number.POSITIVE_INFINITY ? links.length : config.limit,
      headless: !config.headed,
      stealth: config.stealth,
      proxy: config.proxy ? { server: config.proxy } : null,
      minDelayMs: config.minDelayMs || 3000,
      outputPath: config.outputPath,
      checkpointPath: config.checkpointPath,
      summaryPath: config.summaryPath,
      fresh: config.fresh,
    });

    console.log(JSON.stringify({
      completed: result.completed,
      collected: result.products.length,
      errors: result.errors.length,
      output: config.outputPath,
    }, null, 2));

    if (!result.completed) process.exitCode = 2;
  } else {
    // ---- Android crawler mode (default) ----
    console.log('[cli] Android crawler mode');
    console.log(`[cli] Stealth (enrichment): ${config.stealth ? 'ON' : 'OFF'}`);

    const result = await runCrawler(config);

    console.log(JSON.stringify({
      completed: result.completed,
      collected: result.products.length,
      errors: result.errors.length,
      output: config.outputPath,
    }, null, 2));

    if (!result.completed) process.exitCode = 2;
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
