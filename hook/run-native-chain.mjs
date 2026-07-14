/**
 * Run the native-chain Frida script against Douyin Mall on MuMu.
 *
 * Injects the compiled frida-java-bridge bundle and captures:
 *   - Retrofit2 Request.Builder.build() calls to /aweme/v2/shop/promotion/pack/
 *   - Native libmetasec_ml.so sign function calls (via RegisterNatives)
 *
 * Prerequisites:
 *   - frida-server running on MuMu
 *   - npm run build:native-chain (compiles the bundle)
 *
 * Usage:
 *   node hook/run-native-chain.mjs                          # attach to running app
 *   node hook/run-native-chain.mjs --spawn                  # spawn fresh
 *   node hook/run-native-chain.mjs --output capture.json    # custom output
 *   node hook/run-native-chain.mjs --no-redact              # include full URLs in output
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import frida from 'frida';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const APP_ID = 'com.ss.android.ugc.livelite';
const DEFAULT_SERIAL = process.env.MUMU_SERIAL || '127.0.0.1:16384';

function parseArgs(argv) {
  const args = { spawn: false, output: null, serial: DEFAULT_SERIAL, noRedact: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--spawn') args.spawn = true;
    else if (argv[i] === '--output' && argv[i + 1]) args.output = argv[++i];
    else if (argv[i] === '--serial' && argv[i + 1]) args.serial = argv[++i];
    else if (argv[i] === '--no-redact') args.noRedact = true;
  }
  if (!args.output) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    args.output = resolve(PROJECT_ROOT, 'output', `native-sign-capture-${ts}.json`);
  }
  return args;
}

/**
 * Strip query string values from a URL, keeping only parameter names.
 * Turns "https://host/path?a_bogus=secret&id=123" into
 * "https://host/path?a_bogus&id"
 */
