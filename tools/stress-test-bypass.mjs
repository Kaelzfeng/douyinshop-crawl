#!/usr/bin/env node
/**
 * Stress test: rapid search to trigger captcha, verify bypass works.
 * Runs 20 rapid searches — if captcha is triggered, the bypass agent should
 * auto-dismiss it and the search should continue working.
 */
import { createDirectSearchClient } from '../src/direct-search-client.mjs';

async function main() {
  console.log('[stress] Connecting to app...');
  const client = await createDirectSearchClient({ serial: 'emulator-5554', useAppProxy: true });
  console.log('[stress] Connected.\n');

  const keywords = ['ggdb', '小脏鞋', 'Golden Goose', '脏脏鞋', 'GGDB小脏鞋'];
  let total = 0;
  let fails = 0;

  for (let round = 0; round < 10; round++) {
    for (const kw of keywords) {
      try {
        const result = await client.searchPage({ keyword: kw, cursor: '0', count: 4 });
        total++;
        const status = result.httpStatus === 200 && result.businessStatus === 0 ? 'OK' : `HTTP${result.httpStatus}/BIZ${result.businessStatus}`;
        console.log(`[${total}] ${kw}: ${status} products=${result.products.length} ${result.elapsedMs}ms`);
        if (result.httpStatus !== 200 || result.businessStatus !== 0) fails++;
      } catch (e) {
        fails++;
        console.error(`[${total}] ${kw}: ERROR ${e.message}`);
      }
      // Very short delay to trigger rate limiting
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
    }
    console.log('');
  }

  console.log(`\n=== STRESS TEST COMPLETE ===`);
  console.log(`Requests: ${total}, Failures: ${fails}`);
  console.log(`If bypass works: failures should be 0 (captcha auto-dismissed)`);
  console.log(`If bypass fails: you'll see HTTP errors or timeouts from captcha blocking`);

  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
