#!/usr/bin/env node
/**
 * Crawl all shops from existing CSV — enter each unique shop,
 * find all products matching ggdb / 小脏鞋 keywords.
 *
 * Usage: node crawl-all-shops.mjs [keyword]
 */
import fs from 'node:fs';
import { crawlShop } from './src/shop-crawler.mjs';

const CSV = process.argv[2] || 'output/all-products-final.csv';
const KEYWORD = process.argv[3] || 'ggdb';

const raw = fs.readFileSync(CSV, 'utf8');
const lines = raw.trim().split(/\r?\n/).slice(1); // skip header

// Extract unique shop links (use first product link per shop as entry point)
const shopLinks = new Map();
for (const line of lines) {
  const parts = line.split(',');
  const link = parts[parts.length - 1]; // 分享的链接 is last column
  const shop = parts[3] || ''; // 店铺名
  if (link && link.startsWith('http') && shop && !shopLinks.has(shop)) {
    shopLinks.set(shop, link);
  }
}

console.log(`Found ${shopLinks.size} unique shops in ${CSV}`);
console.log(`Keyword: ${KEYWORD}`);
console.log('');

for (const [shop, link] of shopLinks) {
  console.log(`\n=== Crawling shop: ${shop} ===`);
  console.log(`Entry link: ${link}`);
  try {
    const result = await crawlShop({
      productLink: link,
      serial: 'emulator-5554',
      keyword: KEYWORD,
      outputPath: `output/shop-${shop.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 30)}.csv`,
      checkpointPath: `data/shop-checkpoint-${shop.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 20)}.json`,
      summaryPath: `output/shop-summary.json`,
      maxScrolls: 30,
      fresh: true,
    });
    console.log(`Collected: ${result.products.length}, errors: ${result.errors.length}`);
  } catch (e) {
    console.error(`FAILED: ${shop} — ${e.message}`);
  }
}
