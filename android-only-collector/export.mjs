#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

function parseOptions(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: 'output/android-only.sqlite' },
      output: { type: 'string', default: 'products.csv' },
      'complete-only': { type: 'boolean', default: false },
      'complete-output': { type: 'string' },
      summary: { type: 'string' },
      keywords: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  return values;
}

function helpText() {
  return `Export Android collector SQLite to CSV

Usage:
  node android-only-collector/export.mjs [options]

Options:
  --db <path>       SQLite input (default: output/android-only.sqlite)
  --output <path>   CSV output (default: products.csv)
  --complete-only   Export only rows with all six final fields
  --complete-output <path>  Also write a complete-only CSV
  --summary <path>  Write field completeness summary JSON
  --keywords <list> Comma-separated literal title keywords
  --limit <count>   Maximum exported rows
  -h, --help        Show this help
`;
}

function tableExists(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function normalizeMatchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .toLowerCase();
}

function titleMatchesKeywords(title, keywords) {
  if (!keywords?.length) return true;
  const normalized = normalizeMatchText(title);
  const compact = normalized.replace(/\s+/g, '');
  return keywords.some((keyword) => {
    const target = normalizeMatchText(keyword);
    return target === 'ggdb' ? compact.includes('ggdb') : normalized.includes(target);
  });
}

function rowIsComplete(row) {
  return [
    row.product_id,
    row.product_name,
    row.shop_name,
    row.price,
    row.sales,
    row.share_url,
  ].every((value) => String(value || '').trim() && String(value) !== '0');
}

function missingFieldCounts(rows) {
  const fields = ['product_name', 'shop_name', 'price', 'sales', 'share_url'];
  return Object.fromEntries(fields.map((field) => [
    `missing_${field}`,
    rows.filter((row) => !String(row?.[field] || '').trim()).length,
  ]));
}

function exportProducts({ dbPath, outputPath, completeOnly = false, keywords = [], limit }) {
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite database not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  try {
    if (!tableExists(db, 'products')) throw new Error('SQLite table products not found');
    const productColumns = columnsOf(db, 'products');
    const hasLinks = tableExists(db, 'product_shares') && tableExists(db, 'shares');
    const nullableColumn = (name) => productColumns.has(name) ? `NULLIF(p.${name}, '')` : 'NULL';
    const productName = `COALESCE(${nullableColumn('product_name')}, ${nullableColumn('title')}, '')`;
    const price = `COALESCE(${nullableColumn('price')}, ${nullableColumn('min_price')}, ${nullableColumn('max_price')}, '')`;
    const shopName = `COALESCE(${nullableColumn('shop_name')}, '')`;
    const sales = `COALESCE(${nullableColumn('sales')}, '')`;
    let rows = hasLinks
      ? db.prepare(`
          SELECT
            p.product_id AS product_id,
            ${productName} AS product_name,
            ${shopName} AS shop_name,
            ${price} AS price,
            ${sales} AS sales,
            COALESCE((
              SELECT s.share_url
              FROM product_shares ps
              JOIN shares s ON s.share_url = ps.share_url
              WHERE ps.product_id = p.product_id
              ORDER BY s.last_seen_ts DESC, s.first_seen_ts DESC
              LIMIT 1
            ), '') AS share_url
          FROM products p
          ORDER BY p.last_seen_ts DESC
        `).all()
      : db.prepare(`
          SELECT
            p.product_id AS product_id,
            ${productName} AS product_name,
            ${shopName} AS shop_name,
            ${price} AS price,
            ${sales} AS sales,
            '' AS share_url
          FROM products p
          ORDER BY p.last_seen_ts DESC
        `).all();

    rows = rows.filter((row) => titleMatchesKeywords(row.product_name, keywords));
    if (completeOnly) {
      rows = rows.filter((row) => (
        String(row.product_id || '').trim()
        && String(row.product_name || '').trim()
        && String(row.shop_name || '').trim()
        && String(row.price || '').trim()
        && String(row.price) !== '0'
        && String(row.sales || '').trim()
        && String(row.share_url || '').trim()
      ));
    }
    if (limit !== undefined) rows = rows.slice(0, limit);

    const header = ['product_id', 'product_name', 'shop_name', 'price', 'sales', 'share_url'];
    const csv = [
      header.map(csvCell).join(','),
      ...rows.map((row) => header.map((key) => csvCell(row[key])).join(',')),
    ].join('\r\n') + '\r\n';
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `\uFEFF${csv}`, 'utf8');
    return { count: rows.length, rows };
  } finally {
    db.close();
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  const dbPath = path.resolve(process.cwd(), options.db);
  const outputPath = path.resolve(process.cwd(), options.output);
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('--limit must be a positive integer');
  }
  const keywords = String(options.keywords || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allExport = exportProducts({
    dbPath,
    outputPath,
    completeOnly: options['complete-only'],
    keywords,
    limit,
  });
  let completeExport = null;
  if (options['complete-output']) {
    completeExport = exportProducts({
      dbPath,
      outputPath: path.resolve(process.cwd(), options['complete-output']),
      completeOnly: true,
      keywords,
      limit,
    });
  }

  if (options.summary) {
    const rows = allExport.rows;
    const completeRows = rows.filter(rowIsComplete);
    const summaryPath = path.resolve(process.cwd(), options.summary);
    let existing = {};
    if (fs.existsSync(summaryPath)) {
      try { existing = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch (_) {}
    }
    const summary = {
      ...existing,
      total_products: rows.length,
      complete_rows: completeRows.length,
      incomplete_rows: rows.length - completeRows.length,
      complete_csv_rows: completeRows.length,
      ...missingFieldCounts(rows),
      output: outputPath,
      complete_output: options['complete-output']
        ? path.resolve(process.cwd(), options['complete-output'])
        : existing.complete_output || '',
    };
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  }

  const completeCount = completeExport?.count ?? allExport.rows.filter(rowIsComplete).length;
  process.stdout.write(`CSV export complete: ${allExport.count} rows\n${outputPath}\n`);
  if (completeExport) process.stdout.write(`Complete CSV: ${completeCount} rows\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[android-export] ${error?.stack || error}\n`);
  process.exitCode = 1;
}
