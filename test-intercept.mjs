/**
 * v3: Override fetch inside the page to capture+replay signed requests.
 * The page's JS generates a_bogus — we hook fetch to see AND reuse it.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36',
  viewport: { width: 430, height: 932 }, locale: 'zh-CN',
});
const page = await ctx.newPage();

// Inject fetch/XHR hooks BEFORE the page loads
await page.addInitScript(() => {
  // Store the last signed URL so we can replay it
  window.__lastSignedUrl = null;
  window.__lastSignedBody = null;

  // Hook fetch
  const origFetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string' && url.includes('jinritemai.com/aweme')) {
      const u = new URL(url);
      if (u.searchParams.has('a_bogus')) {
        window.__lastSignedUrl = url;
        window.__lastSignedBody = opts?.body || null;
        console.log('[HOOK] Signed fetch:', url.slice(0, 200));
      }
    }
    return origFetch.apply(this, arguments);
  };

  // Hook XMLHttpRequest
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open;
    xhr.open = function(method, url) {
      if (url.includes('jinritemai.com/aweme')) {
        const u = new URL(url, window.location.href);
        if (u.searchParams.has('a_bogus')) {
          window.__lastSignedUrl = url;
          console.log('[HOOK] Signed XHR:', method, url.slice(0, 200));
        }
      }
      this._url = url;
      return origOpen.apply(this, arguments);
    };
    return xhr;
  };
});

console.log('Opening product...');
await page.goto('https://v.douyin.com/JtFzR4YIV8c/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(10000);

// Now: use the captured signed URL to call a DIFFERENT endpoint
// The a_bogus is URL-specific, but we can try reusing the verifyFp
console.log('\nTrying to replay with captured params...');

const result = await page.evaluate(async () => {
  const lastUrl = window.__lastSignedUrl;
  if (!lastUrl) return { error: 'No signed URL captured' };

  // Parse the signed URL to extract params
  const u = new URL(lastUrl, 'https://haohuo.jinritemai.com');
  const verifyFp = u.searchParams.get('verifyFp');
  const aBogus = u.searchParams.get('a_bogus');

  // Try the SAME endpoint with SAME params — should work
  const resp1 = await fetch(lastUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: window.__lastSignedBody || 'ui_params=' + encodeURIComponent(JSON.stringify({ source_page: 'copy' }))
  });
  const text1 = await resp1.text();

  // Try calling with JUST verifyFp (no a_bogus) — see if it's strict
  let baseUrl = 'https://haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/h5/?is_h5=1&is_native_h5=1&origin_type=detail_share_funshopping';
  if (verifyFp) baseUrl += '&verifyFp=' + encodeURIComponent(verifyFp);

  const resp2 = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'ui_params=' + encodeURIComponent(JSON.stringify({ source_page: 'copy' }))
  });
  const text2 = await resp2.text();

  return {
    verifyFp,
    aBogus: aBogus?.slice(0, 30) + '...',
    replay_same_url: { size: text1.length, preview: text1.slice(0, 200) },
    replay_no_bogus: { size: text2.length, preview: text2.slice(0, 200) },
  };
});

console.log(JSON.stringify(result, null, 2));

await browser.close();
