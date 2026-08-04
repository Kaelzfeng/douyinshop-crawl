#!/usr/bin/env node
import { createDirectSearchClient, parseSearchResponse } from '../src/direct-search-client.mjs';
import fs from 'node:fs';

async function main() {
  const client = await createDirectSearchClient({ serial: 'emulator-5554', useAppProxy: true });

  // Make the search request and get raw body from app proxy
  const frida = await import('frida');
  const devices = await frida.enumerateDevices();
  const device = devices.find(d => d.id === 'emulator-5554');
  const processes = await device.enumerateProcesses({ scope: 'full' });
  const proc = processes.find(p =>
    (p.parameters?.applications || []).includes('com.ss.android.ugc.livelite'));
  const session = await device.attach(proc.pid);
  const bundle = fs.readFileSync('hook/direct-search-agent.bundle.js', 'utf8');
  const script = await session.createScript(bundle);
  await script.load();

  // Build request
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

  console.log('Sending request...');
  const resp = await script.exports.search(url, body, {});
  console.log('HTTP status:', resp.status);
  console.log('Body length:', resp.body.length);
  console.log('Body starts with:', JSON.stringify(resp.body.substring(0, 100)));

  // Save full raw body
  fs.mkdirSync('output/direct-search', { recursive: true });
  fs.writeFileSync('output/direct-search/debug-raw.txt', resp.body);
  console.log('Saved raw body to debug-raw.txt');

  // Dechunk
  function dechunk(raw) {
    const docs = [];
    let pos = 0;
    while (pos < raw.length) {
      const crlf = raw.indexOf('\r\n', pos);
      if (crlf < 0) break;
      const sizeHex = raw.substring(pos, crlf).split(';')[0].trim();
      const chunkSize = parseInt(sizeHex, 16);
      if (!isFinite(chunkSize) || chunkSize === 0) break;
      pos = crlf + 2;
      const data = raw.substring(pos, pos + chunkSize);
      pos += chunkSize;
      if (raw[pos] === '\r') pos++;
      if (raw[pos] === '\n') pos++;
      try { docs.push(JSON.parse(data)); } catch (e) {
        console.log(`Chunk parse error at pos ${pos - chunkSize}: ${e.message}`);
        console.log(`Data starts: ${data.substring(0, 80)}`);
        console.log(`Data ends: ${data.substring(data.length - 80)}`);
      }
    }
    return docs;
  }

  const docs = dechunk(resp.body);
  console.log('Dechunked documents:', docs.length);

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    console.log(`\nDoc ${i}: status=${doc.status_code}`);
    const keys = Object.keys(doc);
    console.log(`  Keys: ${keys.join(', ')}`);

    if (doc.page_data) {
      const pd = doc.page_data;
      console.log(`  page_data: ${Object.keys(pd).join(', ')}`);
      if (pd.feed_layer) {
        const fl = pd.feed_layer;
        console.log(`  feed_layer: ${Object.keys(fl).join(', ')}`);
        if (fl.sections) {
          for (let s = 0; s < Math.min(fl.sections.length, 3); s++) {
            const sec = fl.sections[s];
            console.log(`  section[${s}]: id=${sec.section_id} items=${(sec.items||[]).length}`);
            if (sec.items && sec.items.length > 0) {
              const first = sec.items[0];
              console.log(`    item[0] type: ${first.result_type || 'N/A'}`);
              // Deep search for products
              let count = 0;
              function findP(obj, d) {
                if (!obj || typeof obj !== 'object' || d > 12 || count > 5) return;
                if ((obj.ProductID || obj.product_id || obj.productId) && (obj.Title || obj.title)) {
                  count++;
                  if (count <= 2) console.log(`    Found: ${obj.ProductID || obj.product_id} "${(obj.Title || obj.title || '').substring(0, 50)}"`);
                }
                if (Array.isArray(obj)) obj.forEach(v => findP(v, d+1));
                else Object.values(obj).forEach(v => { if (typeof v === 'object') findP(v, d+1); });
              }
              findP(first, 0);
              if (count === 0) console.log('    (no products found recursively)');
            }
          }
        }
      }
    }

    // Cursor/has_more
    if (doc.cursor !== undefined) console.log(`  cursor: ${doc.cursor}`);
    if (doc.has_more !== undefined) console.log(`  has_more: ${doc.has_more}`);
    if (doc.next_cursor !== undefined) console.log(`  next_cursor: ${doc.next_cursor}`);
    if (doc.log_pb) console.log(`  log_pb: ${JSON.stringify(doc.log_pb)}`);

    // Deep search for cursor/has_more anywhere
    function findCursor(obj, d) {
      if (!obj || typeof obj !== 'object' || d > 8) return;
      for (const [k, v] of Object.entries(obj)) {
        if (['cursor', 'has_more', 'next_cursor', 'hasMore'].includes(k)) {
          console.log(`  DEEP ${k}=${JSON.stringify(v)}`);
        }
        if (typeof v === 'object' && v !== null) findCursor(v, d+1);
      }
    }
    findCursor(doc, 0);
  }

  // Now try parseSearchResponse
  console.log('\n=== Testing parseSearchResponse ===');
  const parsed = parseSearchResponse(resp.body, '0');
  console.log('Products found:', parsed.products.length);
  console.log('HasMore:', parsed.hasMore);
  console.log('NextCursor:', parsed.nextCursor);
  console.log('Document count:', parsed.documentCount);

  if (parsed.products.length > 0) {
    console.log('\nFirst 3 products:');
    for (const p of parsed.products.slice(0, 3)) {
      console.log(`  ${p.product_id} | ${p.product_name?.substring(0, 40)} | ${p.shop_name} | ${p.price} | ${p.sales}`);
    }
  }

  await script.unload();
  await session.detach();
  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
