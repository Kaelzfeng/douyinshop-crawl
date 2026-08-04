#!/usr/bin/env node
/**
 * Direct Search CLI — generic Douyin Mall keyword crawler (API-level).
 *
 * No ADB input, no UI automation, no share-button clicking.
 * Uses Frida app-proxy for request signing inside the running app.
 *
 * Usage:
 *   npm start -- --keywords 运动鞋 --all
 *   npm start -- --query 帆布鞋 --max-pages 10
 *   npm start -- --keywords-file keywords.txt --all
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDirectSearchClient } from './direct-search-client.mjs';
import { SQLiteEventStore } from '../android-only-collector/sqlite-store.mjs';
import { makeEvent } from '../android-only-collector/events.mjs';
import { shortenProducts } from './official-shortener.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'output', 'direct-search');

function splitKeywords(value) {
  return String(value || '')
    .split(/[,，\n\r\t]+/u)
    .map((k) => k.trim())
    .filter(Boolean);
}

function loadKeywordsFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`keywords file not found: ${resolved}`);
  }
  return splitKeywords(fs.readFileSync(resolved, 'utf8'));
}

function resolveKeywords(values) {
  const fromFile = values['keywords-file']
    ? loadKeywordsFile(values['keywords-file'])
    : [];
  const fromList = splitKeywords(values.keywords);
  const fromQuery = splitKeywords(values.query);
  const fromEnv = splitKeywords(process.env.CRAWL_KEYWORDS || process.env.CRAWL_KEYWORD || '');

  // Prefer explicit CLI flags over env; merge unique while preserving order.
  const ordered = [];
  const seen = new Set();
  for (const keyword of [...fromFile, ...fromList, ...fromQuery, ...fromEnv]) {
    if (seen.has(keyword)) continue;
    seen.add(keyword);
    ordered.push(keyword);
  }
  return ordered;
}

function parseOptions(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      keywords: { type: 'string', default: '' },
      query: { type: 'string', default: '' },
      'keywords-file': { type: 'string', default: '' },
      all: { type: 'boolean', default: false },
      count: { type: 'string', default: '20' },
      'max-pages': { type: 'string', default: '50' },
      cursor: { type: 'string', default: '0' },
      db: { type: 'string', default: path.join(OUT_DIR, 'products.sqlite') },
      output: { type: 'string', default: path.join(OUT_DIR, 'products.csv') },
      'shorten-workers': { type: 'string', default: '3' },
      'shorten-delay-ms': { type: 'string', default: '500' },
      'no-shorten': { type: 'boolean', default: false },
      'single-page': { type: 'boolean', default: false },
      serial: { type: 'string', default: 'emulator-5554' },
      'sign-mode': { type: 'string', default: 'app_proxy' },
      session: { type: 'string', default: path.join(ROOT, 'output', 'session.json') },
      'device-params': { type: 'string', default: path.join(ROOT, 'output', 'device-params.json') },
      enrich: { type: 'boolean', default: false },
      'no-enrich': { type: 'boolean', default: false },
      'dump-wire': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const signMode = String(values['sign-mode'] || 'app_proxy').trim();
  if (!['app_proxy', 'frida_rpc', 'local'].includes(signMode)) {
    throw new Error(`--sign-mode must be app_proxy|frida_rpc|local (got ${signMode})`);
  }

  return {
    keywords: resolveKeywords(values),
    all: values.all,
    count: Math.max(1, Math.min(50, Number(values.count) || 20)),
    maxPages: Math.max(1, Number(values['max-pages']) || 50),
    cursor: values.cursor,
    dbPath: path.resolve(values.db),
    outputPath: path.resolve(values.output),
    shortenWorkers: Math.max(1, Number(values['shorten-workers']) || 3),
    shortenDelayMs: Math.max(0, Number(values['shorten-delay-ms']) || 500),
    noShorten: values['no-shorten'],
    singlePage: values['single-page'],
    serial: values.serial,
    signMode,
    sessionPath: path.resolve(values.session),
    deviceParamsPath: path.resolve(values['device-params']),
    enrich: values.enrich && !values['no-enrich'],
    dumpWire: values['dump-wire'],
    help: values.help,
  };
}

function helpText() {
  return `Douyin Mall generic keyword crawler (Direct Search API)

Usage:
  npm start -- --keywords <kw1,kw2> [options]
  npm start -- --query <keyword> [options]
  npm start -- --keywords-file <path> [options]

Keywords (required, pick at least one source):
  --keywords <kw1,kw2>    Comma-separated keywords
  --query <keyword>       Single keyword (repeatable via --keywords)
  --keywords-file <path>  One keyword per line (also accepts commas)
  env CRAWL_KEYWORDS      Fallback when no flag is set (comma-separated)
  env CRAWL_KEYWORD       Single-keyword fallback

Options:
  --all                   Paginate until has_more=false
  --count <n>             Products per page (default: 20, max: 50)
  --max-pages <n>         Maximum pages per keyword (default: 50)
  --cursor <value>        Starting cursor (default: 0)
  --db <path>             SQLite database path
  --output <path>         CSV output path
  --shorten-workers <n>   Shorten API concurrency (default: 3)
  --shorten-delay-ms <n>  Shorten API delay (default: 500)
  --no-shorten            Skip short link generation
  --single-page           Only fetch one page (for testing)
  --serial <id>           Frida device serial (default: emulator-5554)
  --sign-mode <mode>      app_proxy (default) | frida_rpc | local
  --session <path>        Session JSON from export-app-session (default: output/session.json)
  --device-params <path>  Device params JSON (default: output/device-params.json)
  --enrich                Backfill missing shop/sales via H5 pack (needs a_bogus/browser)
  --dump-wire             Save last wire/sign headers after first page
  -h, --help              Show this help

sign-mode:
  app_proxy  Frida makes HTTP inside the app (most reliable today)
  frida_rpc  Frida only signs; Node fetch (needs session cookies)
  local      Unidbg/MetaSec sidecar; no Frida (experimental)

No ADB UI automation. Requires MuMu + logged-in app for app_proxy/frida_rpc.
`;
}

function rowIsComplete(row) {
  return Boolean(
    String(row?.product_id || '').trim()
    && String(row?.product_name || '').trim()
    && String(row?.shop_name || '').trim()
    && String(row?.price || '').trim()
    && String(row?.price) !== '0'
    && String(row?.sales || '').trim()
    && String(row?.share_url || '').trim(),
  );
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function safePathPart(value) {
  return encodeURIComponent(String(value ?? '')) || '_';
}

function persistRawPage({ keyword, cursor, result }) {
  const rawBody = typeof result?.rawBody === 'string' ? result.rawBody : '';
  const rawDir = path.join(OUT_DIR, 'raw', safePathPart(keyword));
  fs.mkdirSync(rawDir, { recursive: true });

  const basePath = path.join(rawDir, `${safePathPart(cursor)}.json`);
  const finalPath = fs.existsSync(basePath)
    ? path.join(rawDir, `${safePathPart(cursor)}.${Date.now()}.json`)
    : basePath;
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  const envelope = {
    keyword,
    cursor: String(cursor),
    next_cursor: result?.nextCursor ? String(result.nextCursor) : '',
    has_more: Boolean(result?.hasMore),
    captured_at: new Date().toISOString(),
    http_status: result?.httpStatus ?? null,
    business_status: result?.businessStatus ?? null,
    status_msg: result?.statusMsg || '',
    raw_response: rawBody,
    parsed_documents: result?.rawResponse ?? null,
    parsed_products: result?.products ?? [],
  };

  fs.writeFileSync(tempPath, JSON.stringify(envelope), 'utf8');
  fs.renameSync(tempPath, finalPath);
  return finalPath;
}

function writeProductsCsv(filePath, rows) {
  const header = ['product_id', 'product_name', 'shop_name', 'price', 'sales', 'share_url'];
  const csv = [
    header.map(csvCell).join(','),
    ...rows.map((row) => header.map((key) => csvCell(row[key])).join(',')),
  ].join('\r\n') + '\r\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `\uFEFF${csv}`, 'utf8');
}

function missingFieldCounts(rows) {
  const fields = ['product_name', 'shop_name', 'price', 'sales', 'share_url'];
  return Object.fromEntries(fields.map((field) => [
    `missing_${field}`,
    rows.filter((row) => !String(row?.[field] || '').trim()).length,
  ]));
}

async function main() {
  const options = parseOptions();
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  if (!options.keywords.length) {
    console.error('Error: at least one keyword is required.');
    console.error('Use --keywords, --query, --keywords-file, or CRAWL_KEYWORDS.');
    console.error('');
    process.stdout.write(helpText());
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });

  const runId = `direct-search-${Date.now()}`;
  const store = new SQLiteEventStore({ dbPath: options.dbPath, runId });

  console.log('=== Douyin Mall Keyword Crawler (Direct Search) ===');
  console.log(`Keywords: ${options.keywords.join(', ')}`);
  console.log(`DB: ${options.dbPath}`);
  console.log(`Output: ${options.outputPath}`);
  console.log(`Sign mode: ${options.signMode}`);
  console.log(`Mode: ${options.singlePage ? 'single page' : (options.all ? 'all pages' : `${options.maxPages} pages max`)}`);

  let client;
  try {
    client = await createDirectSearchClient({
      serial: options.serial,
      signMode: options.signMode,
      useAppProxy: options.signMode === 'app_proxy',
      sessionPath: options.sessionPath,
      deviceParamsPath: options.deviceParamsPath,
    });
  } catch (err) {
    console.error('Failed to start client:', err.message);
    console.error('app_proxy/frida_rpc need Douyin Mall + Frida; local needs MetaSec sidecar.');
    process.exit(1);
  }

  const allStats = [];
  let grandTotal = 0;

  try {
    for (const keyword of options.keywords) {
      console.log(`\n--- Keyword: ${keyword} ---`);

      const seen = new Set();
      let cursor = options.cursor;
      let pages = 0;
      let keywordProducts = 0;

      const maxPages = options.singlePage ? 1 : options.maxPages;

      for (let page = 0; page < maxPages; page++) {
        const result = await client.searchPage({
          keyword,
          cursor,
          count: options.count,
        });
        pages += 1;

        // Persist the complete response before any product event can reach
        // SQLite. A failed atomic write aborts this page without committing it.
        const rawPath = persistRawPage({ keyword, cursor, result });

        let newInPage = 0;
        for (const product of result.products) {
          if (product.product_id && !seen.has(product.product_id)) {
            seen.add(product.product_id);
            keywordProducts += 1;

            // Record in SQLite
            store.record(makeEvent({
              run_id: runId,
              event: 'product_found',
              stage: 'search_response',
              source: 'direct_search_api',
              ts: Date.now(),
              product_id: product.product_id,
              product_name: product.product_name,
              title: product.product_name,
              shop_name: product.shop_name,
              price: product.price,
              sales: product.sales,
              url: `keyword=${keyword} cursor=${cursor}`,
              raw: {
                card: product.raw_card,
                sales_metadata: product.sales_metadata,
              },
            }));

            newInPage += 1;
          }
        }

        const statusLine = [
          `page=${pages}`,
          `cursor=${cursor}`,
          `nextCursor=${result.nextCursor}`,
          `hasMore=${result.hasMore}`,
          `httpStatus=${result.httpStatus}`,
          `bizStatus=${result.businessStatus}`,
          `products=${result.productsInPage}`,
          `new=${newInPage}`,
          `total=${keywordProducts}`,
          `elapsed=${result.elapsedMs}ms`,
          `mode=${result.signMode}`,
        ].join(' ');
        console.log(`  ${statusLine}`);

        if (options.dumpWire && pages === 1) {
          const wirePath = path.join(OUT_DIR, 'wire-headers-sample.json');
          const wire = result.lastWire || await client.getLastWire();
          fs.writeFileSync(wirePath, `${JSON.stringify(wire || {
            signed_headers: result.signedHeaders,
            note: 'no wire snapshot',
          }, null, 2)}\n`, 'utf8');
          console.log(`  wire dump: ${wirePath}`);
        }

        allStats.push({
          keyword,
          cursor,
          next_cursor: result.nextCursor,
          has_more: result.hasMore,
          http_status: result.httpStatus,
          business_status: result.businessStatus,
          response_bytes: result.responseBytes,
          products_in_page: result.productsInPage,
          new_products: newInPage,
          raw_path: rawPath,
          sign_mode: result.signMode,
          elapsed_ms: result.elapsedMs,
        });

        // Termination
        if (!result.hasMore || options.singlePage) break;
        if (!result.nextCursor || result.nextCursor === cursor) {
          console.log(`  Stopping: cursor stalled (${cursor} → ${result.nextCursor})`);
          break;
        }
        if (result.productsInPage === 0) {
          console.log('  Stopping: empty page');
          break;
        }

        cursor = result.nextCursor;
      }

      grandTotal += keywordProducts;
      console.log(`  ${keyword}: ${pages} pages, ${keywordProducts} unique products`);

      if (!options.all && !options.singlePage && pages >= maxPages) {
        console.log(`  Reached max-pages limit (${maxPages})`);
      }
    }
  } finally {
    await client.close();
  }

  // Optional H5 pack enrich for missing shop/sales (Phase B; needs browser a_bogus)
  let enrichStats = null;
  if (options.enrich && grandTotal > 0) {
    console.log('\n--- H5 Field Enrichment ---');
    try {
      const { createABogusSigner } = await import('./a-bogus.mjs');
      const { fetchH5Detail } = await import('./direct-api-enrich.mjs');
      const incomplete = store.all(`
        SELECT product_id, product_name, shop_name, price, sales
        FROM products
        WHERE trim(product_id) <> ''
          AND (trim(coalesce(shop_name,'')) = '' OR trim(coalesce(sales,'')) = '')
        LIMIT 50
      `);
      console.log(`Incomplete rows to enrich (max 50): ${incomplete.length}`);
      if (incomplete.length) {
        const signer = await createABogusSigner();
        let filled = 0;
        try {
          for (const row of incomplete) {
            try {
              const detail = await fetchH5Detail(row.product_id, signer);
              if (!detail) continue;
              const shop = detail['店铺名'] || detail.shop_name || '';
              const sales = detail['销量'] || detail.sales || '';
              const name = detail['商品品名'] || detail.product_name || detail.title || '';
              const price = detail['价格'] || detail.price || '';
              if (shop || sales || name || price) {
                store.record(makeEvent({
                  run_id: runId,
                  event: 'product_found',
                  stage: 'h5_enrich',
                  source: 'h5_pack',
                  ts: Date.now(),
                  product_id: row.product_id,
                  product_name: name || row.product_name,
                  title: name || row.product_name,
                  shop_name: shop || row.shop_name,
                  price: price || row.price,
                  sales: sales || row.sales,
                }));
                filled += 1;
              }
            } catch (err) {
              console.warn(`  enrich fail ${row.product_id}: ${err.message}`);
            }
          }
        } finally {
          await signer.close().catch(() => {});
        }
        enrichStats = { attempted: incomplete.length, filled };
        console.log(`Enriched: ${filled}/${incomplete.length}`);
      }
    } catch (err) {
      console.warn(`[enrich] skipped: ${err.message}`);
      enrichStats = { error: String(err.message || err) };
    }
  }

  // Short link generation
  let shortenStats = null;
  if (!options.noShorten && grandTotal > 0) {
    console.log(`\n--- Short Link Generation ---`);
    const productIds = store.all(`
      SELECT product_id FROM products WHERE trim(product_id) <> ''
      ORDER BY first_seen_ts
    `).map(r => String(r.product_id));

    const unlinked = productIds.filter(pid => {
      const existing = store.all(
        'SELECT share_url FROM product_shares WHERE product_id = ?',
        pid,
      );
      return existing.length === 0;
    });

    console.log(`Total products: ${productIds.length}, Unlinked: ${unlinked.length}`);

    if (unlinked.length > 0) {
      shortenStats = await shortenProducts({
        dbPath: options.dbPath,
        productIds: unlinked,
        workers: options.shortenWorkers,
        delayMs: options.shortenDelayMs,
        onProgress: (progress) => {
          if (progress.status === 'linked' || progress.status === 'failed') {
            console.log(`  shorten ${progress.status}: ${progress.product_id} (${progress.linked}/${unlinked.length})`);
          }
        },
      });
    }
  }

  // CSV export
  console.log(`\n--- CSV Export ---`);
  const rows = store.all(`
    SELECT p.product_id,
      COALESCE(NULLIF(p.product_name, ''), p.title) AS product_name,
      p.shop_name,
      COALESCE(NULLIF(p.price, ''), NULLIF(p.min_price, ''), p.max_price) AS price,
      p.sales,
      ps.share_url
    FROM products p
    LEFT JOIN product_shares ps ON ps.product_id = p.product_id
    ORDER BY p.first_seen_ts
  `);

  const completeRows = rows.filter(rowIsComplete);
  const completeOutputPath = path.join(path.dirname(options.outputPath), 'products.complete.csv');
  writeProductsCsv(options.outputPath, rows);
  writeProductsCsv(completeOutputPath, completeRows);
  const missing = missingFieldCounts(rows);
  console.log(`CSV rows: ${rows.length} total, ${completeRows.length} complete`);
  console.log(`Saved to: ${options.outputPath}`);
  console.log(`Saved complete rows to: ${completeOutputPath}`);

  // Summary
  const summary = {
    mode: 'direct-search-api',
    sign_mode: options.signMode,
    keywords: options.keywords,
    pages_total: allStats.length,
    unique_products: rows.length,
    total_products: rows.length,
    complete_rows: completeRows.length,
    incomplete_rows: rows.length - completeRows.length,
    complete_csv_rows: completeRows.length,
    ...missing,
    enrich: enrichStats,
    shorten: shortenStats,
    db: options.dbPath,
    output: options.outputPath,
    complete_output: completeOutputPath,
    raw_output: path.join(OUT_DIR, 'raw'),
    finished_at: new Date().toISOString(),
    stats: allStats,
  };
  const summaryPath = path.join(OUT_DIR, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`\n=== DONE ===`);
  console.log(`Unique products: ${rows.length}`);
  console.log(`CSV rows: ${rows.length}`);
  console.log(`CSV rows (complete): ${completeRows.length}`);
  console.log(`Summary: ${summaryPath}`);

  store.close();
  process.exitCode = grandTotal > 0 ? 0 : 2;
}

main().catch((err) => {
  console.error('[direct-search-cli]', err.stack || err);
  process.exitCode = 1;
});
