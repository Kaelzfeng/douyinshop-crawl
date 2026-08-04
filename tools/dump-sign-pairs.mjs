#!/usr/bin/env node
/**
 * Dump Frida signOnly I/O pairs for Unidbg / algorithm reverse (Phase C1).
 *
 * Usage:
 *   node tools/dump-sign-pairs.mjs --query 运动鞋 --count 20
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createDirectSearchClient } from '../src/direct-search-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'output', 'sign-pairs');

function parseArgs(argv) {
  const opts = { query: 'test', count: 20, serial: 'emulator-5554' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--query' && argv[i + 1]) opts.query = argv[++i];
    else if (argv[i] === '--count' && argv[i + 1]) opts.count = Number(argv[++i]) || 20;
    else if (argv[i] === '--serial' && argv[i + 1]) opts.serial = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT, { recursive: true });

  // Use frida_rpc so each page exercises signOnly
  const client = await createDirectSearchClient({
    serial: opts.serial,
    signMode: 'frida_rpc',
  });

  const pairs = [];
  try {
    let cursor = '0';
    for (let i = 0; i < opts.count; i++) {
      const page = await client.searchPage({
        keyword: opts.query,
        cursor,
        count: 8,
      });
      const wire = page.lastWire || await client.getLastWire();
      pairs.push({
        index: i,
        keyword: opts.query,
        cursor,
        nextCursor: page.nextCursor,
        httpStatus: page.httpStatus,
        businessStatus: page.businessStatus,
        products: page.productsInPage,
        signed_headers: page.signedHeaders,
        wire,
        body_md5: createHash('md5').update('').digest('hex'),
      });
      console.log(`pair ${i + 1}/${opts.count} cursor=${cursor} products=${page.productsInPage} keys=${Object.keys(page.signedHeaders || {}).join(',')}`);
      if (!page.hasMore || !page.nextCursor || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
  } finally {
    await client.close();
  }

  const outPath = path.join(OUT, `pairs-${Date.now()}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify({ count: pairs.length, pairs }, null, 2)}\n`, 'utf8');
  console.log(`Saved ${pairs.length} pairs → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
