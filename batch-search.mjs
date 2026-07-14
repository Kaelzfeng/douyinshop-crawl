/**
 * Batch multi-search crawler — runs crawler with multiple search terms
 * to maximize product discovery from Douyin Mall.
 *
 * Each term surfaces different products; combined they cover the full store.
 *
 * Usage:
 *   node batch-search.mjs
 *
 * Or specify custom terms:
 *   node batch-search.mjs --terms terms.txt
 */

import { runCrawler } from './src/crawler.mjs';
import { readFileSync } from 'fs';

// 20 search terms covering different product categories
const DEFAULT_TERMS = [
  'golden goose',
  'golden goose 鞋',
  'golden goose 男',
  'golden goose 女',
  'golden goose T恤',
  'golden goose 卫衣',
  'golden goose 外套',
  'golden goose 连帽衫',
  'golden goose 牛仔裤',
  'golden goose 短裤',
  'golden goose GGDB',
  'golden goose Super Star',
  'golden goose Ball Star',
  'golden goose V-Star',
  'golden goose 板鞋',
  'golden goose 运动鞋',
  'golden goose 休闲鞋',
  'golden goose 高帮',
  'golden goose 低帮',
  'golden goose 限量',
];

const terms = process.argv.includes('--terms')
  ? readFileSync(process.argv[process.argv.indexOf('--terms') + 1], 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  : DEFAULT_TERMS;

console.log(`[batch] ${terms.length} search terms to crawl:`);
terms.forEach((t, i) => console.log(`  ${i + 1}. "${t}"`));

let totalNew = 0;

for (let i = 0; i < terms.length; i++) {
  const term = terms[i];
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[batch ${i + 1}/${terms.length}] Searching: "${term}"`);
  console.log('='.repeat(60));

  try {
    const result = await runCrawler({
      query: term,
      serial: '127.0.0.1:16384',
      all: true,
      limit: Number.POSITIVE_INFINITY,
      maxScrolls: Number.POSITIVE_INFINITY,
      outputPath: 'output/golden-goose-products.csv',
      checkpointPath: 'data/checkpoint.json',
      summaryPath: 'output/run-summary.json',
      diagnosticsDir: 'output/diagnostics',
      fresh: false, // Continue from existing checkpoint!
      headed: false,
      maxSharesPerWindow: 4,
      shareWindowMs: 20 * 60_000,
      accessDeniedCooldownMs: 12 * 60 * 60_000,
      maxAccessDeniedRetries: 1, // Stop immediately on access-denied; avoid 12h hard cooldown
      stealth: true,
    });

    const newProducts = result.products.length - totalNew;
    totalNew = result.products.length;
    console.log(`[batch] "${term}" done: +${newProducts} new, ${totalNew} total, completed=${result.completed}`);
  } catch (error) {
    console.error(`[batch] "${term}" failed: ${error.message}`);
    console.error('[batch] Continuing to next term...');
  }
}

console.log(`\n[batch] All done! ${totalNew} products collected.`);