/**
 * Combined: attach Frida native-chain hooks, then navigate to product detail
 * to trigger /aweme/v2/shop/promotion/pack/
 *
 * Usage: node hook/capture-and-navigate.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import frida from 'frida';
import { _android as android } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const APP_ID = 'com.ss.android.ugc.livelite';
const SERIAL = process.env.MUMU_SERIAL || '127.0.0.1:16384';

const events = [];
const packRequests = [];
const signCalls = [];

async function main() {
  // ── 1. Connect to Frida ──
  console.log('[1/5] Connecting to Frida...');
  let device;
  try {
    device = await frida.getDevice(SERIAL, { timeout: 10_000 });
  } catch (e) {
    device = await frida.getDeviceManager().addRemoteDevice('127.0.0.1:27042', { timeout: 10_000 });
  }
  console.log('  Device:', device.name);

  // Find the app
  const apps = await device.enumerateApplications({ scope: 'full' });
  const app = apps.find((a) => a.identifier === APP_ID && a.pid !== 0);
  if (!app) throw new Error(APP_ID + ' not running');
  console.log('  App:', app.name, 'PID:', app.pid);

  // ── 2. Load and inject bundle ──
  console.log('[2/5] Injecting native-chain hooks...');
  const bundlePath = resolve(__dirname, 'native-chain.bundle.js');
  const agentSource = await readFile(bundlePath, 'utf8');
  const session = await device.attach(app.pid);
  const script = await session.createScript(agentSource);

  script.message.connect((message) => {
    if (message.type === 'send') {
      const payload = message.payload;
      if (typeof payload === 'string') {
        if (payload.includes('[RETROFIT') || payload.includes('[OKHTTP') || payload.includes('[URI SIGN')) {
          console.log('  ' + payload.trim());
        }
        events.push({ type: 'console', text: payload, ts: Date.now() });
        return;
      }
      if (payload && typeof payload === 'object') {
        events.push(payload);
        if (payload.type === 'pack-request') {
          packRequests.push(payload);
          console.log('\n📦 [PACK] ' + payload.method + ' ' + payload.url);
          console.log('   Sign headers:', payload.signHeaderNames?.join(', ') || 'none');
        }
        if (payload.type === 'sign-param') {
          signCalls.push(payload);
          console.log('🔑 [SIGN] ' + payload.name + ' (len=' + payload.valueLength + ')');
        }
        if (payload.type === 'hook-ready') console.log('✅ ' + payload.target);
        if (payload.type === 'hook-failed') console.log('⚠️ ' + payload.target);
      }
    }
  });

  await script.load();
  console.log('  Hooks injected. Waiting for Java VM...');
  await new Promise((r) => setTimeout(r, 5000)); // Wait for Java hooks to initialize

  // ── 3. Navigate via Playwright Android (using proven crawler patterns) ──
  console.log('[3/5] Navigating to Golden Goose product detail...');
  const androidDevices = await android.devices({ host: '127.0.0.1', port: 5037 });
  const androidDevice = androidDevices.find((d) => d.serial() === SERIAL);
  if (!androidDevice) throw new Error('Playwright Android device not found: ' + SERIAL);

  try {
    androidDevice.setDefaultTimeout(8_000);

    // Use the same patterns as src/android.mjs
    const screen = { width: 900, height: 1600 };

    // Ensure app is in foreground
    console.log('  Bringing app to foreground...');
    await androidDevice.shell('input keyevent 3'); // HOME
    await new Promise((r) => setTimeout(r, 500));
    await androidDevice.shell('monkey -p com.ss.android.ugc.livelite -c android.intent.category.LAUNCHER 1');
    await new Promise((r) => setTimeout(r, 3000));

    // Tap home tab (bottom-left)
    console.log('  Tapping home tab...');
    await androidDevice.shell('input tap 90 1560');
    await new Promise((r) => setTimeout(r, 1500));

    // Tap search bar (top area, right of center)
    console.log('  Tapping search area...');
    await androidDevice.shell('input tap 200 96');
    await new Promise((r) => setTimeout(r, 1000));

    // Type "golden goose" using the working %s convention
    console.log('  Typing: golden goose');
    const searchText = 'golden%sgoose';
    await androidDevice.shell('input text ' + searchText);
    await new Promise((r) => setTimeout(r, 500));

    // Press Enter to search
    await androidDevice.shell('input keyevent 66');
    console.log('  Waiting for results...');
    await new Promise((r) => setTimeout(r, 5000));

    // Tap on a product card (center area)
    console.log('  Opening first product...');
    await androidDevice.shell('input tap 450 650');
    await new Promise((r) => setTimeout(r, 5000));

    // Check if we're on a product detail or still searching
    const actCheck = await androidDevice.shell('dumpsys activity activities | grep topResumedActivity | head -1');
    console.log('  Activity: ' + actCheck.toString().trim().slice(0, 120));

    // Go back and re-enter to trigger fresh /pack/
    console.log('  Back + re-open for fresh /pack/ request...');
    await androidDevice.shell('input keyevent 4'); // BACK
    await new Promise((r) => setTimeout(r, 2000));
    await androidDevice.shell('input tap 450 650'); // Tap product again
    await new Promise((r) => setTimeout(r, 5000));

  } catch (navErr) {
    console.log('  Navigation error: ' + navErr.message);
  } finally {
    await Promise.allSettled(androidDevices.map((d) => d.close()));
  }

  // ── 4. Wait for capture ──
  console.log('[4/5] Waiting for capture events...');
  await new Promise((r) => setTimeout(r, 8000));

  // ── 5. Save and shutdown ──
  console.log('[5/5] Saving capture...');
  try { await script.unload(); } catch (e) { /* ignore */ }
  try { await session.detach(); } catch (e) { /* ignore */ }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = resolve(PROJECT_ROOT, 'output', `native-sign-capture-${ts}.json`);
  await mkdir(resolve(PROJECT_ROOT, 'output'), { recursive: true });

  const capture = {
    capturedAt: new Date().toISOString(),
    appId: APP_ID,
    pid: app.pid,
    serial: SERIAL,
    summary: {
      totalEvents: events.length,
      packRequests: packRequests.length,
      signCalls: signCalls.length,
    },
    packRequests,
    signCalls,
  };

  await writeFile(outputPath, JSON.stringify(capture, null, 2), 'utf8');
  console.log('\n✅ Capture saved:', outputPath);
  console.log('📊 Pack requests:', packRequests.length);
  console.log('📊 Sign calls:', signCalls.length);

  if (packRequests.length === 0) {
    console.log('\n⚠️ No /pack/ requests captured. The app may not have reached ProductDetailActivity.');
    console.log('   Check if the navigation coordinates are correct for this MuMu instance.');
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
