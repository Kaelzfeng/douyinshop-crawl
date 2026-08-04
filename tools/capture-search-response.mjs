#!/usr/bin/env node
/**
 * Phase 1: Capture a complete raw search API response via Frida RPC.
 *
 * Connects to the running Douyin Mall app, makes one search request for "ggdb"
 * via the app's internal network stack, and saves the full response.
 *
 * Usage:
 *   node tools/capture-search-response.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import frida from 'frida';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'output', 'direct-search');
const BUNDLE = path.join(ROOT, 'hook', 'direct-search-agent.bundle.js');
const REQUEST_SAMPLE = path.join(OUT_DIR, 'request-sample.json');
const RESPONSE_SAMPLE = path.join(OUT_DIR, 'response-sample.json');
const HEADER_CLASSIFICATION = path.join(OUT_DIR, 'header-classification.md');

const SEARCH_URL_BASE = 'https://ecom.ecombdapi.com/aweme/v3/shop/search/aggregate/shopping/stream/';

// Static device parameters from known-good session
const STATIC_PARAMS = {
  iid: '3454002414781424',
  device_id: '3700291608266259',
  ac: 'wifi',
  channel: 'huawei_561124_64',
  aid: '561124',
  app_name: 'douyinecommerce',
  version_code: '390600',
  version_name: '39.6.0',
  device_platform: 'android',
  os: 'android',
  ssmix: 'a',
  device_type: 'MI 5s',
  device_brand: 'Xiaomi',
  language: 'zh',
  os_api: '35',
  os_version: '15',
  manifest_version_code: '390601',
  resolution: '900*1600',
  dpi: '240',
  update_version_code: '39609900',
  package: 'com.ss.android.ugc.livelite',
  mcc_mnc: '46000',
  first_launch_timestamp: '1784347027',
  last_deeplink_update_version_code: '39609900',
  cpu_support64: 'true',
  host_abi: 'arm64-v8a',
  is_guest_mode: '0',
  app_type: 'normal',
  minor_status: '0',
  appTheme: 'light',
  is_preinstall: '0',
  need_personal_recommend: '1',
  is_android_pad: '0',
  is_android_fold: '0',
};

// Dynamic params that change each request
const cdid = '1921388f-1cdc-4639-b4da-7cccbfe0dcae';
const klink_egdi = 'AAKnjetLF-f7tX5bmBTodVF8RbvQmjJ-iCJck8FNYiUF3JqrpadUdDrm';

function buildSearchUrl(cursor = '0', count = 8) {
  const ts = Math.floor(Date.now() / 1000);
  const _rticket = Date.now();

  const params = new URLSearchParams({
    ...STATIC_PARAMS,
    klink_egdi,
    cdid,
    ts: String(ts),
    _rticket: String(_rticket),
  });

  return `${SEARCH_URL_BASE}?${params.toString()}`;
}

function buildSearchBody(keyword, cursor = '0', count = 8) {
  const params = new URLSearchParams({
    cursor,
    count: String(count),
    keyword,
    query_correct_type: '1',
    search_channel: 'search_order_center',
    search_source: 'normal_search',
    search_scene: 'douyin_search',
    shown_count: '0',
  });
  return params.toString();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('[capture] Loading Frida bundle:', BUNDLE);
  const bundleSource = fs.readFileSync(BUNDLE, 'utf8');
  console.log('[capture] Bundle size:', bundleSource.length, 'bytes');

  // Connect to device
  const devices = await frida.enumerateDevices();
  console.log('[capture] Available devices:', devices.map(d => `${d.id} (${d.type})`).join(', '));

  const device = devices.find(d => d.id === 'emulator-5554' || d.type === 'usb');
  if (!device) throw new Error('No device found');

  console.log('[capture] Using device:', device.id);

  const processes = await device.enumerateProcesses({ scope: 'full' });
  const proc = processes.find(p =>
    (p.parameters?.applications || []).includes('com.ss.android.ugc.livelite'),
  ) || processes.find(p => (p.name || '').includes('livelite'));

  if (!proc) throw new Error('Douyin Mall process not found');
  console.log('[capture] Attaching to PID:', proc.pid, 'name:', proc.name);

  const session = await device.attach(proc.pid);
  const script = await session.createScript(bundleSource);

  await script.load();
  console.log('[capture] Script loaded');

  // Check status
  const status = await script.exports.status();
  console.log('[capture] Signer status:', JSON.stringify(status));

  // Build the search request
  const url = buildSearchUrl('0', 8);
  const body = buildSearchBody('ggdb', '0', 8);

  console.log('[capture] Search URL length:', url.length);
  console.log('[capture] Search body:', body);

  // Save the request sample
  const requestSample = {
    method: 'POST',
    url,
    body,
    body_parsed: Object.fromEntries(new URLSearchParams(body)),
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(REQUEST_SAMPLE, JSON.stringify(requestSample, null, 2), 'utf8');
  console.log('[capture] Request sample saved to:', REQUEST_SAMPLE);

  // Make the search request via app proxy
  console.log('[capture] Sending search request via app proxy...');
  const startTime = Date.now();
  const response = await script.exports.search(url, body, {});
  const elapsed = Date.now() - startTime;

  console.log('[capture] Response received in', elapsed, 'ms');
  console.log('[capture] HTTP status:', response.status);
  console.log('[capture] Response body length:', (response.body || '').length);

  // Save the response sample
  let parsedBody = null;
  let parseError = null;
  try {
    parsedBody = JSON.parse(response.body);
  } catch (e) {
    parseError = e.message;
  }

  const responseSample = {
    http_status: response.status,
    response_headers: response.headers || {},
    body_length: (response.body || '').length,
    body_preview: (response.body || '').substring(0, 2000),
    body_parsed: parsedBody,
    body_parse_error: parseError,
    elapsed_ms: elapsed,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(RESPONSE_SAMPLE, JSON.stringify(responseSample, null, 2), 'utf8');
  console.log('[capture] Response sample saved to:', RESPONSE_SAMPLE);

  // Analyze the response structure
  if (parsedBody) {
    console.log('\n=== Response Structure Analysis ===');
    console.log('Top-level keys:', Object.keys(parsedBody).join(', '));

    // Look for cursor/has_more
    const findInObj = (obj, prefix = '') => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const fullPath = prefix ? `${prefix}.${k}` : k;
        if (k === 'cursor' || k === 'has_more' || k === 'next_cursor' || k === 'hasMore') {
          console.log(`  ${fullPath} = ${JSON.stringify(v)}`);
        }
        if (k === 'status_code' || k === 'code' || k === 'status_msg' || k === 'message') {
          console.log(`  ${fullPath} = ${JSON.stringify(v)}`);
        }
        if (Array.isArray(v)) {
          console.log(`  ${fullPath} = array[${v.length}]`);
          if (v.length > 0) {
            if (typeof v[0] === 'object') {
              console.log(`    First item keys: ${Object.keys(v[0]).join(', ')}`);
            } else {
              console.log(`    First item: ${JSON.stringify(v[0]).substring(0, 100)}`);
            }
          }
        }
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          findInObj(v, fullPath);
        }
      }
    };
    findInObj(parsedBody);

    // Count products
    const countProducts = (obj) => {
      if (!obj || typeof obj !== 'object') return 0;
      if (obj.ProductID || obj.product_id || obj.productId) return 1;
      if (Array.isArray(obj)) {
        return obj.reduce((sum, item) => sum + countProducts(item), 0);
      }
      return Object.values(obj).reduce((sum, v) => sum + (typeof v === 'object' ? countProducts(v) : 0), 0);
    };
    const productCount = countProducts(parsedBody);
    console.log(`\n  Estimated product count: ${productCount}`);
  } else {
    console.log('\n=== Raw Response (first 1000 chars) ===');
    console.log((response.body || '').substring(0, 1000));
  }

  // Generate header classification
  const headerMd = `# Search API Header Classification

## Request
- **Method**: POST
- **URL**: ${SEARCH_URL_BASE}
- **Body**: application/x-www-form-urlencoded

## URL Query Parameters

### Static Device Fields
${Object.entries(STATIC_PARAMS).map(([k, v]) => `- \`${k}\`: \`${v}\``).join('\n')}

### Semi-static (change per session)
- \`klink_egdi\`: device registration token
- \`cdid\`: device unique ID

### Per-request Dynamic
- \`ts\`: Unix timestamp (seconds)
- \`_rticket\`: Millisecond timestamp

## POST Body Parameters
- \`cursor\`: pagination cursor (0 = first page)
- \`count\`: items per page
- \`keyword\`: search keyword
- \`query_correct_type\`: query correction flag
- \`search_channel\`: search channel identifier
- \`search_source\`: source of the search
- \`search_scene\`: scene identifier
- \`shown_count\`: count already shown to user

## Response
- HTTP Status: ${response.status}
- Body type: ${parsedBody ? 'JSON' : 'non-JSON'}
- Body length: ${(response.body || '').length}

### Response Headers
${Object.entries(response.headers || {}).map(([k, v]) => `- \`${k}\`: \`${v}\``).join('\n')}
`;

  fs.writeFileSync(HEADER_CLASSIFICATION, headerMd, 'utf8');
  console.log('[capture] Header classification saved to:', HEADER_CLASSIFICATION);

  // Cleanup
  await script.unload();
  await session.detach();
  console.log('[capture] Done.');
}

main().catch((err) => {
  console.error('[capture] Fatal error:', err.stack || err);
  process.exitCode = 1;
});
