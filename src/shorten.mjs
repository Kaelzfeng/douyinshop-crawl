/**
 * Douyin share-link shortening — generate v.douyin.com short links directly.
 *
 * Uses a pre-captured shorten API template + a_bogus signing to call the
 * shorten endpoint without clicking the share button in the app.
 *
 * Two modes:
 *   1. Template mode: uses a captured request (query + body) from a real
 *      shorten call, replaces the haohuo URL, re-signs, and calls the API.
 *   2. Frida mode: uses Frida RPC to trigger the app's internal shorten flow
 *      and captures the resulting v.douyin.com link from the clipboard.
 *
 * Usage:
 *   import { createShortener } from './shorten.mjs';
 *   const shorten = await createShortener({ signer });
 *   const shortLink = await shorten.shorten('https://haohuo.jinritemai.com/...');
 */

import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------
// Known shorten endpoint patterns (will be discovered from captures)
// ---------------------------------------------------------------------------

const SHORTEN_ENDPOINT_CANDIDATES = [
  'https://lf.snssdk.com/shorten/',
  'https://aweme.snssdk.com/shorten/',
  'https://aweme.snssdk.com/aweme/v1/shorten/',
];

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36';

/**
 * Try to extract a shorten API template from Frida capture events.
 *
 * @param {Array<object>} events — Frida events from capture-share-api.js
 * @returns {{ baseUrl: string, query: string, body: string, oldHaohuoUrl: string } | null}
 */
