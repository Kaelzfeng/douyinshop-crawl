import path from 'node:path';

/** No product-category defaults — callers must pass --query / --queries / CRAWL_KEYWORDS. */
export const DEFAULT_QUERIES = [];

function readValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function hasValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1];
}

function parseQueries(value) {
  return String(value || '')
    .split(/[,，]/u)
    .map((query) => query.trim())
    .filter(Boolean);
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer.`);
  return number;
}

export function parseArgs(argv, cwd = process.cwd()) {
  const outputPath = path.resolve(cwd, readValue(argv, '--output', 'output/golden-goose-products.csv'));
  const all = argv.includes('--all');
  const hasMaxScrolls = argv.includes('--max-scrolls');
  // --shop-tab: search → 店铺 tab → crawl each shop
  // --shop: open one shop from a product link
  // --direct: resolve share links in browser
  // default: search-results crawler
  const mode = argv.includes('--shop-seeds')
    ? 'shop-seeds'
    : (argv.includes('--semi')
      ? 'semi'
      : (argv.includes('--frida')
        ? 'frida'
        : (argv.includes('--shop-tab')
          ? 'shop-tab'
          : (argv.includes('--shop') ? 'shop' : (argv.includes('--direct') ? 'direct' : 'crawler')))));
  const gentle = argv.includes('--gentle'); // opt-in to conservative old behavior

  // Extract product_id from a v.douyin.com share link if given
  const shopLink = readValue(argv, '--shop', null);
  const envQueries = process.env.CRAWL_KEYWORDS
    ? parseQueries(process.env.CRAWL_KEYWORDS)
    : (process.env.CRAWL_KEYWORD ? [process.env.CRAWL_KEYWORD] : []);
  const queries = hasValue(argv, '--query')
    ? [readValue(argv, '--query', '')].filter(Boolean)
    : (argv.includes('--queries')
      ? parseQueries(readValue(argv, '--queries', ''))
      : (envQueries.length ? envQueries : []));

  const config = {
    // Common
    mode,
    query: queries[0] || '',
    queries,
    serial: readValue(argv, '--serial', process.env.MUMU_SERIAL || '127.0.0.1:16384'),
    all,
    limit: all ? Number.POSITIVE_INFINITY : positiveInteger(readValue(argv, '--limit', '20'), '--limit'),
    maxScrolls: hasMaxScrolls
      ? positiveInteger(readValue(argv, '--max-scrolls'), '--max-scrolls')
      : (all ? Number.POSITIVE_INFINITY : 30),
    outputPath,
    checkpointPath: path.resolve(cwd, readValue(argv, '--checkpoint', 'data/checkpoint.json')),
    summaryPath: path.resolve(cwd, readValue(argv, '--summary', 'output/run-summary.json')),
    diagnosticsDir: path.resolve(cwd, readValue(argv, '--diagnostics', 'output/diagnostics')),
    fresh: argv.includes('--fresh'),
    skipSearch: argv.includes('--skip-search'),
    headed: argv.includes('--headed'),
    gentle,

    // Rate limiting (used by both modes)
    // Aggressive defaults: 20 shares per 10 min, 3 min cooldown, 6 retries
    // --gentle reverts to old conservative: 8 shares per 15 min, 15 min cooldown, 3 retries
    maxSharesPerWindow: positiveInteger(
      readValue(argv, '--max-shares-per-window', gentle ? '8' : '20'),
      '--max-shares-per-window',
    ),
    shareWindowMs: positiveInteger(
      readValue(argv, '--share-window-minutes', gentle ? '15' : '10'),
      '--share-window-minutes',
    ) * 60_000,
    accessDeniedCooldownMs: positiveInteger(
      readValue(argv, '--access-denied-cooldown-minutes', gentle ? '15' : '3'),
      '--access-denied-cooldown-minutes',
    ) * 60_000,
    maxAccessDeniedRetries: positiveInteger(
      readValue(argv, '--max-access-denied-retries', gentle ? '3' : '6'),
      '--max-access-denied-retries',
    ),

    // Anti-detection (used by both modes)
    stealth: !argv.includes('--no-stealth'),
    proxy: readValue(argv, '--proxy', null),

    // Direct-crawl mode
    inputPath: readValue(argv, '--input', null),
    ...(mode === 'direct' ? {
      concurrency: positiveInteger(
        readValue(argv, '--concurrency', '1'),
        '--concurrency',
      ),
      minDelayMs: positiveInteger(
        readValue(argv, '--min-delay-ms', gentle ? '3000' : '1200'),
        '--min-delay-ms',
      ),
    } : {}),

    // Shop-crawl mode (single shop from product link)
    shopLink,
    ...(mode === 'shop' ? {
      shopMaxScrolls: positiveInteger(
        readValue(argv, '--max-scrolls', '30'),
        '--max-scrolls',
      ),
    } : {}),

    // Shop-tab mode (search → 店铺 → each shop)
    ...(mode === 'shop-tab' ? {
      shopMaxScrolls: positiveInteger(
        readValue(argv, '--max-scrolls', '20'),
        '--max-scrolls',
      ),
    } : {}),

    // Shop-from-seeds mode (enter shops via known product links in CSV)
    ...(mode === 'shop-seeds' ? {
      seedsCsv: path.resolve(cwd, readValue(argv, '--seeds', 'output/all-products-final.csv')),
      maxShops: positiveInteger(readValue(argv, '--max-shops', '25'), '--max-shops'),
      onlyXiaozangShops: !argv.includes('--all-shops'),
      shopMaxScrolls: positiveInteger(
        readValue(argv, '--max-scrolls', '40'),
        '--max-scrolls',
      ),
    } : {}),
  };

  return config;
}