function redactUrlQueryValues(url) {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.keys()];
    u.search = '';
    for (const k of params) {
      u.searchParams.append(k, '');
    }
    // Remove trailing = signs left by empty values
    return u.toString().replace(/=&/g, '&').replace(/=$/, '');
  } catch {
    // If URL parsing fails, strip everything after ? entirely
    const q = url.indexOf('?');
    return q > 0 ? url.slice(0, q) + '?...' : url;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('[Runner] Configuration:');
  console.log('  Serial:', args.serial);
  console.log('  Mode:', args.spawn ? 'spawn' : 'attach');
  console.log('  Output:', args.output);
  console.log('  Redact URLs:', !args.noRedact);

  // Load the compiled bundle
  const bundlePath = resolve(__dirname, 'native-chain.bundle.js');
  let agentSource;
  try {
    agentSource = await readFile(bundlePath, 'utf8');
  } catch (e) {
    console.error('[Runner] Bundle not found:', bundlePath);
    console.error('[Runner] Run: npm run build:native-chain');
    process.exit(1);
  }
  console.log('[Runner] Bundle loaded:', bundlePath, '(' + (agentSource.length / 1024).toFixed(0) + ' KB)');

  // Connect to Frida device
  console.log('[Runner] Connecting to Frida device via serial:', args.serial);
  let device;
  try {
    device = await frida.getDevice(args.serial, { timeout: 15_000 });
  } catch (e) {
    console.log('[Runner] getDevice failed: ' + e.message.slice(0, 100));
    console.log('[Runner] Trying addRemoteDevice(127.0.0.1:27042)...');
    try {
      device = await frida.getDeviceManager().addRemoteDevice('127.0.0.1:27042', { timeout: 10_000 });
    } catch (e2) {
      console.error('[Runner] Cannot connect to Frida.');
      console.error('  Ensure frida-server is running on MuMu:');
      console.error('    adb -s ' + args.serial + ' shell "ps -A | grep fsrv"');
      console.error('  Direct error:', e.message.slice(0, 120));
      console.error('  Remote error:', e2.message.slice(0, 120));
      process.exit(1);
    }
  }
  console.log('[Runner] Connected to:', device.name, '(type:', device.type + ')');

  // Attach or spawn
  let pid;
  let spawned = false;
  let processName = APP_ID;

  if (args.spawn) {
    pid = await device.spawn(APP_ID);
    spawned = true;
    console.log('[Runner] Spawned ' + APP_ID + ' suspended (PID: ' + pid + ')');
  } else {
    const apps = await device.enumerateApplications({ scope: 'full' });
    const app = apps.find((a) => a.identifier === APP_ID && a.pid !== 0);
    if (!app) {
      console.error('[Runner] ' + APP_ID + ' is not running.');
      console.error('[Runner] Start the app on MuMu or use --spawn.');
      // List what's available
      const running = apps.filter((a) => a.pid !== 0).slice(0, 10);
      console.error('[Runner] Running apps: ' + running.map((a) => a.identifier + ' (' + a.name + ')').join(', '));
      process.exit(1);
    }
    pid = app.pid;
    processName = app.name;
    console.log('[Runner] Attaching to ' + app.name + ' (PID: ' + pid + ')');
  }

  const session = await device.attach(pid);
  console.log('[Runner] Session attached. Realm: native');

  // Collect events. Structured events have a .type property.
  // console.log messages arrive as plain strings in payload.
  const events = [];
  const packRequests = [];
  const signCalls = [];
  const hookStatus = { success: [], failed: [] };

  session.detached.connect((reason, crash) => {
    console.error('[Runner] ⚠️ Session detached! Reason:', reason);
    if (crash) console.error('[Runner] Crash:', crash);
    events.push({ type: 'session-detached', reason: reason, crash: String(crash || ''), ts: new Date().toISOString() });
  });

  const script = await session.createScript(agentSource);

  script.message.connect((message) => {
    if (message.type === 'send') {
      const payload = message.payload;

      // Handle console.log messages (arrive as plain strings)
      if (typeof payload === 'string') {
        // Filter out noisy console.log lines, keep important ones
        const line = payload.trim();
        if (line && (
          line.startsWith('[RETROFIT') || line.startsWith('[OKHTTP') ||
          line.startsWith('[BaseSsCall') || line.startsWith('[URI SIGN') ||
          line.startsWith('[SIGN NATIVE') || line.startsWith('[NATIVE') ||
          line.startsWith('[JAVA]') || line.startsWith('[JNI_OnLoad') ||
          line.startsWith('[DLOPEN') || line.includes('RegisterNatives') ||
          line.startsWith('[NATIVE-CHAIN]') || line.includes('→ ')
        )) {
          console.log('  ' + line);
        }
        events.push({ type: 'console', text: line, ts: Date.now() });
        return;
      }

      // Handle structured send() events
      if (payload && typeof payload === 'object') {
        events.push(payload);

        switch (payload.type) {
          case 'pack-request': {
            // Redact URL query values for safe output
            const displayUrl = args.noRedact ? payload.url : redactUrlQueryValues(payload.url || '');
            packRequests.push({
              ...payload,
              url: displayUrl,
              _urlIsRedacted: !args.noRedact,
            });
            console.log('\n📦 [PACK] ' + (payload.method || '?') + ' ' + displayUrl);
            if (payload.signHeaderNames && payload.signHeaderNames.length > 0) {
              console.log('   Sign headers: ' + payload.signHeaderNames.join(', '));
            }
            if (payload.headerNames && payload.headerNames.length > 0) {
              console.log('   All headers (' + payload.headerNames.length + '): ' +
                payload.headerNames.filter((h) => !payload.signHeaderNames?.includes(h)).join(', '));
            }
            if (payload.bodyInfo && payload.bodyInfo.present) {
              console.log('   Body: present, hasPromotionIds=' + payload.bodyInfo.hasPromotionIds +
                ', len=' + payload.bodyInfo.length);
            }
            break;
          }

          case 'sign-param':
            signCalls.push(payload);
            console.log('🔑 [SIGN] ' + payload.source + ': ' + payload.name +
              ' (len=' + payload.valueLength + ')');
            break;

          case 'sign-call':
            signCalls.push(payload);
            console.log('🔧 [NATIVE SIGN] ' + payload.fnName + ' @' + payload.module);
            break;

          case 'sign-result':
            console.log('   → result len=' + payload.resultLength + ' (' + payload.elapsedMs + 'ms)');
            break;

          case 'jni-registered':
            console.log('📋 [JNI] ' + payload.name + ' in ' + payload.module);
            break;

          case 'hook-ready':
            hookStatus.success.push(payload.target);
            console.log('✅ ' + payload.target);
            break;

          case 'hook-failed':
            hookStatus.failed.push({ target: payload.target, error: payload.error });
            console.log('⚠️ ' + payload.target + ' — ' + String(payload.error || '').slice(0, 100));
            break;

          case 'agent-loaded':
            console.log('🚀 Agent loaded: PID=' + payload.pid + ' arch=' + payload.arch);
            if (payload.opts) {
              console.log('   Opts: ' + JSON.stringify(payload.opts));
            }
            break;

          case 'module-found':
            console.log('📚 ' + payload.name + ' base=' + payload.base +
              ' size=' + (payload.size / 1024).toFixed(0) + 'KB exports=' + payload.exportsCount);
            break;

          case 'jni-onload':
            console.log('📎 JNI_OnLoad: ' + payload.library);
            break;

          case 'jni-onload-return':
            console.log('   → JNI_VERSION=' + payload.jniVersion);
            break;

          case 'library-loading':
            console.log('📚 Loading: ' + payload.library);
            break;

          case 'status':
            console.log('📊 [' + payload.uptimeSeconds + 's] ' +
              payload.requestsCaptured + ' requests, ' +
              payload.signCallsCaptured + ' sign calls');
            break;

          case 'hook-error':
            console.log('❌ Hook error [' + payload.layer + ']: ' + String(payload.error || '').slice(0, 100));
            break;

          default:
            // Log unrecognized structured events for debugging
            if (payload.type && !['session-detached', 'console', 'turing-bypass'].includes(payload.type)) {
              console.log('  [event:' + payload.type + ']');
            }
            break;
        }
      }
    } else if (message.type === 'error') {
      const errMsg = message.stack || message.description || String(message);
      console.error('[Agent Error]', errMsg.slice(0, 200));
      events.push({ type: 'agent-error', stack: message.stack, description: message.description, ts: new Date().toISOString() });
    }
  });

  await script.load();
  console.log('[Runner] Script loaded.');

  if (spawned) {
    await device.resume(pid);
    console.log('[Runner] App resumed (PID: ' + pid + ')');
  }

  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║  🟢 Native chain hooks ACTIVE                 ║');
  console.log('║                                              ║');
  console.log('║  1. Open Douyin Mall on MuMu                 ║');
  console.log('║  2. Search "golden goose"                    ║');
  console.log('║  3. Tap a product → ProductDetailActivity    ║');
  console.log('║  4. Go BACK to results, then re-open product ║');
  console.log('║     (ensures hooks catch the /pack/ request) ║');
  console.log('║  5. Press Ctrl+C to stop & save              ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  // Handle shutdown
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('\n[Runner] Shutting down...');

    try { await script.unload(); } catch (e) { /* ignore */ }
    try { await session.detach(); } catch (e) { /* ignore */ }

    // Final status
    console.log('[Runner] Hook status: ' + hookStatus.success.length + ' succeeded, ' + hookStatus.failed.length + ' failed');
    if (hookStatus.failed.length > 0) {
      console.log('[Runner] Failed hooks:');
      for (const f of hookStatus.failed) {
        console.log('  - ' + f.target + ': ' + String(f.error || '').slice(0, 80));
      }
    }

    // Build capture artifact
    const capture = {
      capturedAt: new Date().toISOString(),
      appId: APP_ID,
      processName: processName,
      pid: pid,
      serial: args.serial,
      spawnMode: spawned,
      urlRedacted: !args.noRedact,
      summary: {
        totalEvents: events.length,
        packRequests: packRequests.length,
        signCalls: signCalls.length,
        hookSuccessCount: hookStatus.success.length,
        hookFailedCount: hookStatus.failed.length,
      },
      hookStatus: hookStatus,
      packRequests: packRequests,
      signCalls: signCalls,
      events: events.slice(-500), // Keep last 500 events to limit file size
    };

    await mkdir(resolve(PROJECT_ROOT, 'output'), { recursive: true });
    await writeFile(args.output, JSON.stringify(capture, null, 2), 'utf8');
    console.log('\n[Runner] ✅ Capture saved: ' + args.output);
    console.log('[Runner] 📊 ' + packRequests.length + ' pack requests, ' + signCalls.length + ' sign calls');
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.resume();
}

main().catch((e) => {
  console.error('[Runner] Fatal:', e.message);
  console.error(e.stack);
  process.exit(1);
});
