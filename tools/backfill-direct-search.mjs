#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { parseSearchResponse } from '../src/direct-search-client.mjs';
import { SQLiteEventStore } from '../android-only-collector/sqlite-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB = path.join(ROOT, 'output', 'direct-search', 'products.sqlite');
const DEFAULT_RAW_DIR = path.join(ROOT, 'output', 'direct-search', 'raw');
const LEGACY_RAW_FILES = [
  path.join(ROOT, 'output', 'direct-search', 'debug-raw.txt'),
  path.join(ROOT, 'output', 'direct-search', 'raw-response.txt'),
  path.join(ROOT, 'output', 'direct-search', 'dechunked-response.json'),
  path.join(ROOT, 'output', 'direct-search', 'response-sample.json'),
];

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function walkJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkJsonFiles(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) result.push(fullPath);
  }
  return result;
}

function mergeProduct(map, product, source) {
  const productId = text(product?.product_id);
  if (!productId) return;
  const current = map.get(productId) || {
    product_id: productId,
    product_name: '',
    shop_name: '',
    price: '',
    sales: '',
    sales_metadata: { shop: null, candidates: [] },
    sources: [],
  };
  for (const field of ['product_name', 'shop_name', 'price', 'sales']) {
    if (!current[field] && text(product?.[field])) current[field] = text(product[field]);
  }
  const metadata = product?.sales_metadata || {};
  if (!current.sales_metadata.shop && metadata.shop) current.sales_metadata.shop = metadata.shop;
  if (Array.isArray(metadata.candidates)) {
    current.sales_metadata.candidates.push(...metadata.candidates);
  }
  if (!current.sources.includes(source)) current.sources.push(source);
  map.set(productId, current);
}

function extractJsonDocuments(source) {
  const documents = [];
  let position = 0;
  while (position < source.length) {
    while (/\s/.test(source[position] || '')) position += 1;
    if (position >= source.length) break;
    const start = source.indexOf('{', position);
    if (start < 0) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) break;
    try {
      documents.push(JSON.parse(source.slice(start, end)));
    } catch {
      // Ignore a false opening brace and continue with the next one.
    }
    position = end;
  }
  return documents;
}

function parseRawText(raw, source, candidates, report) {
  const body = raw === null || raw === undefined ? '' : String(raw);
  if (!body) return;
  try {
    const parsed = parseSearchResponse(body, '0');
    report.parsed_sources += 1;
    report.parsed_products += parsed.products.length;
    if (parsed.parseError) report.parse_errors.push({ source, error: parsed.parseError });
    for (const product of parsed.products) mergeProduct(candidates, product, source);

    if (parsed.parseError || !parsed.products.length) {
      const documents = extractJsonDocuments(body);
      for (const [index, document] of documents.entries()) {
        const nested = parseSearchResponse(JSON.stringify(document), '0');
        report.parsed_products += nested.products.length;
        for (const product of nested.products) {
          mergeProduct(candidates, product, `${source}#document-${index}`);
        }
      }
    }
  } catch (error) {
    report.parse_errors.push({ source, error: String(error?.message || error) });
  }
}

function collectCandidates({ rawDir = DEFAULT_RAW_DIR, legacyFiles = LEGACY_RAW_FILES } = {}) {
  const candidates = new Map();
  const report = {
    files_seen: 0,
    parsed_sources: 0,
    parsed_products: 0,
    parse_errors: [],
    shop_sales_candidates: [],
  };
  const files = [...walkJsonFiles(rawDir), ...legacyFiles.filter((file) => fs.existsSync(file))];
  for (const file of files) {
    report.files_seen += 1;
    const source = path.relative(ROOT, file);
    const contents = fs.readFileSync(file, 'utf8');
    if (file.toLowerCase().endsWith('.json')) {
      try {
        const value = JSON.parse(contents);
        if (value && typeof value === 'object' && typeof value.raw_response === 'string') {
          parseRawText(value.raw_response, source, candidates, report);
          for (const product of value.parsed_products || []) mergeProduct(candidates, product, source);
        } else {
          parseRawText(contents, source, candidates, report);
        }
      } catch {
        parseRawText(contents, source, candidates, report);
      }
    } else {
      parseRawText(contents, source, candidates, report);
    }
  }

  for (const product of candidates.values()) {
    if (product.sales_metadata.shop) {
      report.shop_sales_candidates.push({
        product_id: product.product_id,
        candidate: product.sales_metadata.shop,
        sources: product.sources,
      });
    }
  }
  return { candidates: [...candidates.values()], report };
}

function sqliteSnapshot(dbPath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const snapshotPath = path.join(backupDir, `products-${stamp}.sqlite`);
  const db = new DatabaseSync(dbPath);
  try {
    const escaped = snapshotPath.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
  return snapshotPath;
}

function tableCounts(store) {
  return {
    products: Number(store.all('SELECT COUNT(*) AS count FROM products')[0]?.count || 0),
    shares: Number(store.all('SELECT COUNT(*) AS count FROM shares')[0]?.count || 0),
    product_shares: Number(store.all('SELECT COUNT(*) AS count FROM product_shares')[0]?.count || 0),
  };
}

export function runOfflineBackfill({
  dbPath = DEFAULT_DB,
  rawDir = DEFAULT_RAW_DIR,
  backupDir = path.join(path.dirname(dbPath), 'backups'),
  reportPath = path.join(path.dirname(dbPath), 'backfill-report.json'),
} = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite database not found: ${dbPath}`);
  const { candidates, report: collectReport } = collectCandidates({ rawDir });
  const snapshotPath = sqliteSnapshot(dbPath, backupDir);
  const store = new SQLiteEventStore({ dbPath, runId: `offline-backfill-${Date.now()}` });
  const before = tableCounts(store);
  const result = store.backfillProducts(candidates);
  const after = tableCounts(store);
  store.close();

  if (before.products !== after.products
      || before.shares !== after.shares
      || before.product_shares !== after.product_shares) {
    throw new Error(`SQLite count invariant failed: ${JSON.stringify({ before, after })}`);
  }

  const output = {
    mode: 'offline-direct-search-backfill',
    generated_at: new Date().toISOString(),
    db: dbPath,
    snapshot: snapshotPath,
    raw_dir: rawDir,
    counts_before: before,
    counts_after: after,
    candidates: candidates.length,
    updated: result,
    collection: collectReport,
    recovered_products: candidates
      .filter((candidate) => candidate.sales || candidate.shop_name)
      .map((candidate) => ({
        product_id: candidate.product_id,
        fields: {
          product_name: candidate.product_name,
          shop_name: candidate.shop_name,
          price: candidate.price,
          sales: candidate.sales,
        },
        sources: candidate.sources,
      })),
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(output, null, 2), 'utf8');
  return output;
}

function parseOptions(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      'raw-dir': { type: 'string', default: DEFAULT_RAW_DIR },
      'backup-dir': { type: 'string' },
      report: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  return values;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const dbPath = path.resolve(options.db);
  const output = runOfflineBackfill({
    dbPath,
    rawDir: path.resolve(options['raw-dir']),
    backupDir: options['backup-dir'] ? path.resolve(options['backup-dir']) : undefined,
    reportPath: options.report ? path.resolve(options.report) : undefined,
  });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[direct-search-backfill] ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
