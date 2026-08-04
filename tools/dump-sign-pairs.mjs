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
        f3_io: page.lastWire?.f3_io || wire?.f3_io || [],
        metasec_handle: page.lastWire?.metasec_handle || wire?.metasec_handle || null,
        wire,
        body_md5: createHash('md5').update(String(wire?.body || '')).digest('hex'),
      });
      const f3n = (page.lastWire?.f3_io || wire?.f3_io || []).length;
      const handle = page.lastWire?.metasec_handle?.handle || wire?.metasec_handle?.handle || '?';
      console.log(`pair ${i + 1}/${opts.count} cursor=${cursor} products=${page.productsInPage} f3_events=${f3n} handle=${handle} keys=${Object.keys(page.signedHeaders || {}).join(',')}`);
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
