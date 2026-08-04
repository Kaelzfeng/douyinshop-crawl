import { chromium } from 'playwright';
import { generateFingerprint } from './fingerprint.mjs';
import { humanDelay } from './rate-limit.mjs';
import { launchStealthBrowser, createStealthContext } from './stealth.mjs';

const SHOP_RE = /(?:官方旗舰店|旗舰店|专卖店|专营店|企业店|个体店)$/;

// ---------------------------------------------------------------------------
// Verification / CAPTCHA detection patterns
// ---------------------------------------------------------------------------
const VERIFICATION_PATTERNS = [
  /验证/,
  /滑块/,
  /拼图/,
  /点击.*完成/,
  /安全.*检测/,
  /访问.*验证/,
  /请在.*秒后/,
  /请稍后再试/,
  /操作.*频繁/,
  /网络.*异常/,
  /请求.*太频繁/,
  /休息一下/,
];

/**
 * Returns true if the page body text looks like a verification/challenge wall.
 */
function isVerificationPage(bodyText) {
  return VERIFICATION_PATTERNS.some((re) => re.test(bodyText));
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a product URL — decode, strip tracking, detect type.
 * @param {string} rawUrl
 * @returns {{ normalizedUrl: string, hasGoodsDetail: boolean, isShortLink: boolean, productId: string }}
 */
export function normalizeProductUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return { normalizedUrl: s, hasGoodsDetail: false, isShortLink: false, productId: '' };

  let decoded = s;
  try { decoded = decodeURIComponent(s); } catch { /* keep original */ }

  const isShortLink = /v\.douyin\.com\//.test(decoded);
  const hasGoodsDetail = /goods_detail/.test(decoded);

  // Extract product_id from URL params or numeric patterns
  let productId = '';
  try {
    const u = new URL(decoded.includes('://') ? decoded : `https://x/?${decoded}`);
    productId = u.searchParams.get('id') || u.searchParams.get('product_id') || '';
  } catch { /* not a valid URL */ }
  if (!productId) {
    const m = decoded.match(/\b\d{16,22}\b/);
    if (m) productId = m[0];
  }

  return { normalizedUrl: decoded, hasGoodsDetail, isShortLink, productId };
}

// ---------------------------------------------------------------------------
// Product data parsing
// ---------------------------------------------------------------------------

function parseGoodsDetail(finalUrl) {
  const url = new URL(finalUrl);
  const raw = url.searchParams.get('goods_detail');
  if (!raw) throw new Error('The resolved share URL did not contain goods_detail.');
  const goods = JSON.parse(raw);
  return {
    goods,
    productId: extractProductId(finalUrl),
  };
}

export function extractProductId(finalUrl, shareLink = '') {
  for (const value of [finalUrl, shareLink]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      const productId = url.searchParams.get('id') || url.searchParams.get('product_id');
      if (productId) return productId;
    } catch {
    }
    const match = String(value).match(/\b\d{16,22}\b/);
    if (match) return match[0];
  }
  return '';
}

function amountFromFen(value) {
  if (!Number.isFinite(value)) return null;
  const amount = value / 100;
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function formatPrice(goods) {
  const min = amountFromFen(Number(goods.min_price));
  const max = amountFromFen(Number(goods.max_price));
  if (!min && !max) return '';
  if (!max || min === max) return min || max;
  return `${min}-${max}`;
}

export function extractShopName(bodyText = '') {
  return bodyText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length >= 3 && line.length <= 80 && SHOP_RE.test(line)) || '';
}

export function parseResolvedProduct(finalUrl, bodyText, shareLink) {
  const { goods, productId } = parseGoodsDetail(finalUrl);
  return {
    productId,
    商品id: productId,
    商品品名: String(goods.title || '').trim(),
    店铺名: extractShopName(bodyText),
    价格: formatPrice(goods),
    销量: Number.isFinite(Number(goods.sales)) ? `${Number(goods.sales)}件` : '',
    分享的链接: shareLink,
  };
}

// ---------------------------------------------------------------------------
// Fast-path: parse haohuo URL with goods_detail directly (no browser)
// ---------------------------------------------------------------------------

/**
 * Parse a haohuo.jinritemai.com URL that contains goods_detail inline.
 * Zero network overhead — the product data is embedded in the URL itself.
 *
 * @param {string} longUrl — haohuo URL with goods_detail query param
 * @returns {object|null} product record, or null if goods_detail not present
 */
