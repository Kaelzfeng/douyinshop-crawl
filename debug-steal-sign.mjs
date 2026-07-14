/**
 * Extract signed API calls from the browser page context.
 * The page JS generates valid a_bogus signatures — we intercept and reuse them.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36',
  viewport: { width: 430, height: 932 }, locale: 'zh-CN',
});
const page = await ctx.newPage();

// Capture ALL signed API URLs
const signedUrls = [];
page.on('request', req => {
  const url = req.url();
  if (url.includes('jinritemai.com') && url.includes('a_bogus')) {
    signedUrls.push({ url, method: req.method(), headers: req.headers() });
    console.log('[SIGNED]', req.method(), url.slice(0, 250));
  }
});

console.log('Opening product page...');
await page.goto('https://v.douyin.com/neMzj8Bv_BU/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(8000);

console.log(`\nCaptured ${signedUrls.length} signed API calls`);

// Now try: from within the page context, call the shop API
// The browser's fetch() will use the page's cookies + signing
console.log('\nTrying to call shop API from page context...');
const result = await page.evaluate(async () => {
  try {
    const resp = await fetch('https://haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/h5/?is_h5=1&is_native_h5=1&origin_type=detail_share_funshopping', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ui_params=' + encodeURIComponent(JSON.stringify({ source_page: 'copy', from_live: false, carrier_source: 'store_page', follow_status: '0' }))
    });
    const text = await resp.text();
    return { status: resp.status, text: text.slice(0, 2000) };
  } catch(e) {
    return { error: e.message };
  }
});
console.log('Result:', JSON.stringify(result, null, 2));

await browser.close();
