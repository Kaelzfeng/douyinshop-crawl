import { parseArgs } from './args.mjs';
import { runCrawler } from './crawler.mjs';
import { crawlLinks, readLinksFromFile } from './direct-crawl.mjs';
import { crawlShop } from './shop-crawler.mjs';
import { crawlShopTab } from './shop-tab-crawl.mjs';
import { runFridaCrawler } from './frida-crawl.mjs';
import { runSemiCrawler } from './semi-crawl.mjs';
import { crawlShopsFromSeeds } from './shop-from-seeds.mjs';
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
    '  npm start -- [--all] [--limit N] [--fresh] [--headed] [--gentle]',
    '',
    '  # Semi-reverse — open product + Frida product_id/goods_detail, NO share click (needs adb root)',
    '  npm start -- --semi [--query 小脏鞋] [--all] [--serial emulator-5554]',
    '',
    '  # Frida mode — light UI + Frida hooks; still taps share for short link',
    '  npm start -- --frida [--query 小脏鞋] [--all] [--gentle] [--serial emulator-5554]',
    '',
    '  # Shop-tab mode — search keyword → 店铺 tab → enter each shop → filter products',
    '  npm start -- --shop-tab [--query 小脏鞋] [--max-scrolls N] [--gentle] [--output path]',
    '',
    '  # Shop-from-seeds (path B) — enter shops via known products in CSV',
    '  npm start -- --shop-seeds [--seeds output/all-products-final.csv] [--max-shops 20]',
    '',
    '  # Shop crawl mode — given a product link, crawl the ENTIRE shop',
    '  npm start -- --shop <v.douyin.com-link> [--max-scrolls N] [--fresh]',
    '',
    '  # Direct link crawling mode — scrape v.douyin.com links from a file',
    '  npm start -- --direct --input <file-or-link> [--limit N] [--concurrency N]',
    '',
    'Anti-detection flags:',
    '  --stealth           Enable stealth mode (default: true)',
    '  --no-stealth        Disable stealth / anti-fingerprinting',
    '  --proxy <url>       Use proxy server (e.g. http://host:port)',
    '  --gentle            Use conservative rate limits (old behavior)',
    '',
    'Rate limits (aggressive defaults; use --gentle for conservative):',
    '  --max-shares-per-window N       Shares per window (default: 20, gentle: 8)',
    '  --share-window-minutes N        Window in minutes (default: 10, gentle: 15)',
    '  --access-denied-cooldown-minutes N  Cooldown after denial (default: 3, gentle: 15)',
    '  --max-access-denied-retries N   Max denial retries (default: 6, gentle: 3)',
    '',
    'Examples:',
    '  # Full aggressive crawl (all products for both keywords)',
    '  npm start -- --all --fresh',
    '',
    '  # Conservative crawl (old safe behavior)',
    '  npm start -- --all --gentle',
    '',
    '  # Single keyword, limited count',
    '  npm start -- --query ggdb --limit 50 --fresh',
    '',
    '  # Frida crawl 小脏鞋 (adb root + frida-server as root first)',
    '  npm start -- --frida --query 小脏鞋 --all --gentle --serial emulator-5554 --output output/frida-xiaozangxie.csv',
    '',
    '  # Shop-tab: 小脏鞋 only (default for --shop-tab; ggdb already covered)',
    '  npm start -- --shop-tab --query 小脏鞋 --gentle --serial emulator-5554 --output output/shop-tab-xiaozangxie.csv',
    '',
    '  # Crawl entire shop from one product link',
    '  npm start -- --shop "https://v.douyin.com/viCdgejRd7s/"',
    '',
    '  # Crawl links from file',
    '  npm start -- --direct --input links.txt --limit 50',
    '',
  ].join('\n'));
}

