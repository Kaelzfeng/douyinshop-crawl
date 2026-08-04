/**
 * Frida RPC signer — uses the app's internal NetworkParams signing via Frida.
 *
 * Loads hook/native-signer-agent.bundle.js (which exposes rpc.exports.sign)
 * and wraps it as a Node.js module. Falls back to bdms-based a_bogus signer
 * when Frida is unavailable.
 *
 * The native signer produces headers like X-Gorgon, X-Khronos, X-Argus, etc.
 * while the bdms signer produces a_bogus query params. They are complementary.
 *
 * Usage:
 *   import { createFridaRpcSigner } from './frida-sign-rpc.mjs';
 *   const signer = await createFridaRpcSigner({ serial: 'emulator-5554' });
 *   const headers = await signer.signHeaders('https://haohuo.jinritemai.com/...');
 *   // headers = { 'X-Gorgon': '...', 'X-Khronos': '...', ... }
 *   await signer.close();
 */

import frida from 'frida';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.resolve(__dirname, '..', 'hook', 'native-signer-agent.bundle.js');
const PACKAGE_NAME = 'com.ss.android.ugc.livelite';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a Frida RPC signer that delegates to the app's NetworkParams.
 *
 * @param {object} [opts]
 * @param {string} [opts.serial='emulator-5554']
 * @param {string} [opts.fridaHost='127.0.0.1:27042']
 * @param {string} [opts.bundlePath] — override path to the Frida bundle
 * @param {boolean} [opts.allowFallback=true] — if true, returns empty headers when Frida unavailable
 * @returns {Promise<{signHeaders: Function, signQuery: Function, shorten: Function, status: Function, close: Function}>}
 */
export async function createFridaRpcSigner({
  serial = 'emulator-5554',
  fridaHost = '127.0.0.1:27042',
  bundlePath = null,
  allowFallback = true,
} = {}) {
  const bundle = bundlePath || BUNDLE_PATH;
  if (!fs.existsSync(bundle)) {
    if (allowFallback) return createFallbackSigner('Frida bundle not found: ' + bundle);
    throw new Error('Frida bundle not found: ' + bundle);
  }

  let script;
  let session;
  let device;
  const events = [];

  try {
    const devices = await frida.enumerateDevices();
    device = devices.find((d) => d.id === serial) || devices.find((d) => d.type === 'usb');
    if (!device) {
      device = await frida.getDeviceManager().addRemoteDevice(fridaHost);
    }

    const processes = await device.enumerateProcesses({ scope: 'full' });
    const proc = processes.find((p) =>
      (p.parameters?.applications || []).includes(PACKAGE_NAME),
    ) || processes.find((p) => {
      const n = p.name || '';
      return n === '抖音商城' || n.includes('livelite');
    });

    if (!proc) {
      if (allowFallback) return createFallbackSigner('Douyin Mall process not found');
      throw new Error('Douyin Mall process not found');
    }

    session = await device.attach(proc.pid);
    script = await session.createScript(fs.readFileSync(bundle, 'utf8'));

    script.message.connect((message) => {
      if (message.type === 'send') {
        events.push({ ...message.payload, _receivedAt: Date.now() });
      }
    });

    await script.load();
    await sleep(800);

    // Verify signer is operational
    const status = await script.exports.status();
    if (!status.networkParamsLoaded) {
      if (allowFallback) {
        console.warn('[frida-sign] NetworkParams not loaded, using fallback');
        return createFallbackSigner('NetworkParams not loaded');
      }
      throw new Error('NetworkParams provider not available');
    }

    console.log(`[frida-sign] RPC ready — pid=${Process?.pid || '?'} arch=${status.f3Loaded ? 'f3' : 'vanilla'}`);

    return {
      /**
       * Sign a URL and return the security headers (X-Gorgon, X-Khronos, etc.)
       * @param {string} url
       * @param {object} [extraHeaders={}]
       * @returns {Promise<object>} map of header name → value
       */
      async signHeaders(url, extraHeaders = {}) {
        if (!script) throw new Error('Frida signer not connected');
        return script.exports.sign(String(url), extraHeaders);
      },

      /**
       * Sign a URL and return just the query-string parameters
       * (a_bogus, msToken if embedded, etc.)
       * @param {string} url
       * @param {object} [extraHeaders={}]
       * @returns {Promise<string>} "a_bogus=xxx&..." query fragment
       */
      async signQuery(url, extraHeaders = {}) {
        const headers = await this.signHeaders(url, extraHeaders);
        // Extract signing params from the returned headers map
        const params = [];
        for (const [k, v] of Object.entries(headers || {})) {
          if (/^(x-|pigeon|a_bogus|bogus)/i.test(k)) {
            params.push(`${k}=${encodeURIComponent(String(v))}`);
          }
        }
        return params.join('&');
      },

      /**
       * Get signer status.
       */
      async status() {
        if (!script) return { ok: false, reason: 'disconnected' };
        try {
          return await script.exports.status();
        } catch (e) {
          return { ok: false, reason: e.message };
        }
      },

      /** Get captured events (shorten templates, etc.). */
      getEvents() {
        return [...events];
      },

      /** Clear captured events. */
      clearEvents() {
        events.length = 0;
      },

      async close() {
        if (script) {
          await script.unload().catch(() => {});
          script = null;
        }
        if (session) {
          await session.detach().catch(() => {});
          session = null;
        }
      },
    };
  } catch (error) {
    // Cleanup on error
    if (script) await script.unload().catch(() => {});
    if (session) await session.detach().catch(() => {});

    if (allowFallback) {
      console.warn(`[frida-sign] Unavailable: ${error.message}. Using fallback.`);
      return createFallbackSigner(error.message);
    }
    throw error;
  }
}

/**
 * Fallback signer: returns empty headers when Frida is unavailable.
 * Callers should detect this and use the bdms-based a_bogus signer instead.
 */
function createFallbackSigner(reason) {
  return {
    _fallback: true,
    _reason: reason,

    async signHeaders(_url, _headers) {
      return {};
    },

    async signQuery(_url, _headers) {
      return '';
    },

    async status() {
      return { ok: false, reason, fallback: true };
    },

    getEvents() { return []; },
    clearEvents() {},

    async close() {},
  };
}
