import { readFile } from 'node:fs/promises';
import frida from 'frida';
import { _android as android } from 'playwright';

const APP_ID = 'com.ss.android.ugc.livelite';
const SERIAL = process.env.MUMU_SERIAL || '127.0.0.1:16384';
const spawnMode = process.argv.includes('--spawn');
const agentSource = await readFile(new URL('./enable-webview-debug.bundle.js', import.meta.url), 'utf8');

const fridaDevice = await frida.getDevice(SERIAL, { timeout: 10_000 });
let pid;
let spawned = false;

if (spawnMode) {
  pid = await fridaDevice.spawn(APP_ID);
  spawned = true;
  console.log(`[Frida] Spawned ${APP_ID} suspended as PID ${pid}`);
} else {
  const apps = await fridaDevice.enumerateApplications();
  const app = apps.find((candidate) => candidate.identifier === APP_ID && candidate.pid !== 0);
  if (!app) throw new Error(`${APP_ID} is not running; start it or pass --spawn`);
  pid = app.pid;
  console.log(`[Frida] Attaching to ${app.name} as PID ${pid}`);
}

const session = await fridaDevice.attach(pid);
session.detached.connect((reason, crash) => {
  console.error('[Frida] Session detached', reason, crash || '');
});
const script = await session.createScript(agentSource);
script.message.connect((message) => {
  if (message.type === 'send') console.log('[Agent]', JSON.stringify(message.payload));
  else if (message.type === 'error') console.error('[Agent error]', message.stack || message.description);
});
await script.load();

if (spawned) {
  await fridaDevice.resume(pid);
  console.log(`[Frida] Resumed PID ${pid}`);
}

const androidDevices = await android.devices({ host: '127.0.0.1', port: 5037 });
const androidDevice = androidDevices.find((candidate) => candidate.serial() === SERIAL);
if (!androidDevice) throw new Error(`Playwright could not find Android device ${SERIAL}`);

const attached = new Set();

async function installPageProbe(page) {
  await page.evaluate(() => {
    if (window.__aBogusProbeInstalled) return;
    window.__aBogusProbeInstalled = true;

    const report = (source, url) => {
      if (!/a_bogus|verifyFp/i.test(String(url))) return;
      console.log('[A_BOGUS_PROBE]' + JSON.stringify({
        source,
        url: String(url),
        stack: new Error().stack,
      }));
    };

    const originalFetch = window.fetch;
    if (originalFetch) {
      window.fetch = function(input) {
        report('fetch', typeof input === 'string' ? input : input?.url);
        return originalFetch.apply(this, arguments);
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      report(`xhr:${method}`, url);
      return originalOpen.apply(this, arguments);
    };

    for (const method of ['append', 'set']) {
      const original = URLSearchParams.prototype[method];
      URLSearchParams.prototype[method] = function(name, value) {
        if (/^(a_bogus|verifyFp)$/i.test(String(name))) {
          report(`URLSearchParams.${method}`, `${name}=${value}`);
        }
        return original.apply(this, arguments);
      };
    }
  });
}

async function attachWebView(webView) {
  const key = `${webView.pkg()}:${webView.pid()}`;
  if (attached.has(key)) return;
  attached.add(key);

  console.log(`[WebView] Discovered ${key}`);
  try {
    const page = await webView.page();
    console.log(`[WebView] Connected ${key} url=${page.url()}`);

    page.on('request', (request) => {
      const url = request.url();
      if (!/a_bogus|verifyFp|jinritemai\.com\/aweme/i.test(url)) return;
      console.log('[REQUEST]', JSON.stringify({
        webView: key,
        method: request.method(),
        url,
        postData: request.postData(),
      }));
    });

    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('[A_BOGUS_PROBE]')) console.log('[JS]', text.slice('[A_BOGUS_PROBE]'.length));
    });

    await installPageProbe(page).catch((error) => {
      console.error(`[WebView] Probe injection failed for ${key}: ${error.message}`);
    });
    page.on('domcontentloaded', () => installPageProbe(page).catch(() => {}));
  } catch (error) {
    attached.delete(key);
    console.error(`[WebView] Connection failed for ${key}: ${error.message}`);
  }
}

androidDevice.on('webview', (webView) => void attachWebView(webView));
for (const webView of androidDevice.webViews()) void attachWebView(webView);

console.log('[Ready] Open a product detail page in Douyin Mall. Press Ctrl+C to stop.');

async function close() {
  await Promise.allSettled([
    script.unload(),
    session.detach(),
    ...androidDevices.map((device) => device.close()),
  ]);
}

process.on('SIGINT', () => void close().finally(() => process.exit(0)));
process.stdin.resume();