export function enrichFromHaohuoUrl(longUrl) {
  try {
    const decoded = decodeURIComponent(longUrl);
    const url = new URL(decoded);
    const goodsRaw = url.searchParams.get('goods_detail');
    if (!goodsRaw) return null;
    const goods = JSON.parse(decodeURIComponent(goodsRaw));
    const productId = url.searchParams.get('id') || url.searchParams.get('product_id') || '';
    const min = Number(goods.min_price) / 100;
    const max = Number(goods.max_price) / 100;
    let price = '';
    if (Number.isFinite(min) && Number.isFinite(max) && min !== max) price = min + '-' + max;
    else if (Number.isFinite(min)) price = String(min);

    return {
      商品id: productId,
      商品品名: String(goods.title || '').trim(),
      店铺名: '',
      价格: price,
      销量: Number.isFinite(Number(goods.sales)) ? Number(goods.sales) + '件' : '',
      分享的链接: longUrl,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enricher factory — creates a stealth-aware browser pool for enrichment
// ---------------------------------------------------------------------------

/**
 * Creates a share-page enricher.
 *
 * @param {object} options
 * @param {boolean} options.headless — whether to run headless (default true)
 * @param {boolean} options.stealth — enable anti-detection measures (default true)
 * @param {object}  [options.proxy] — optional proxy config { server: 'http://host:port' }
 * @param {number}  [options.maxRetries=3] — max retries for short link resolution
 * @returns {Promise<{ enrich: (shareLink: string) => Promise<object>, close: () => Promise<void> }>}
 */
export async function createSharePageEnricher({ headless = true, stealth = true, proxy = null, maxRetries = 3 } = {}) {
  let browser;

  if (stealth) {
    browser = await launchStealthBrowser({ headless, proxy });
  } else {
    // Legacy / debug mode: plain Chromium via Edge channel
    browser = await chromium.launch({ channel: 'msedge', headless });
  }

  /**
   * Navigate to a v.douyin.com short link and follow redirect with retry + backoff.
   * @param {import('playwright').Page} page
   * @param {string} shareLink
   * @param {number} maxRetries
   * @returns {Promise<void>}
   */
  async function gotoWithRetry(page, shareLink, maxRetries) {
    const backoffs = [5_000, 15_000, 45_000];
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await page.goto(shareLink, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        return;
      } catch (e) {
        if (attempt < maxRetries - 1) {
          const delay = backoffs[attempt] || 45_000;
          console.warn(`[enrich] goto attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay / 1000}s: ${e.message.slice(0, 60)}`);
          await page.waitForTimeout(delay);
        } else {
          throw e;
        }
      }
    }
  }

  return {
    /**
     * Enrich a single share link — opens v.douyin.com link, follows redirect,
     * extracts product details. Each call uses an isolated browser context
     * with a randomized fingerprint to prevent session correlation.
     */
    async enrich(shareLink) {
      // ---- Fast path: haohuo URL with goods_detail (no browser needed) ----
      if (/haohuo\.jinritemai\.com/.test(shareLink)) {
        const fastResult = enrichFromHaohuoUrl(shareLink);
        if (fastResult) return fastResult;
        // Has haohuo URL but no goods_detail — will need browser to scrape
      }

      let context;
      let verificationAttempts = 0;
      const maxVerificationRetries = 2;

      async function tryEnrich() {
        if (stealth) {
          const fingerprint = generateFingerprint();
          // Rotate fingerprint on retry after verification wall
          if (verificationAttempts > 0) {
            fingerprint.userAgent = fingerprint.userAgent.replace(
              /Chrome\/\d+/,
              `Chrome/${130 + verificationAttempts}`,
            );
          }
          context = await createStealthContext(browser, fingerprint);
        } else {
          context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
            viewport: { width: 430, height: 932 },
            locale: 'zh-CN',
          });
        }

        const page = await context.newPage();

        // Collect console errors for diagnostics
        const consoleErrors = [];
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        // ---- Navigate to share link (with progressive backoff retry) ----
        await gotoWithRetry(page, shareLink, maxRetries);

        // Wait for body to be visible
        await page.locator('body').waitFor({ state: 'visible', timeout: 10_000 });

        // ---- Human-like behavior: scroll slightly ----
        await page.evaluate(() => {
          const scrollY = 100 + Math.floor(Math.random() * 250);
          window.scrollTo({ top: scrollY, behavior: 'smooth' });
        });

        // ---- Pre-extraction delay (mimics reading the page) ----
        const readDelay = humanDelay(1200);
        await page.waitForTimeout(readDelay);

        // Small scroll back up
        await page.evaluate(() => {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        await page.waitForTimeout(300);

        // ---- Extract body text ----
        let bodyText = await page.locator('body').innerText();

        // ---- Wait for shop name to appear (lazy-loaded) ----
        for (let attempt = 0; attempt < 8 && !extractShopName(bodyText); attempt += 1) {
          await page.waitForTimeout(500);
          bodyText = await page.locator('body').innerText();
        }

        // ---- Check for verification / CAPTCHA wall ----
        if (isVerificationPage(bodyText)) {
          const preview = bodyText.slice(0, 200).replace(/\s+/g, ' ');
          const errDetails = consoleErrors.length > 0
            ? ` Console errors: ${consoleErrors.slice(-3).join('; ')}`
            : '';
          throw new Error(`Verification page detected. Page preview: "${preview}"${errDetails}`);
        }

        return parseResolvedProduct(page.url(), bodyText, shareLink);
      }

      // ---- Main enrich flow with verification retry ----
      while (true) {
        try {
          return await tryEnrich();
        } catch (err) {
          // Close context on error
          if (context) { await context.close().catch(() => {}); context = null; }

          if (/Verification page/.test(err.message) && verificationAttempts < maxVerificationRetries) {
            verificationAttempts += 1;
            console.warn(
              `[enrich] verification wall, rotating context ` +
              `(${verificationAttempts}/${maxVerificationRetries})...`,
            );
            await new Promise((r) => setTimeout(r, 10_000 * verificationAttempts));
            continue;
          }
          throw err;
        }
      }
    },

    /**
     * Close the browser and all associated resources.
     */
    async close() {
      await browser.close().catch(() => {});
    },
  };
}
