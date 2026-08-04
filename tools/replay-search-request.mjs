#!/usr/bin/env node
/**
 * Phase 2: Replay a captured search request and verify it still works.
 *
 * Takes the request-sample.json from Phase 1 and replays it via
 * the Frida app-proxy to confirm the request format is valid.
 *
 * Then tests cursor modification to determine if signature is body-dependent.
 *
 * Usage:
 *   node tools/replay-search-request.mjs                          # replay cursor=0
 *   node tools/replay-search-request.mjs --cursor 8               # change cursor
 *   node tools/replay-search-request.mjs --keyword 小脏鞋          # change keyword
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import frida from 'frida';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'output', 'direct-search');
const BUNDLE = path.join(ROOT, 'hook', 'direct-search-agent.bundle.js');
const REQUEST_SAMPLE = path.join(OUT_DIR, 'request-sample.json');

async function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { cursor: '', keyword: '', count: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cursor' && args[i + 1]) opts.cursor = args[++i];
    else if (args[i] === '--keyword' && args[i + 1]) opts.keyword = args[++i];
    else if (args[i] === '--count' && args[i + 1]) opts.count = args[++i];
  }
  return opts;
}

async function connectFrida() {
  const bundleSource = fs.readFileSync(BUNDLE, 'utf8');
  const devices = await frida.enumerateDevices();
  const device = devices.find(d => d.id === 'emulator-5554' || d.type === 'usb');
  if (!device) throw new Error('No device found');

  const processes = await device.enumerateProcesses({ scope: 'full' });
  const proc = processes.find(p =>
    (p.parameters?.applications || []).includes('com.ss.android.ugc.livelite'),
  ) || processes.find(p => (p.name || '').includes('livelite'));
  if (!proc) throw new Error('Douyin Mall not running');

  const session = await device.attach(proc.pid);
  const script = await session.createScript(bundleSource);
  await script.load();
  return { session, script, proc };
}

async function replayRequest(script, url, body, label) {
  console.log(`\n=== ${label} ===`);
  console.log(`URL (first 120 chars): ${url.substring(0, 120)}...`);
  console.log(`Body: ${body}`);

  const startTime = Date.now();
  const resp = await script.exports.search(url, body, {});
  const elapsed = Date.now() - startTime;

  console.log(`HTTP Status: ${resp.status}`);
  console.log(`Response length: ${(resp.body || '').length}`);
  console.log(`Elapsed: ${elapsed}ms`);

  let parsed = null;
  try { parsed = JSON.parse(resp.body); } catch (e) {
    console.log(`PARSE ERROR: ${e.message}`);
    console.log(`Raw (first 500): ${(resp.body || '').substring(0, 500)}`);
    return { status: resp.status, ok: false, error: 'JSON parse failed' };
  }

  // Check business status
  const statusCode = parsed.status_code ?? parsed.code ?? -1;
  console.log(`Business status: ${statusCode}`);
  if (statusCode !== 0) {
    console.log(`Status message: ${parsed.status_msg || parsed.message || ''}`);
    console.log(`Response body (first 500): ${JSON.stringify(parsed).substring(0, 500)}`);
  }

  // Look for cursor info
  const findCursorInfo = (obj, prefix = '', depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 8) return;
    for (const [k, v] of Object.entries(obj)) {
      const fullPath = prefix ? `${prefix}.${k}` : k;
      if (['cursor', 'has_more', 'next_cursor', 'hasMore', 'total_count', 'totalCount'].includes(k)) {
        console.log(`  ${fullPath} = ${JSON.stringify(v)}`);
      }
      if (typeof v === 'object' && v !== null) {
        findCursorInfo(v, fullPath, depth + 1);
      }
    }
  };
  console.log('Cursor/has_more paths:');
  findCursorInfo(parsed);

  // Count products
  let productCount = 0;
  const countProducts = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 10) return;
    if (obj.ProductID || obj.product_id || obj.productId) {
      productCount += 1;
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach(item => countProducts(item, depth + 1));
      return;
    }
    Object.values(obj).forEach(v => {
      if (typeof v === 'object') countProducts(v, depth + 1);
    });
  };
  countProducts(parsed);
  console.log(`Product cards found: ${productCount}`);

  // Show first 3 product IDs
  const ids = [];
  const collectIds = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 10 || ids.length >= 5) return;
    if (obj.ProductID) ids.push(String(obj.ProductID));
    else if (obj.product_id) ids.push(String(obj.product_id));
    else if (obj.productId) ids.push(String(obj.productId));
    if (Array.isArray(obj)) obj.forEach(item => collectIds(item, depth + 1));
    else Object.values(obj).forEach(v => { if (typeof v === 'object') collectIds(v, depth + 1); });
  };
  collectIds(parsed);
  console.log(`Sample product_ids: ${ids.join(', ')}`);

  return {
    status: resp.status,
    businessStatus: statusCode,
    ok: resp.status === 200 && statusCode === 0,
    productCount,
    sampleIds: ids,
    bodyLength: (resp.body || '').length,
    elapsedMs: elapsed,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const overrides = await parseArgs();

  console.log('[replay] Connecting to Frida...');
  const { session, script, proc } = await connectFrida();
  console.log(`[replay] Connected to PID ${proc.pid}`);

  // Load request template
  let template;
  if (fs.existsSync(REQUEST_SAMPLE)) {
    template = JSON.parse(fs.readFileSync(REQUEST_SAMPLE, 'utf8'));
    console.log('[replay] Loaded request template');
  } else {
    // Build from known parameters
    console.log('[replay] No request template found, building from known params');
    const STATIC_PARAMS = {
      iid: '3454002414781424', device_id: '3700291608266259', ac: 'wifi',
      channel: 'huawei_561124_64', aid: '561124', app_name: 'douyinecommerce',
      version_code: '390600', version_name: '39.6.0', device_platform: 'android',
      os: 'android', ssmix: 'a', device_type: 'MI 5s', device_brand: 'Xiaomi',
      language: 'zh', os_api: '35', os_version: '15', manifest_version_code: '390601',
      resolution: '900*1600', dpi: '240', update_version_code: '39609900',
      package: 'com.ss.android.ugc.livelite', mcc_mnc: '46000',
      first_launch_timestamp: '1784347027', last_deeplink_update_version_code: '39609900',
      cpu_support64: 'true', host_abi: 'arm64-v8a', is_guest_mode: '0',
      app_type: 'normal', minor_status: '0', appTheme: 'light', is_preinstall: '0',
      need_personal_recommend: '1', is_android_pad: '0', is_android_fold: '0',
    };
    const ts = Math.floor(Date.now() / 1000);
    const _rticket = Date.now();
    const params = new URLSearchParams({
      ...STATIC_PARAMS,
      klink_egdi: 'AAKnjetLF-f7tX5bmBTodVF8RbvQmjJ-iCJck8FNYiUF3JqrpadUdDrm',
      cdid: '1921388f-1cdc-4639-b4da-7cccbfe0dcae',
      ts: String(ts), _rticket: String(_rticket),
    });
    template = {
      method: 'POST',
      url: `https://ecom.ecombdapi.com/aweme/v3/shop/search/aggregate/shopping/stream/?${params.toString()}`,
      body: 'cursor=0&count=8&keyword=ggdb&query_correct_type=1&search_channel=search_order_center&search_source=normal_search&search_scene=douyin_search&shown_count=0',
    };
  }

  let url = template.url;
  let body = template.body;
  const bodyParams = new URLSearchParams(body);

  if (overrides.cursor) {
    console.log(`[replay] Overriding cursor: ${overrides.cursor}`);
    bodyParams.set('cursor', overrides.cursor);
    // Also update the cursor param in URL if present
    const urlObj = new URL(url);
    urlObj.searchParams.set('ts', String(Math.floor(Date.now() / 1000)));
    urlObj.searchParams.set('_rticket', String(Date.now()));
    url = urlObj.toString();
    body = bodyParams.toString();
  }

  if (overrides.keyword) {
    console.log(`[replay] Overriding keyword: ${overrides.keyword}`);
    bodyParams.set('keyword', overrides.keyword);
    body = bodyParams.toString();
  }

  if (overrides.count) {
    console.log(`[replay] Overriding count: ${overrides.count}`);
    bodyParams.set('count', overrides.count);
    body = bodyParams.toString();
  }

  // Test 1: Original cursor=0
  const result1 = await replayRequest(script, url, body, 'Test: Original request');

  if (result1.ok) {
    console.log('\n✅ Original request SUCCEEDED');
  } else {
    console.log('\n❌ Original request FAILED');
    console.log('Troubleshooting: Check app login state, network, and signer health');
  }

  // Test 2: Modify cursor
  if (result1.ok && !overrides.cursor) {
    bodyParams.set('cursor', '8');
    body = bodyParams.toString();
    const result2 = await replayRequest(script, url, body, 'Test: Modified cursor=8');
    if (result2.ok) {
      console.log('\n✅ Cursor modification SUCCEEDED — signature is NOT cursor-dependent');
    } else {
      console.log('\n⚠️ Cursor modification FAILED — signature may be body-dependent');
    }
  }

  // Summary
  console.log('\n=== REPLAY SUMMARY ===');
  console.log(`App PID: ${proc.pid}`);
  console.log(`Sign mode: app_proxy (app makes HTTP request internally)`);
  console.log(`First page: ${result1.ok ? 'PASS' : 'FAIL'}`);
  console.log(`Products found: ${result1.productCount}`);
  console.log(`Sample IDs: ${result1.sampleIds?.join(', ') || 'none'}`);

  await script.unload();
  await session.detach();
  console.log('[replay] Done.');
}

main().catch((err) => {
  console.error('[replay] Fatal:', err.stack || err);
  process.exitCode = 1;
});
