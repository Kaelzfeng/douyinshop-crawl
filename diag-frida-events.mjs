/**
 * Diagnostic: capture ALL Frida events while user opens ONE product.
 * Run: node diag-frida-events.mjs
 * Then: manually open a product in the app
 * Output: output/frida-events-diag.json
 */
import frida from 'frida';
import fs from 'fs';
import { execSync } from 'child_process';

const appPid = execSync('adb -s emulator-5554 shell pidof com.ss.android.ugc.livelite').toString().trim();
console.log('App PID:', appPid);

const device = await frida.getDeviceManager().addRemoteDevice('127.0.0.1:27042');
const session = await device.attach(Number(appPid));
const bundle = fs.readFileSync('hook/capture-semi.bundle.js', 'utf8');
const script = await session.createScript(bundle);

const events = [];
script.message.connect(m => {
  if (m.type === 'send') {
    events.push({ ...m.payload, _ts: Date.now() });
    const p = m.payload;
    if (!['ready', 'hooked', 'agent-loaded'].includes(p.type)) {
      console.log('[EVENT]', p.type, JSON.stringify(p).slice(0, 150));
    } else {
      console.log('[' + p.type + ']', p.target || '');
    }
  }
});

await script.load();
console.log('\n=== NOW OPEN A PRODUCT IN THE APP ===');
console.log('Waiting 30 seconds...\n');
await new Promise(r => setTimeout(r, 30000));

// Analyze
const productEvents = events.filter(e => e.type === 'product-captured');
const relevantRaw = events.filter(e =>
  ['uri-parse', 'url-init', 'form-field', 'okhttp-request', 'bd-retrofit-request',
   'okhttp-response', 'clipboard', 'webview-load-url', 'webview-override-url',
   'intent-extra', 'okhttp-newcall', 'request-header'].includes(e.type)
);

console.log('\n=== RESULTS ===');
console.log('Total events:', events.length);
console.log('Product-captured:', productEvents.length);
console.log('Relevant raw events:', relevantRaw.length);

if (productEvents.length > 0) {
  console.log('\nProduct events:');
  productEvents.forEach(e => console.log(JSON.stringify(e, null, 2).slice(0, 500)));
} else {
  console.log('\nNO PRODUCT EVENTS — showing all relevant raw events:');
  relevantRaw.forEach(e => {
    const { _ts, _receivedAt, ts, ...rest } = e;
    console.log(JSON.stringify(rest).slice(0, 300));
  });
}

fs.writeFileSync('output/frida-events-diag.json', JSON.stringify({ productEvents, relevantRaw, allEvents: events }, null, 2));
console.log('\nFull dump saved to output/frida-events-diag.json');

await script.unload();
await session.detach();
