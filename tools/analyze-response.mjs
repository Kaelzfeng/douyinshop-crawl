#!/usr/bin/env node
/**
 * Re-capture a search response, dechunk it, and analyze the structure.
 * Saves full raw response and parsed JSON for inspection.
 */
import fs from 'node:fs';
import path from 'node:path';
import frida from 'frida';

const OUT_DIR = path.resolve('output/direct-search');
const BUNDLE = path.resolve('hook/direct-search-agent.bundle.js');

function dechunk(raw) {
  // Standard HTTP chunked transfer encoding decoder.
  // Each chunk: <size-hex>\r\n<data>\r\n
  // Final chunk: 0\r\n\r\n
  let out = '';
  let pos = 0;
  while (pos < raw.length) {
    // Find the end of the chunk-size line
    let crlf = raw.indexOf('\r\n', pos);
    if (crlf < 0) { out += raw.substring(pos); break; }

    const sizeLine = raw.substring(pos, crlf);
    // Handle optional chunk extensions (size;ext=val)
    const sizeHex = sizeLine.split(';')[0].trim();
    const chunkSize = parseInt(sizeHex, 16);
    if (!isFinite(chunkSize)) { out += raw.substring(pos); break; }
    if (chunkSize === 0) break; // final chunk

    pos = crlf + 2; // skip \r\n after size line
    // Read chunk data
    out += raw.substring(pos, pos + chunkSize);
    pos += chunkSize;
    // Skip trailing \r\n after chunk data
    if (pos + 1 < raw.length && raw[pos] === '\r' && raw[pos + 1] === '\n') pos += 2;
  }
  return out;
}

