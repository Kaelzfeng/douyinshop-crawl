import path from 'node:path';

function readValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
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
  const mode = argv.includes('--shop') ? 'shop' : (argv.includes('--direct') ? 'direct' : 'crawler');

  // Extract product_id from a v.douyin.com share link if given
  const shopLink = readValue(argv, '--shop', null);

  const config = {
    // Common
    mode,
    query: readValue(argv, '--query', 'golden goose'),
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
    headed: argv.includes('--headed'),

    // Rate limiting (used by both modes)
    maxSharesPerWindow: positiveInteger(
      readValue(argv, '--max-shares-per-window', '8'),
      '--max-shares-per-window',
    ),
    shareWindowMs: positiveInteger(
      readValue(argv, '--share-window-minutes', '15'),
      '--share-window-minutes',
    ) * 60_000,
    accessDeniedCooldownMs: positiveInteger(
      readValue(argv, '--access-denied-cooldown-minutes', '15'),
      '--access-denied-cooldown-minutes',
    ) * 60_000,
    maxAccessDeniedRetries: positiveInteger(
      readValue(argv, '--max-access-denied-retries', '3'),
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
        readValue(argv, '--min-delay-ms', '3000'),
        '--min-delay-ms',
      ),
    } : {}),

    // Shop-crawl mode
    shopLink,
    ...(mode === 'shop' ? {
      shopMaxScrolls: positiveInteger(
        readValue(argv, '--max-scrolls', '30'),
        '--max-scrolls',
      ),
    } : {}),
  };

  return config;
}
