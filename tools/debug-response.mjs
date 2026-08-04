#!/usr/bin/env node
import { createDirectSearchClient } from '../src/direct-search-client.mjs';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const client = await createDirectSearchClient({ serial: 'emulator-5554', useAppProxy: true });
  const result = await client.searchPage({ keyword: 'ggdb', cursor: '0', count: 8 });

  console.log('Status:', result.httpStatus, 'Biz:', result.businessStatus);
  console.log('Products:', result.products.length);
  console.log('HasMore:', result.hasMore, 'NextCursor:', result.nextCursor);

  const rawDocs = result.rawResponse || [];
  console.log('Documents:', rawDocs.length);

  for (let i = 0; i < Math.min(rawDocs.length, 4); i++) {
    const doc = rawDocs[i];
    console.log(`\nDoc ${i} keys:`, Object.keys(doc).join(', '));
    const pd = doc.page_data || {};
    console.log(`  page_data keys:`, Object.keys(pd).join(', '));

    if (pd.feed_layer) {
      const fl = pd.feed_layer;
      console.log(`  feed_layer keys:`, Object.keys(fl).join(', '));
      if (fl.sections) {
        for (let s = 0; s < Math.min(fl.sections.length, 3); s++) {
          const sec = fl.sections[s];
          const items = sec.items || [];
          console.log(`  section[${s}] id=${sec.section_id} items=${items.length}`);
          if (items.length > 0) {
            console.log(`    item[0] keys:`, Object.keys(items[0]).join(', '));
            // Check if item has product fields
            for (const key of ['product_id', 'ProductID', 'Title', 'title', 'Price', 'price']) {
              if (items[0][key] !== undefined) {
                console.log(`    item[0].${key} =`, JSON.stringify(String(items[0][key]).substring(0, 80)));
              }
            }
            // Deep search for product_id in first item
            let found = false;
            function findPid(obj, depth) {
              if (found || !obj || typeof obj !== 'object' || depth > 6) return;
              if (obj.product_id || obj.ProductID || obj.productId) {
                console.log(`    Found product at depth ${depth}:`, obj.product_id || obj.ProductID || obj.productId);
                console.log(`    Title:`, (obj.Title || obj.title || '').substring(0, 60));
                found = true;
                return;
              }
              if (Array.isArray(obj)) obj.forEach(v => findPid(v, depth + 1));
              else Object.values(obj).forEach(v => { if (typeof v === 'object') findPid(v, depth + 1); });
            }
            findPid(items[0], 0);
            if (!found) console.log('    (no product_id found in first item)');
          }
        }
      }
    }

    if (pd.outer_card_layer) {
      console.log(`  outer_card_layer keys:`, Object.keys(pd.outer_card_layer).join(', '));
    }

    // Cursor info
    for (const k of ['cursor', 'has_more', 'next_cursor', 'hasMore', 'log_pb']) {
      if (doc[k] !== undefined) console.log(`  ${k}:`, JSON.stringify(doc[k]));
    }
  }

  // If no products found, save one raw doc for analysis
  if (result.products.length === 0 && rawDocs.length > 1) {
    const outDir = 'output/direct-search';
    fs.mkdirSync(outDir, { recursive: true });
    // Find the doc with feed_layer
    for (let i = 0; i < rawDocs.length; i++) {
      const fl = rawDocs[i]?.page_data?.feed_layer;
      if (fl) {
        fs.writeFileSync(path.join(outDir, `debug-feed-doc-${i}.json`),
          JSON.stringify(rawDocs[i], null, 2).substring(0, 200000), 'utf8');
        console.log(`\nSaved feed doc ${i} to debug-feed-doc-${i}.json`);
        break;
      }
    }
  }

  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
