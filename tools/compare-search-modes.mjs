#!/usr/bin/env node
/**
 * Compare app_proxy vs frida_rpc (and optional local) for one search page.
 *
 * Usage:
 *   node tools/compare-search-modes.mjs --query 运动鞋
 *   node tools/compare-search-modes.mjs --query 运动鞋 --modes app_proxy,frida_rpc
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDirectSearchClient } from '../src/direct-search-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'output', 'direct-search');

function parseArgs(argv) {
  const opts = {
    query: '',
    modes: ['app_proxy', 'frida_rpc'],
    serial: 'emulator-5554',
  };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--query' || argv[i] === '--keyword') && argv[i + 1]) opts.query = argv[++i];
    else if (argv[i] === '--modes' && argv[i + 1]) opts.modes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--serial' && argv[i + 1]) opts.serial = argv[++i];
  }
  return opts;
}

async function runMode(mode, keyword, serial) {
  const client = await createDirectSearchClient({ serial, signMode: mode });
  try {
    const page = await client.searchPage({ keyword, cursor: '0', count: 8 });
    const wire = page.lastWire || await client.getLastWire();
    return {
      mode,
      ok: page.httpStatus === 200 && page.businessStatus === 0 && page.productsInPage > 0,
      httpStatus: page.httpStatus,
      businessStatus: page.businessStatus,
      statusMsg: page.statusMsg || '',
      products: page.productsInPage,
      sampleIds: page.products.slice(0, 3).map((p) => p.product_id),
      responseBytes: page.responseBytes,
      elapsedMs: page.elapsedMs,
      signedHeaderKeys: Object.keys(page.signedHeaders || {}),
      bodyPreview: String(page.rawBody || '').slice(0, 400),
      wire,
    };
  } finally {
    await client.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.query) {
    console.error('Usage: node tools/compare-search-modes.mjs --query <keyword> [--modes app_proxy,frida_rpc,local]');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const mode of opts.modes) {
    console.log(`\n=== mode=${mode} ===`);
    try {
      const r = await runMode(mode, opts.query, opts.serial);
      results.push(r);
      console.log(JSON.stringify({
        ok: r.ok,
        httpStatus: r.httpStatus,
        businessStatus: r.businessStatus,
        products: r.products,
        signedHeaderKeys: r.signedHeaderKeys,
        elapsedMs: r.elapsedMs,
      }, null, 2));
    } catch (error) {
      results.push({ mode, ok: false, error: String(error?.message || error) });
      console.error(error);
    }
  }

  const outPath = path.join(OUT, `compare-modes-${Date.now()}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify({ query: opts.query, results }, null, 2)}\n`, 'utf8');

  // Update header classification notes if we got a wire dump
  const wire = results.find((r) => r.wire)?.wire;
  if (wire) {
    const wirePath = path.join(OUT, 'wire-headers-sample.json');
    fs.writeFileSync(wirePath, `${JSON.stringify(wire, null, 2)}\n`, 'utf8');
  }

  console.log(`\nSaved ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