function analyze(obj, prefix = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  if (Array.isArray(obj)) {
    console.log(`${prefix}: array[${obj.length}]`);
    if (obj.length > 0 && typeof obj[0] === 'object') {
      console.log(`${prefix}[0] keys: ${Object.keys(obj[0]).slice(0, 25).join(', ')}`);
      analyze(obj[0], `${prefix}[0]`, depth + 1);
    }
    return;
  }
  const cursorKeys = ['cursor', 'has_more', 'next_cursor', 'hasMore', 'total_count', 'totalCount', 'log_pb', 'status_code', 'status_msg'];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (cursorKeys.includes(k)) {
      console.log(`${p} = ${JSON.stringify(v)}`);
    } else if (typeof v === 'object' && v !== null) {
      analyze(v, p, depth + 1);
    }
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const bundleSource = fs.readFileSync(BUNDLE, 'utf8');
  const devices = await frida.enumerateDevices();
  const device = devices.find(d => d.id === 'emulator-5554');
  const processes = await device.enumerateProcesses({ scope: 'full' });
  const proc = processes.find(p =>
    (p.parameters?.applications || []).includes('com.ss.android.ugc.livelite'),
  );

  const session = await device.attach(proc.pid);
  const script = await session.createScript(bundleSource);
  await script.load();

  // Build search request
  const ts = Math.floor(Date.now() / 1000);
  const rt = Date.now();
  const params = new URLSearchParams({
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
    klink_egdi: 'AAKnjetLF-f7tX5bmBTodVF8RbvQmjJ-iCJck8FNYiUF3JqrpadUdDrm',
    cdid: '1921388f-1cdc-4639-b4da-7cccbfe0dcae',
    ts: String(ts), _rticket: String(rt),
  });
  const url = `https://ecom.ecombdapi.com/aweme/v3/shop/search/aggregate/shopping/stream/?${params.toString()}`;
  const body = 'cursor=0&count=8&keyword=ggdb&query_correct_type=1&search_channel=search_order_center&search_source=normal_search&search_scene=douyin_search&shown_count=0';

  console.log('[analyze] Sending search request...');
  const resp = await script.exports.search(url, body, {});
  console.log(`[analyze] Status: ${resp.status}, Body length: ${resp.body.length}`);

  // Check if chunked
  const isChunked = /^[0-9a-fA-F]+\r?\n/.test(resp.body);
  console.log(`[analyze] Is chunked: ${isChunked}`);

  // Save raw
  fs.writeFileSync(path.join(OUT_DIR, 'raw-response.txt'), resp.body, 'utf8');
  console.log(`[analyze] Saved raw: ${resp.body.length} bytes`);

  // Dechunk if needed
  const cleanBody = isChunked ? dechunk(resp.body) : resp.body;
  console.log(`[analyze] Dechunked length: ${cleanBody.length}`);
  fs.writeFileSync(path.join(OUT_DIR, 'dechunked-response.json'), cleanBody.substring(0, 500000), 'utf8');

  // Parse as stream of JSON documents (one per chunk)
  const documents = [];
  let docStart = 0;
  while (docStart < cleanBody.length) {
    // Skip whitespace
    while (docStart < cleanBody.length && /\s/.test(cleanBody[docStart])) docStart++;
    if (docStart >= cleanBody.length) break;

    // Find the end of this JSON document
    let depth = 0;
    let inString = false;
    let escaped = false;
    let docEnd = -1;
    for (let i = docStart; i < cleanBody.length; i++) {
      const ch = cleanBody[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else {
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { docEnd = i + 1; break; } }
        else if (ch === '[') depth++;
        else if (ch === ']') depth--;
      }
    }
    if (docEnd < 0) break;

    try {
      const doc = JSON.parse(cleanBody.substring(docStart, docEnd));
      documents.push(doc);
    } catch (e) {
      console.error(`[analyze] Parse error for document at ${docStart}: ${e.message}`);
    }
    docStart = docEnd;
  }

  console.log(`\n=== Response Structure ===`);
  console.log(`Parsed ${documents.length} JSON documents`);

  let allProducts = [];
  let cursorInfo = {};

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    console.log(`\n--- Document ${i + 1} ---`);
    console.log(`Top-level keys: ${Object.keys(doc).join(', ')}`);
    console.log(`status_code: ${doc.status_code}`);

    if (doc.page_data) {
      const pdKeys = Object.keys(doc.page_data);
      console.log(`page_data keys: ${pdKeys.join(', ')}`);

      // Look for cursor/has_more
      if (doc.cursor !== undefined) cursorInfo.cursor = doc.cursor;
      if (doc.has_more !== undefined) cursorInfo.has_more = doc.has_more;
      if (doc.log_pb) console.log(`log_pb present: ${JSON.stringify(doc.log_pb).substring(0, 200)}`);

      // Count products in this document
      let docProductCount = 0;
      function countP(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (obj.product_id || obj.ProductID) {
          docProductCount++;
          allProducts.push({
            id: String(obj.product_id || obj.ProductID),
            title: String(obj.Title || obj.title || ''),
            price: obj.Price ?? obj.price ?? '',
          });
        }
        if (Array.isArray(obj)) obj.forEach(countP);
        else Object.values(obj).forEach(v => { if (typeof v === 'object') countP(v); });
      }
      countP(doc);
      console.log(`Products in this doc: ${docProductCount}`);
    }

    // Deep search for cursor/has_more
    function findCursor(obj, prefix, depth) {
      if (!obj || typeof obj !== 'object' || depth > 8) return;
      for (const [k, v] of Object.entries(obj)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (['cursor', 'has_more', 'next_cursor', 'hasMore', 'total_count', 'totalCount', 'log_pb'].includes(k)) {
          console.log(`  ${p} = ${JSON.stringify(typeof v === 'string' ? v.substring(0, 200) : v)}`);
          if (k === 'cursor' && !cursorInfo.cursor) cursorInfo.cursor = v;
          if (k === 'has_more' && cursorInfo.has_more === undefined) cursorInfo.has_more = v;
          if (k === 'next_cursor') cursorInfo.next_cursor = v;
        }
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) findCursor(v, p, depth + 1);
      }
    }
    findCursor(doc, '', 0);
  }

  // Deduplicate products by ID
  const seen = new Set();
  const uniqueProducts = allProducts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  console.log(`\n=== Summary ===`);
  console.log(`Total product cards (all docs): ${allProducts.length}`);
  console.log(`Unique product IDs: ${uniqueProducts.length}`);
  console.log(`Cursor info:`, JSON.stringify(cursorInfo));
  console.log(`First 5 unique products:`);
  uniqueProducts.slice(0, 5).forEach(p => console.log(`  ${p.id} | ${p.title.substring(0, 50)} | ${p.price}`));

  // Save documents
  for (let i = 0; i < Math.min(documents.length, 3); i++) {
    fs.writeFileSync(
      path.join(OUT_DIR, `doc-${i + 1}.json`),
      JSON.stringify(documents[i], null, 2).substring(0, 500000),
      'utf8',
    );
  }
  console.log('[analyze] Saved parsed documents');

  await script.unload();
  await session.detach();
  console.log('[analyze] Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
