/**
 * Use browser page context to call Douyin shop APIs.
 * The page JS handles a_bogus signing automatically.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36',
  viewport: { width: 430, height: 932 }, locale: 'zh-CN',
});
const page = await ctx.newPage();

// Capture all network activity
const allRequests = [];
const allResponses = [];
page.on('request', req => {
  const url = req.url();
  if (url.includes('jinritemai.com') && url.includes('aweme')) {
    allRequests.push({ method: req.method(), url: url.slice(0, 250) });
  }
});
page.on('response', async resp => {
  const url = resp.url();
  if (url.includes('jinritemai.com') && url.includes('aweme') && resp.status() === 200) {
    try {
      const ct = resp.headers()['content-type'] || '';
      if (ct.includes('json')) {
        const body = await resp.text();
        allResponses.push({ url: url.slice(0, 200), body: body.slice(0, 1000) });
      }
    } catch(e) {}
  }
});

// Step 1: Open product page
console.log('1. Opening product...');
await page.goto('https://v.douyin.com/JtFzR4YIV8c/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(10000);

// Step 2: Show all API requests the page made
console.log('\n2. APIs called by the page:');
allRequests.forEach(r => console.log('  ', r.method, r.url));

// Step 3: Show API responses
console.log('\n3. API responses:');
allResponses.forEach(r => {
  console.log('\n  URL:', r.url);
  try {
    const json = JSON.parse(r.body);
    console.log('  Keys:', Object.keys(json).join(', '));
    // Look for product list data
    if (json.promotion_h5) {
      console.log('  Has promotion_h5!');
      const ph = json.promotion_h5;
      if (ph.basic_info_data) {
        console.log('  Title:', ph.basic_info_data.title_info?.title);
        console.log('  Product ID:', ph.basic_info_data.product_id);
      }
      if (ph.shop_info) {
        console.log('  Shop:', ph.shop_info.basic_info?.shop_name);
      }
    }
    // Check for shop product list
    if (json.products || json.items || json.goods_list || json.product_list) {
      console.log('  FOUND PRODUCT LIST!');
      console.log(JSON.stringify(json).slice(0, 500));
    }
  } catch(e) {
    console.log('  (not JSON)');
  }
});

// Step 4: Try calling additional APIs from page context
console.log('\n4. Calling shop APIs from page context...');

// Extract shop ID from the page
const secShopId = 'JwcKssQb'; // known from earlier reverse engineering
const productId = new URL(page.url()).searchParams.get('id');
console.log('Product ID:', productId);

// Try various API endpoints from within the page context
const endpoints = [
  // Shop product listing
  `https://haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/h5/?is_h5=1&is_native_h5=1&origin_type=detail_share_funshopping`,
  // Try detail endpoint
  `https://haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/detail/?is_h5=1&origin_type=detail_share_funshopping`,
];

for (const endpoint of endpoints) {
  try {
    const result = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'ui_params=' + encodeURIComponent(JSON.stringify({ source_page: 'copy', from_live: false }))
        });
        const text = await resp.text();
        return { status: resp.status, size: text.length, preview: text.slice(0, 500) };
      } catch(e) {
        return { error: e.message };
      }
    }, endpoint);

    console.log(`\n  ${endpoint.split('/').pop()?.split('?')[0]}:`);
    console.log('  Status:', result.status, 'Size:', result.size);
    if (result.preview) {
      try {
        const json = JSON.parse(result.preview);
        console.log('  Keys:', Object.keys(json).join(', '));
      } catch {}
    }
  } catch(e) {
    console.log('  Error:', e.message);
  }
}

await browser.close();
console.log('\nDone');
