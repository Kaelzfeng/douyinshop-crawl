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
// Product data parsing
// ---------------------------------------------------------------------------

function parseGoodsDetail(finalUrl) {
  const url = new URL(finalUrl);
  const raw = url.searchParams.get('goods_detail');
  if (!raw) throw new Error('The resolved share URL did not contain goods_detail.');
  const goods = JSON.parse(raw);
  return {
    goods,
    productId: url.searchParams.get('id') || url.searchParams.get('product_id') || null,
  };
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
    商品品名: String(goods.title || '').trim(),
    店铺名: extractShopName(bodyText),
    价格: formatPrice(goods),
    销量: Number.isFinite(Number(goods.sales)) ? `${Number(goods.sales)}件` : '',
    分享的链接: shareLink,
  };
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
 * @returns {Promise<{ enrich: (shareLink: string) => Promise<object>, close: () => Promise<void> }>}
 */
export async function createSharePageEnricher({ headless = true, stealth = true, proxy = null } = {}) {
  let browser;

  if (stealth) {
    browser = await launchStealthBrowser({ headless, proxy });
  } else {
    // Legacy / debug mode: plain Chromium via Edge channel
    browser = await chromium.launch({ channel: 'msedge', headless });
  }

  return {
    /**
     * Enrich a single share link — opens v.douyin.com link, follows redirect,
     * extracts product details. Each call uses an isolated browser context
     * with a randomized fingerprint to prevent session correlation.
     */
    async enrich(shareLink) {
      let context;
      try {
        if (stealth) {
          const fingerprint = generateFingerprint();
          context = await createStealthContext(browser, fingerprint);
        } else {
          context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
            viewport: { width: 430, height: 932 },
            locale: 'zh-CN',
          });
        }

        const page = await context.newPage();

        // Collect console errors for diagnostics (don't log each one)
        const consoleErrors = [];
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        // ---- Navigate to share link ----
        await page.goto(shareLink, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });

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
      } finally {
        // Always close the isolated context to free resources
        if (context) {
          await context.close().catch(() => {});
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