try {
  const config = parseArgs(process.argv.slice(2));

  if (config.mode === 'shop-seeds') {
    const keyword = process.env.CRAWL_KEYWORD || config.query || '\u5c0f\u810f\u978b';
    const outputPath = config.outputPath.includes('golden-goose-products.csv')
      ? 'output/shop-from-seeds-xiaozangxie.csv'
      : config.outputPath;
    const checkpointPath = config.checkpointPath.includes('checkpoint.json')
      ? 'data/shop-from-seeds-checkpoint.json'
      : config.checkpointPath;
    const summaryPath = config.summaryPath.includes('run-summary.json')
      ? 'output/shop-from-seeds-summary.json'
      : config.summaryPath;

    console.log('[cli] Shop-from-seeds mode (path B: enter shop via known product)');
    console.log(`[cli] Keyword filter: ${keyword}`);
    console.log(`[cli] Seeds: ${config.seedsCsv}`);
    console.log(`[cli] Max shops: ${config.maxShops}`);
    console.log(`[cli] Serial: ${config.serial}`);
    console.log(`[cli] Output: ${outputPath}`);

    const result = await crawlShopsFromSeeds({
      ...config,
      keyword,
      outputPath,
      checkpointPath,
      summaryPath,
    });

    console.log(JSON.stringify({
      mode: 'shop-seeds',
      completed: result.completed,
      collected: result.products.length,
      shopsDone: result.shopsDone,
      shopsTotal: result.shopsTotal,
      errors: result.errors.length,
      output: outputPath,
    }, null, 2));

    if (!result.completed) process.exitCode = 2;
  } else if (config.mode === 'semi') {
    const keywords = (config.queries?.length ? config.queries : ['\u5c0f\u810f\u978b', 'ggdb'])
      .map((q) => String(q || '').trim())
      .filter(Boolean);
    const outputPath = config.outputPath.includes('golden-goose-products.csv')
      ? 'output/semi-xiaozangxie-ggdb.csv'
      : config.outputPath;
    const checkpointPath = config.checkpointPath.includes('checkpoint.json')
      ? 'data/semi-xiaozangxie-ggdb-checkpoint.json'
      : config.checkpointPath;
    const summaryPath = config.summaryPath.includes('run-summary.json')
      ? 'output/semi-xiaozangxie-ggdb-summary.json'
      : config.summaryPath;

    console.log('[cli] Semi-reverse crawl mode (NO share button)');
    console.log(`[cli] Keywords: ${keywords.join(' + ')}`);
    console.log(`[cli] Serial: ${config.serial}`);
    console.log(`[cli] Output: ${outputPath}`);
    console.log('[cli] Require: adb root + frida-server as root');

    let lastResult = null;
    const allErrors = [];
    for (let i = 0; i < keywords.length; i++) {
      const keyword = keywords[i];
      console.log(`\n[cli] === Semi query ${i + 1}/${keywords.length}: ${keyword} ===`);
      lastResult = await runSemiCrawler({
        ...config,
        query: keyword,
        fresh: config.fresh && i === 0,
        outputPath,
        checkpointPath,
        summaryPath,
      });
      allErrors.push(...(lastResult.errors || []));
    }

    console.log(JSON.stringify({
      mode: 'semi',
      noShareClick: true,
      completed: Boolean(lastResult?.completed),
      collected: lastResult?.products?.length ?? 0,
      errors: allErrors.length,
      keywords,
      output: outputPath,
    }, null, 2));

    if (!lastResult?.completed) process.exitCode = 2;
  } else if (config.mode === 'frida') {
    // Default: 小脏鞋 + ggdb. Override via --query / --queries / CRAWL_KEYWORDS
    const keywords = (config.queries?.length ? config.queries : ['小脏鞋', 'ggdb'])
      .map((q) => String(q || '').trim())
      .filter(Boolean);
    const outputPath = config.outputPath.includes('golden-goose-products.csv')
      ? 'output/frida-xiaozangxie-ggdb.csv'
      : config.outputPath;
    const checkpointPath = config.checkpointPath.includes('checkpoint.json')
      ? 'data/frida-xiaozangxie-ggdb-checkpoint.json'
      : config.checkpointPath;
    const summaryPath = config.summaryPath.includes('run-summary.json')
      ? 'output/frida-xiaozangxie-ggdb-summary.json'
      : config.summaryPath;

    console.log('[cli] Frida crawl mode');
    console.log(`[cli] Keywords: ${keywords.join(' + ')}`);
    console.log(`[cli] Serial: ${config.serial}`);
    console.log(`[cli] Output: ${outputPath}`);
    console.log(`[cli] Gentle: ${config.gentle ? 'ON' : 'OFF'}`);
    console.log('[cli] Require: adb root + frida-server as root');

    const allErrors = [];
    let lastResult = null;

    for (let i = 0; i < keywords.length; i++) {
      const keyword = keywords[i];
      console.log(`\n[cli] === Query ${i + 1}/${keywords.length}: ${keyword} ===`);
      lastResult = await runFridaCrawler({
        ...config,
        query: keyword,
        // First keyword respects --fresh; later keywords append into same files
        fresh: config.fresh && i === 0,
        outputPath,
        checkpointPath,
        summaryPath,
      });
      allErrors.push(...(lastResult.errors || []));
      if (!lastResult.completed && i < keywords.length - 1) {
        console.warn(`[cli] query "${keyword}" incomplete — still continuing next keyword`);
      }
    }

    // lastResult.products already includes prior keywords (shared checkpoint)
    console.log(JSON.stringify({
      completed: Boolean(lastResult?.completed),
      collected: lastResult?.products?.length ?? 0,
      errors: allErrors.length,
      keywords,
      output: outputPath,
    }, null, 2));

    if (!lastResult?.completed) process.exitCode = 2;
  } else if (config.mode === 'shop-tab') {
    // ---- Shop-tab mode: search → 店铺 → each shop ----
    const keyword = config.query || '小脏鞋';
    const outputPath = config.outputPath.includes('golden-goose-products.csv')
      ? `output/shop-tab-${keyword === '小脏鞋' ? 'xiaozangxie' : keyword}.csv`
      : config.outputPath;

    console.log('[cli] Shop-tab crawl mode');
    console.log(`[cli] Keyword: ${keyword}`);
    console.log(`[cli] Serial: ${config.serial}`);
    console.log(`[cli] Output: ${outputPath}`);
    console.log(`[cli] Gentle: ${config.gentle ? 'ON' : 'OFF'}`);

    const products = await crawlShopTab({
      serial: config.serial,
      keyword,
      outputPath,
      checkpointPath: config.checkpointPath,
      summaryPath: config.summaryPath,
      maxScrolls: config.shopMaxScrolls || config.maxScrolls || 20,
      fresh: config.fresh,
      gentle: config.gentle,
    });

    console.log(JSON.stringify({
      completed: true,
      collected: products?.length ?? 0,
      keyword,
      output: outputPath,
    }, null, 2));
  } else if (config.mode === 'shop') {
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
    console.log(`[cli] Search queries: ${config.queries.join(', ')}`);

    let result;
    const allProducts = [];
    const allErrors = [];
    for (let index = 0; index < config.queries.length; index += 1) {
      const query = config.queries[index];
      console.log(`[cli] Query ${index + 1}/${config.queries.length}: ${query}`);
      result = await runCrawler({
        ...config,
        query,
        fresh: config.fresh && index === 0,
        limitPerQuery: config.queries.length > 1,
      });
      allProducts.push(...result.products);
      allErrors.push(...result.errors);
      if (!result.completed) break;
    }

    console.log(JSON.stringify({
      completed: result?.completed ?? false,
      collected: result?.products.length ?? allProducts.length,
      errors: allErrors.length,
      output: config.outputPath,
    }, null, 2));

    if (!result.completed) process.exitCode = 2;
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
