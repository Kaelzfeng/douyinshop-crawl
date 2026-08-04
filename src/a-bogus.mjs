/**
 * a_bogus signer — wraps the browser-based bdms runtime as a reusable Node.js module.
 *
 * Keeps one headless browser alive with the bdms bundle loaded and calls the VM
 * signer closure directly. No Android, no Frida, no app required.
 *
 * Usage:
 *   import { createABogusSigner } from './a-bogus.mjs';
 *   const signer = await createABogusSigner();
 *   const sig = await signer.sign('msToken=xxx&...', 'promotion_ids=123&...');
 *   await signer.close();
 */

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BDMS_PATH = path.resolve(__dirname, '..', 'reverse', 'web_sign', 'bdms-1.0.0.38.js');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36';

/**
 * Create a persistent a_bogus signer backed by a headless browser.
 *
 * @param {object} [opts]
 * @param {string} [opts.browserChannel='msedge']
 * @param {boolean} [opts.headless=true]
 * @param {string} [opts.userAgent]
 * @param {number} [opts.startupTimeoutMs=60000]
 * @returns {Promise<{sign: Function, close: Function, health: Function, metadata: object}>}
 */
export async function createABogusSigner({
  browserChannel = 'msedge',
  headless = true,
  userAgent = DEFAULT_USER_AGENT,
  startupTimeoutMs = 60_000,
} = {}) {
  const bdmsSource = await readFile(BDMS_PATH, 'utf8');

  const browser = await chromium.launch({
    channel: browserChannel,
    headless,
  });

  const context = await browser.newContext({
    userAgent,
    viewport: { width: 430, height: 932 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><title>bdms signer</title>');
  await page.addScriptTag({ content: bdmsSource });

  const metadata = await page.evaluate(() => {
    const init = window.bdms?.init;
    const signer = init?._v?.[2]?.[21];
    if (typeof signer !== 'function') {
      throw new Error('bdms signer closure was not found at init._v[2][21]');
    }
    return {
      initEntryPc: init._v?.[0] ?? null,
      signerEntryPc: signer._v?.[0] ?? null,
      signerArity: signer._v?.[1] ?? null,
    };
  });

  let closed = false;
  let consecutiveFailures = 0;

  /**
   * Sign a raw query string (without '?') and its exact serialized body.
   * @param {string} query — raw query like "msToken=xxx&verifyFp=yyy"
   * @param {string} body  — serialized form body like "promotion_ids=123&..."
   * @returns {Promise<string>} 44-char a_bogus string
   */
  async function sign(query, body = '') {
    if (closed) throw new Error('Signer is closed');
    const q = String(query).replace(/^\?/, '');

    const signature = await page.evaluate(({ query, body }) => {
      const signer = window.bdms?.init?._v?.[2]?.[21];
      if (typeof signer !== 'function') throw new Error('bdms signer is unavailable');
      return signer.call(null, query, body);
    }, { query: q, body: String(body) });

    if (typeof signature !== 'string' || signature.length !== 44) {
      consecutiveFailures += 1;
      throw new Error(`Unexpected signer result: ${typeof signature} length ${signature?.length}`);
    }

    consecutiveFailures = 0;
    return signature;
  }

  /**
   * Sign multiple (query, body) pairs in a single page.evaluate roundtrip.
   * Much faster for batch operations.
   *
   * @param {Array<{query: string, body?: string}>} batch
   * @returns {Promise<string[]>} a_bogus values in same order
   */
  async function signBatch(batch) {
    if (closed) throw new Error('Signer is closed');
    if (!batch?.length) return [];

    const signatures = await page.evaluate((items) => {
      const signer = window.bdms?.init?._v?.[2]?.[21];
      if (typeof signer !== 'function') throw new Error('bdms signer is unavailable');
      return items.map(({ query, body }) => {
        return signer.call(null, String(query || '').replace(/^\?/, ''), String(body || ''));
      });
    }, batch);

    for (const sig of signatures) {
      if (typeof sig !== 'string' || sig.length !== 44) {
        consecutiveFailures += 1;
        throw new Error(`Batch sign produced bad result: ${typeof sig} length ${sig?.length}`);
      }
    }

    consecutiveFailures = 0;
    return signatures;
  }

  /**
   * Health check — verifies the signer still works.
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function health() {
    try {
      const sig = await sign('x=1&y=2', 'a=3');
      return { ok: sig.length === 44, consecutiveFailures };
    } catch (e) {
      return { ok: false, error: e.message, consecutiveFailures };
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    await browser.close().catch(() => {});
  }

  return { sign, signBatch, health, close, metadata };
}

// ---------------------------------------------------------------------------
// Signer pool for concurrent operations
// ---------------------------------------------------------------------------

/**
 * Create a pool of a_bogus signers for concurrent use.
 *
 * @param {object} [opts]
 * @param {number} [opts.size=2]
 * @param {number} [opts.warmupTimeoutMs=60000]
 */
export async function createABogusSignerPool({ size = 2, warmupTimeoutMs = 60_000 } = {}) {
  const signers = [];
  let cursor = 0;
  let closed = false;

  // Initialize signers sequentially to avoid overwhelming the system
  for (let i = 0; i < size; i++) {
    signers.push(await createABogusSigner({ startupTimeoutMs: warmupTimeoutMs }));
  }

  function nextSigner() {
    if (closed) throw new Error('Signer pool is closed');
    const signer = signers[cursor % signers.length];
    cursor += 1;
    return signer;
  }

  return {
    /** Sign a single (query, body) pair. */
    async sign(query, body = '') {
      return nextSigner().sign(query, body);
    },

    /** Sign a batch using one signer. */
    async signBatch(batch) {
      return nextSigner().signBatch(batch);
    },

    /** Health check — verifies ALL signers in the pool. */
    async health() {
      const results = await Promise.all(signers.map((s) => s.health()));
      return {
        ok: results.every((r) => r.ok),
        total: signers.length,
        healthy: results.filter((r) => r.ok).length,
        details: results,
      };
    },

    /** Close all signers. */
    async close() {
      closed = true;
      await Promise.all(signers.map((s) => s.close()));
    },

    get size() { return signers.length; },
  };
}
