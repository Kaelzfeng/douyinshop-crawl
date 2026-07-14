/**
 * v2: Capture raw response, decode it, and try to discover the shop product list API.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36',
  viewport: { width: 430, height: 932 }, locale: 'zh-CN',
});
const page = await ctx.newPage();

// Intercept ALL responses to capture raw body
const capturedResponses = [];
page.on('response', async resp => {
  const url = resp.url();
  if (url.includes('jinritemai.com/aweme') && resp.status() === 200) {
    try {
      const body = await resp.body(); // raw bytes
      const ct = resp.headers()['content-type'] || '';
      capturedResponses.push({
        url: url.slice(0, 250),
        contentType: ct,
        size: body.length,
        // Try to interpret as JSON, protobuf, or text
        text: Buffer.from(body).toString('utf-8').slice(0, 1000),
        hex: Buffer.from(body.slice(0, 100)).toString('hex'),
      });
    } catch(e) {}
  }
});

console.log('Opening product...');
await page.goto('https://v.douyin.com/JtFzR4YIV8c/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(10000);

console.log(`\nCaptured ${capturedResponses.length} responses:\n`);
capturedResponses.forEach((r, i) => {
  console.log(`[${i+1}] ${r.url.split('/').pop()?.split('?')[0]}`);
  console.log(`    Content-Type: ${r.contentType}`);
  console.log(`    Size: ${r.size} bytes`);
  console.log(`    Hex: ${r.hex.slice(0, 60)}`);
  console.log(`    Text: ${r.text.slice(0, 200)}`);
  console.log('');
});

// Now try: capture the EXACT request format and replay with different params
// The promotion/pack/h5 API returned non-JSON data — let's figure out the format

// Also try: find shop product list endpoint from the page's JS
const jsEndpoints = await page.evaluate(() => {
  const scripts = Array.from(document.querySelectorAll('script'));
  const endpoints = [];
  for (const s of scripts) {
    const text = s.textContent || '';
    const matches = text.match(/\/aweme\/[^\s"']+/g) || [];
    endpoints.push(...matches);
  }
  return [...new Set(endpoints)].slice(0, 30);
});
console.log('API endpoints found in page JS:');
jsEndpoints.forEach(e => console.log('  ', e));

// Try calling the shop API — this time matching the page's exact request format
console.log('\nTrying shop product list...');

// The page's API call had verifyFp and a_bogus in the URL
// Let's copy the exact format and try other endpoints
const knownGoodUrl = capturedResponses[0]?.url || '';

// Try: search API that might return multiple products
const searchResult = await page.evaluate(async () => {
  // Use the page's XSRF token / any globals
  try {
    // Try the same promotion/pack/h5 but with different params to get shop products
    const resp = await fetch('https://haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/h5/?is_h5=1&is_native_h5=1&origin_type=detail_share_funshopping', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ui_params=' + encodeURIComponent(JSON.stringify({
        source_page: 'copy',
        from_live: false,
        carrier_source: 'store_page',
        follow_status: '0',
        request_additions: JSON.stringify({ from_internal_feed: 'false', ecom_scene_id: '1099,1031,1082,1003' }),
      }))
    });
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    return { status: resp.status, size: bytes.length, hex: Array.from(bytes.slice(0, 50)).map(b => b.toString(16).padStart(2,'0')).join(' ') };
  } catch(e) {
    return { error: e.message };
  }
});
console.log('Search result:', JSON.stringify(searchResult, null, 2));

await browser.close();