export function extractShortenTemplate(events) {
  // Look for form-field events where name === 'targets' (the haohuo URL)
  const formFields = events.filter((e) => e.type === 'form-field' && e.name === 'targets');
  if (!formFields.length) return null;

  // Find a corresponding retrofit/okhttp request with the same body
  for (const formEvent of formFields) {
    const haohuoUrl = formEvent.value || '';
    if (!/haohuo\.jinritemai/.test(haohuoUrl)) continue;

    // Find retrofit requests around the same time
    const nearbyRequests = events.filter((e) => {
      const dt = Math.abs((e._receivedAt || 0) - (formEvent._receivedAt || 0));
      return (e.type === 'bd-retrofit-request' || e.type === 'okhttp-request')
        && dt < 2000
        && /shorten/i.test(e.url || '');
    });

    if (nearbyRequests.length > 0) {
      const req = nearbyRequests[0];
      // Reconstruct the template
      const bodyFields = events
        .filter((e) => e.type === 'form-field' || e.type === 'bd-form-field')
        .filter((e) => Math.abs((e._receivedAt || 0) - (formEvent._receivedAt || 0)) < 500);

      // Build the body from captured form fields
      const bodyParts = bodyFields.map((f) => `${encodeURIComponent(f.name)}=${encodeURIComponent(f.value || '')}`);
      const body = bodyParts.join('&');

      try {
        const reqUrl = new URL(req.url);
        const baseUrl = `${reqUrl.origin}${reqUrl.pathname}`;
        const query = reqUrl.searchParams.toString();

        return {
          baseUrl,
          query,
          body,
          oldHaohuoUrl: haohuoUrl,
          capturedUrl: req.url,
        };
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Build a shorten request body by replacing the old haohuo URL in the template.
 *
 * @param {string} templateBody — captured form body
 * @param {string} oldHaohuoUrl — the haohuo URL from the template
 * @param {string} newHaohuoUrl — the new haohuo URL to shorten
 * @returns {string}
 */
function replaceHaohuoUrl(templateBody, oldHaohuoUrl, newHaohuoUrl) {
  // The body is typically URL-encoded form data like:
  // targets=https%3A%2F%2Fhaohuo.jinritemai.com%2F...
  const encodedOld = encodeURIComponent(oldHaohuoUrl);
  const encodedNew = encodeURIComponent(newHaohuoUrl);

  let body = templateBody;
  // Try encoded replacement first, then raw
  if (encodedOld && templateBody.includes(encodedOld)) {
    body = templateBody.split(encodedOld).join(encodedNew);
  } else if (oldHaohuoUrl && templateBody.includes(oldHaohuoUrl)) {
    body = templateBody.split(oldHaohuoUrl).join(newHaohuoUrl);
  }

  return body;
}

/**
 * Create a shortener using a pre-captured template.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl — shorten API base URL
 * @param {string} opts.query   — unsigned query string from template
 * @param {string} opts.body    — template form body
 * @param {string} opts.oldHaohuoUrl — the haohuo URL from the template
 * @param {object} opts.signer  — a_bogus signer (from src/a-bogus.mjs)
 * @param {string} [opts.userAgent]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {{ shorten: Function }}
 */
export function createShortenFromTemplate({
  baseUrl,
  query,
  body: templateBody,
  oldHaohuoUrl,
  signer,
  userAgent = DEFAULT_USER_AGENT,
  timeoutMs = 15_000,
}) {
  /**
   * Shorten a haohuo URL to a v.douyin.com short link.
   * @param {string} haohuoUrl
   * @returns {Promise<string>} v.douyin.com short link
   */
  async function shorten(haohuoUrl) {
    const body = replaceHaohuoUrl(templateBody, oldHaohuoUrl, haohuoUrl);

    // Sign the query + body
    const aBogus = await signer.sign(query, body);
    const signedQuery = `${query}&a_bogus=${encodeURIComponent(aBogus)}`;

    const fullUrl = `${baseUrl}?${signedQuery}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': new URL(baseUrl).origin,
          'Referer': `${new URL(baseUrl).origin}/`,
          'User-Agent': userAgent,
        },
        body,
        signal: controller.signal,
        redirect: 'manual', // Don't follow — we want the short link from the response
      });

      // The response may be a redirect (301/302) with Location header,
      // or JSON with the short link
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') || '';
        if (/v\.douyin\.com/.test(location)) {
          return location;
        }
      }

      // Try to parse JSON response
      const text = await response.text();
      try {
        const data = JSON.parse(text);
        // Common response shapes:
        const shortLink =
          data.short_url ||
          data.share_url ||
          data.url ||
          data.data?.short_url ||
          data.data?.share_url ||
          '';
        if (shortLink && /v\.douyin\.com/.test(shortLink)) {
          return shortLink;
        }
      } catch {
        // Maybe the response body IS the short link
        if (/v\.douyin\.com/.test(text)) {
          const m = text.match(/https:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/);
          if (m) return m[0];
        }
      }

      throw new Error(
        `Shorten API did not return a short link. HTTP ${response.status}. ` +
        `Response: ${text.slice(0, 120)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return { shorten };
}

/**
 * Create a shortener that auto-discovers the template from Frida events
 * or falls back to a built-in endpoint pattern.
 *
 * @param {object} opts
 * @param {object} opts.signer — a_bogus signer
 * @param {Array<object>} [opts.fridaEvents] — captured events for template discovery
 * @returns {Promise<{shorten: Function, template: object|null}>}
 */
export async function createShortener({ signer, fridaEvents = [] }) {
  // Try to extract template from Frida events
  const template = extractShortenTemplate(fridaEvents);

  if (template) {
    const shortener = createShortenFromTemplate({ ...template, signer });
    return {
      shorten: (url) => shortener.shorten(url),
      template,
    };
  }

  // No template available — return a shortener that throws with guidance
  return {
    shorten: async (_url) => {
      throw new Error(
        'No shorten API template available. ' +
        'Run a share-click capture with hook/capture-share-api.js first, ' +
        'or pass fridaEvents from a Frida session.',
      );
    },
    template: null,
  };
}

/**
 * Synthesize a v.douyin.com short link from available data.
 * This is a best-effort fallback when the shorten API is unavailable.
 *
 * Note: these synthetic links are NOT real Douyin short links and won't
 * resolve in a browser. They're only useful as stable identifiers in CSV output.
 * Real short links must come from the shorten API or the share button.
 *
 * @param {object} opts
 * @param {string} opts.productId
 * @param {string} [opts.haohuoUrl]
 * @returns {string}
 */
export function syntheticShortLink({ productId, haohuoUrl = '' }) {
  if (haohuoUrl) return haohuoUrl;
  if (productId) return `https://v.douyin.com/${productId}/`;
  return '';
}
