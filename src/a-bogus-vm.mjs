/**
 * Experimental a_bogus signer without Playwright (Phase D).
 * Loads reverse/web_sign/bdms-1.0.0.38.js inside Node vm with browser mocks.
 *
 * Many bdms builds need real browser APIs; if init fails, use createABogusSigner().
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BDMS_PATH = path.join(ROOT, 'reverse', 'web_sign', 'bdms-1.0.0.38.js');

function buildSandbox() {
  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
  };

  const navigator = {
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36',
    language: 'zh-CN',
    languages: ['zh-CN', 'zh'],
    platform: 'Linux armv8l',
    webdriver: false,
  };

  const document = {
    cookie: '',
    documentElement: { style: {} },
    createElement: () => ({
      style: {},
      setAttribute() {},
      appendChild() {},
      remove() {},
    }),
    getElementsByTagName: () => [],
    addEventListener() {},
  };

  const window = {
    navigator,
    document,
    localStorage,
    sessionStorage: localStorage,
    location: { href: 'https://haohuo.jinritemai.com/', protocol: 'https:', host: 'haohuo.jinritemai.com', hostname: 'haohuo.jinritemai.com' },
    screen: { width: 900, height: 1600, colorDepth: 24 },
    history: { length: 1 },
    chrome: { runtime: {} },
    bdms: undefined,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Uint8Array,
    ArrayBuffer,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    escape: encodeURIComponent,
    unescape: decodeURIComponent,
    console,
  };
  window.window = window;
  window.self = window;
  window.globalThis = window;
  window.top = window;
  window.parent = window;

  return window;
}

/**
 * @returns {Promise<{sign: Function, close: Function, health: Function, mode: string}>}
 */
export async function createABogusVmSigner() {
  if (!fs.existsSync(BDMS_PATH)) {
    throw new Error(`bdms bundle missing: ${BDMS_PATH}`);
  }
  const source = fs.readFileSync(BDMS_PATH, 'utf8');
  const sandbox = buildSandbox();
  const context = vm.createContext(sandbox);

  try {
    vm.runInContext(source, context, { filename: 'bdms-1.0.0.38.js', timeout: 10000 });
  } catch (error) {
    throw new Error(`bdms vm load failed: ${error.message}`);
  }

  // Discover signer closure similar to browser path: bdms.init._v[2][21]
  let signerFn = null;
  try {
    signerFn = vm.runInContext(
      `(function(){
        var b = globalThis.bdms || window.bdms;
        if (!b) return null;
        if (b.init && b.init._v && b.init._v[2] && typeof b.init._v[2][21] === 'function') return b.init._v[2][21];
        if (typeof b.sign === 'function') return b.sign.bind(b);
        return null;
      })()`,
      context,
    );
  } catch (error) {
    throw new Error(`bdms signer probe failed: ${error.message}`);
  }

  if (typeof signerFn !== 'function') {
    throw new Error('bdms loaded but signer closure not found (need browser a-bogus.mjs)');
  }

  return {
    mode: 'vm',
    async sign(query, body = '') {
      const q = String(query || '');
      const b = String(body || '');
      const result = signerFn(q, b);
      if (result == null) throw new Error('bdms vm sign returned empty');
      return String(result);
    },
    async health() {
      return { ok: true, mode: 'vm' };
    },
    async close() {},
  };
}
