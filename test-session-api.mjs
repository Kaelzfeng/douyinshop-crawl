/**
 * Test: open product page to get session cookies, then call APIs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36',
  viewport: { width: 430, height: 932 }, locale: 'zh-CN',
});
const page = await ctx.newPage();

console.log('1. Getting session from product page...');
await page.goto('https://v.douyin.com/JtFzR4YIV8c/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);

// Now try the detail endpoint WITH the session cookies
console.log('\n2. Calling detail endpoint (with session)...');
const resp = await page.evaluate(async () => {
  const r = await fetch('https://haohuo.jinritemai.com/aweme/v2/shop/promotion/product/detail?id=3713354677006499920', {
    credentials: 'include'
  });
  return { status: r.status, text: await r.text() };
});
console.log('Status:', resp.status);
console.log('Body:', resp.text.slice(0, 1000));

// Also try: construct the share link from product_id
// v.douyin.com short links are just redirects — can we use the haohuo URL directly?
console.log('\n3. Alternative: construct product URL directly...');
const directUrl = 'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3713354677006499920';
console.log('URL:', directUrl);
const resp3 = await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
const text3 = await resp3.text();
console.log('Body length:', text3.length);

// Check if goods_detail is in the URL
console.log('Final URL hash:', page.url().slice(0, 200));

await browser.close();
