/**
 * Local / sidecar MetaSec signer client (Phase C pure reverse).
 *
 * Talks to an optional Unidbg HTTP service:
 *   POST {baseUrl}/sign  { url, headers?, body? } → { headers }
 *
 * When the sidecar is down, callers should fall back to Frida signOnly or app_proxy.
 */

const DEFAULT_BASE = process.env.METASEC_SIGNER_URL || 'http://127.0.0.1:17890';

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 */
export function createNativeSignClient({
  baseUrl = DEFAULT_BASE,
  timeoutMs = 15_000,
} = {}) {
  async function health() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
        signal: controller.signal,
      });
      if (!resp.ok) return { ok: false, status: resp.status };
      const body = await resp.json().catch(() => ({}));
      return { ok: true, ...body };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {string} url
   * @param {Record<string, string>} [headers]
   * @param {string} [body]
   * @returns {Promise<{url: string, headers: Record<string, string>}>}
   */
  async function sign(url, headers = {}, body = '') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, headers, body }),
        signal: controller.signal,
      });
      const text = await resp.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`native-sign invalid JSON: ${text.slice(0, 200)}`);
      }
      if (!resp.ok || payload.ok === false) {
        throw new Error(payload.error || `native-sign HTTP ${resp.status}`);
      }
      return {
        url: payload.url || url,
        headers: payload.headers || payload.result || {},
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { health, sign, baseUrl };
}
