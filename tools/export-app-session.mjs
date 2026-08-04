#!/usr/bin/env node
/**
 * Export cookies + device candidates from a live Douyin Mall process (Frida).
 *
 * Usage:
 *   node tools/export-app-session.mjs
 *   node tools/export-app-session.mjs --session output/session.json --device-params output/device-params.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDirectSearchClient } from '../src/direct-search-client.mjs';
import { saveSession } from '../src/session.mjs';
import { mapDeviceCandidates, saveDeviceParams, FALLBACK_STATIC_PARAMS, FALLBACK_SESSION_PARAMS } from '../src/device-params.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {
    serial: 'emulator-5554',
    session: path.join(ROOT, 'output', 'session.json'),
    deviceParams: path.join(ROOT, 'output', 'device-params.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--serial' && argv[i + 1]) opts.serial = argv[++i];
    else if (argv[i] === '--session' && argv[i + 1]) opts.session = path.resolve(argv[++i]);
    else if (argv[i] === '--device-params' && argv[i + 1]) opts.deviceParams = path.resolve(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') opts.help = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node tools/export-app-session.mjs [--serial id] [--session path] [--device-params path]`);
    return;
  }

  const client = await createDirectSearchClient({
    serial: opts.serial,
    signMode: 'app_proxy',
  });

  try {
    const exported = await client.exportSessionFromApp();
    const sessionPath = saveSession({
      exported_at: exported.exported_at || Date.now(),
      package: exported.package,
      cookie_header: exported.cookie_header,
      cookies: exported.cookies,
      device_candidates: exported.device_candidates,
      tokens: {},
    }, opts.session);

    const mapped = mapDeviceCandidates(exported.device_candidates || {});
    const devicePath = saveDeviceParams({
      exported_at: Date.now(),
      source: 'frida_export_session',
      static: {
        ...FALLBACK_STATIC_PARAMS,
        ...(mapped.device_id ? { device_id: mapped.device_id } : {}),
        ...(mapped.iid ? { iid: mapped.iid } : {}),
      },
      session: {
        ...FALLBACK_SESSION_PARAMS,
        ...(mapped.cdid ? { cdid: mapped.cdid } : {}),
        ...(mapped.klink_egdi ? { klink_egdi: mapped.klink_egdi } : {}),
      },
    }, opts.deviceParams);

    const wirePath = path.join(ROOT, 'output', 'direct-search', 'wire-headers-sample.json');
    if (exported.last_wire) {
      fs.mkdirSync(path.dirname(wirePath), { recursive: true });
      fs.writeFileSync(wirePath, `${JSON.stringify(exported.last_wire, null, 2)}\n`, 'utf8');
    }

    console.log(JSON.stringify({
      ok: true,
      session: sessionPath,
      device_params: devicePath,
      cookie_keys: Object.keys(exported.cookies || {}).length,
      device_candidates: Object.keys(exported.device_candidates || {}).length,
      wire: exported.last_wire ? wirePath : null,
    }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[export-app-session]', err.stack || err);
  process.exitCode = 1;
});
