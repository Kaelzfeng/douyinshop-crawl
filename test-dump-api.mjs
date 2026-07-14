/**
 * Dump the FULL 9539-byte API response to see ALL fields.
 * Maybe it contains a product list, related items, or pagination data.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36',
  viewport: { width: 430, height: 932 }, locale: 'zh-CN',
});
const page = await ctx.newPage();

page.on('response', async resp => {
  const url = resp.url();
  if (url.includes('promotion/pack/h5') && resp.status() === 200) {
    const body = await resp.text();
    console.log('=== FULL API RESPONSE ===');
    console.log('Size:', body.length, 'bytes');

    const json = JSON.parse(body);

    // Recursively explore all keys and values
    function explore(obj, prefix = '', depth = 0) {
      if (depth > 6) return;
      if (obj === null || obj === undefined) return;
      if (typeof obj !== 'object') {
        console.log(prefix + ': ' + String(obj).slice(0, 200));
        return;
      }
      if (Array.isArray(obj)) {
        console.log(prefix + `: [${obj.length} items]`);
        obj.slice(0, 5).forEach((item, i) => {
          if (typeof item === 'object') {
            console.log(prefix + `[${i}]:`);
            explore(item, prefix + '  ', depth + 1);
          } else {
            console.log(prefix + `[${i}]: ` + String(item).slice(0, 100));
          }
        });
        return;
      }
      const keys = Object.keys(obj);
      console.log(prefix + `{${keys.length} keys}: ${keys.slice(0, 20).join(', ')}`);
      for (const key of keys.slice(0, 30)) {
        explore(obj[key], prefix + '  ' + key, depth + 1);
      }
    }

    explore(json);

    // Save raw JSON
    writeFileSync('output/api-response.json', JSON.stringify(json, null, 2));
    console.log('\nSaved to output/api-response.json');
  }
});

await page.goto('https://v.douyin.com/JtFzR4YIV8c/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(10000);
await browser.close();
