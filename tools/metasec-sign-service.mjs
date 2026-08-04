#!/usr/bin/env node
/**
 * MetaSec sign HTTP sidecar (Phase C interim).
 *
 * Exposes the same API as unidbg-metasec so Node `--sign-mode local` works:
 *   GET  /health
 *   POST /sign  { url, headers?, body? } → { ok, headers, cookie_header?, mode }
 *
 * This process attaches Frida to the live Douyin Mall app and calls NetworkParams
 * via direct-search-agent (signOnly). Offline Unidbg can later replace this process
 * without changing the Node client (src/native-sign.mjs).
 *
 * Usage:
 *   npm run build:direct-search
 *   npm run sign:local-service
 *   # other terminal:
 *   npm start -- --query 运动鞋 --single-page --sign-mode local
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import frida from 'frida';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'hook', 'direct-search-agent.bundle.js');
const PACKAGE_NAME = 'com.ss.android.ugc.livelite';

const PORT = Number(process.env.METASEC_SIGNER_PORT || 17890);
const HOST = process.env.METASEC_SIGNER_HOST || '127.0.0.1';
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const FRIDA_HOST = process.env.FRIDA_HOST || '127.0.0.1:27042';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bodyStub(body) {
  return createHash('md5').update(String(body || ''), 'utf8').digest('hex').toUpperCase();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

class FridaSignBridge {
  constructor() {
    this.script = null;
    this.session = null;
    this.device = null;
    this.pid = null;
    this.connecting = null;
  }

  async ensure() {
    if (this.script) {
      try {
        await this.script.exports.ping();
        return;
      } catch {
        await this.close().catch(() => {});
      }
    }
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async _connect() {
    if (!fs.existsSync(BUNDLE)) {
      throw new Error(`Missing ${BUNDLE}. Run: npm run build:direct-search`);
    }

    const devices = await frida.enumerateDevices();
    let device = devices.find((d) => d.id === SERIAL) || devices.find((d) => d.type === 'usb');
    if (!device) {
      device = await frida.getDeviceManager().addRemoteDevice(FRIDA_HOST);
    }
    this.device = device;

    const processes = await device.enumerateProcesses({ scope: 'full' });
    const proc = processes.find((p) =>
      (p.parameters?.applications || []).includes(PACKAGE_NAME),
    ) || processes.find((p) => {
      const n = p.name || '';
      return n === '抖音商城' || n.includes('livelite');
    });
    if (!proc) throw new Error('Douyin Mall process not found');

    this.session = await device.attach(proc.pid);
    this.script = await this.session.createScript(fs.readFileSync(BUNDLE, 'utf8'));
    await this.script.load();
    await sleep(400);

    const status = await this.script.exports.status();
    if (!status.ok) {
      throw new Error(`NetworkParams not ready: ${JSON.stringify(status)}`);
    }
    this.pid = proc.pid;
    console.log(`[metasec-sign-service] attached pid=${proc.pid} provider=${status.providerInstalled}`);
  }

  async sign(url, headers = {}, body = '') {
    await this.ensure();
    const base = { ...headers };
    if (body && !base['X-SS-STUB'] && !base['x-ss-stub']) {
      base['X-SS-STUB'] = bodyStub(body);
    }
    const signed = await this.script.exports.signOnly(String(url || ''), base);
    return {
      ok: true,
      mode: 'frida_bridge',
      url: signed.url || url,
      headers: signed.headers || {},
      cookie_header: signed.cookie_header || '',
      cookies: signed.cookies || {},
      wire: signed.wire || null,
    };
  }

  async exportSession() {
    await this.ensure();
    return this.script.exports.exportSession();
  }

  async status() {
    if (!this.script) return { ok: false, attached: false };
    try {
      const st = await this.script.exports.status();
      return { ok: true, attached: true, pid: this.pid, ...st, mode: 'frida_bridge' };
    } catch (error) {
      return { ok: false, attached: false, error: String(error?.message || error) };
    }
  }

  async close() {
    if (this.script) {
      await this.script.unload().catch(() => {});
      this.script = null;
    }
    if (this.session) {
      await this.session.detach().catch(() => {});
      this.session = null;
    }
    this.pid = null;
  }
}

async function main() {
  const bridge = new FridaSignBridge();
  // Eager connect so /health reflects reality
  try {
    await bridge.ensure();
  } catch (error) {
    console.warn(`[metasec-sign-service] initial attach failed: ${error.message}`);
    console.warn('[metasec-sign-service] will retry on first /sign');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        const st = await bridge.status();
        return sendJson(res, st.ok ? 200 : 503, st);
      }
      if (req.method === 'POST' && url.pathname === '/sign') {
        const payload = await readJson(req);
        const result = await bridge.sign(payload.url, payload.headers || {}, payload.body || '');
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && url.pathname === '/export-session') {
        const exported = await bridge.exportSession();
        return sendJson(res, 200, { ok: true, ...exported });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        return sendJson(res, 200, {
          service: 'metasec-sign-service',
          mode: 'frida_bridge',
          endpoints: ['GET /health', 'POST /sign', 'POST /export-session'],
          note: 'Replace this process with unidbg-metasec for offline pure reverse',
        });
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message || error) });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[metasec-sign-service] listening http://${HOST}:${PORT}`);
    console.log('[metasec-sign-service] mode=frida_bridge (interim until Unidbg offline)');
  });

  const shutdown = async () => {
    console.log('\n[metasec-sign-service] shutting down');
    server.close();
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
