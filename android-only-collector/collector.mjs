#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { deriveCanonicalEvents, makeEvent, ProductShareCorrelator } from './events.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFrida() {
  const roots = [
    process.env.DOUYIN_CRAWLER_ROOT,
    process.cwd(),
    'E:\\douyin-golden-goose-crawler',
  ].filter(Boolean);

  let lastError;
  for (const root of [...new Set(roots)]) {
    if (!fs.existsSync(root)) continue;
    try {
      return createRequire(path.join(root, 'package.json'))('frida');
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(
    `Unable to load the Node Frida package. Set DOUYIN_CRAWLER_ROOT to the workspace containing node_modules/frida.${detail}`,
  );
}

const frida = loadFrida();
const DEFAULT_PACKAGE = 'com.ss.android.ugc.livelite';
const DEFAULT_SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const DEFAULT_FRIDA_HOST = process.env.FRIDA_HOST || '127.0.0.1:27042';
const DEFAULT_AGENT = path.join(__dirname, 'agent.bundle.js');

function parseOptions(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      serial: { type: 'string', default: DEFAULT_SERIAL },
      'frida-host': { type: 'string', default: DEFAULT_FRIDA_HOST },
      package: { type: 'string', default: DEFAULT_PACKAGE },
      pid: { type: 'string' },
      db: { type: 'string', default: 'output/android-only.sqlite' },
      events: { type: 'string', default: 'output/android-only-events.jsonl' },
      'window-ms': { type: 'string', default: '60000' },
      agent: { type: 'string', default: DEFAULT_AGENT },
      debug: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  return {
    ...values,
    windowMs: Number(values['window-ms']),
  };
}

function helpText() {
  return `Android-only MuMu + ADB + Frida collector

Usage:
  node android-only-collector/collector.mjs [options]

Options:
  --serial <id>          Frida device id (default: ${DEFAULT_SERIAL})
  --frida-host <host>   Remote Frida host (default: ${DEFAULT_FRIDA_HOST})
  --package <name>      Android package (default: ${DEFAULT_PACKAGE})
  --pid <pid>           Attach to an explicit process id
  --db <path>           SQLite output (default: output/android-only.sqlite)
  --events <path>       JSONL output (default: output/android-only-events.jsonl)
  --window-ms <ms>      Product/share correlation window (default: 60000)
  --agent <path>        Frida agent source
  --debug               Runtime debug output only; never derives product_found
  -h, --help            Show this help

The process stays attached until Ctrl+C. JSONL stdout contains only structured events.
`;
}

function resolvePath(value) {
  return path.resolve(process.cwd(), value);
}

function buildAgentSource(agentSource, debug) {
  if (!debug) return agentSource;

  // Prefer changing the compiled constant in memory.  frida-compile emits a
  // metadata header before the JavaScript body; injecting a statement around
  // that header can make Frida parse the bundle incorrectly.
  const debugAssignment = agentSource.match(
    /((?:const|let|var)\s+DEBUG_MODE\s*=\s*)([^;]+)(;)/,
  );
  if (debugAssignment) {
    // Keep the compiled package byte-for-byte the same length.  The Frida
    // bundle header carries the package size, so a shorter replacement is
    // rejected as a malformed package.
    const rhs = debugAssignment[2];
    const paddedTrue = `true${' '.repeat(Math.max(0, rhs.length - 4))}`;
    const compiled = agentSource.replace(
      debugAssignment[0],
      `${debugAssignment[1]}${paddedTrue.slice(0, rhs.length)}${debugAssignment[3]}`,
    );
    if (compiled !== agentSource) return compiled;
  }

  const debugFlag = 'globalThis.__ANDROID_COLLECTOR_DEBUG__ = true;\n';
  return `${debugFlag}${agentSource}`;
}

export function createCollectorStats() {
  return {
    totalCollected: 0,
    validProducts: 0,
    missingProductId: 0,
    missingPrice: 0,
    duplicates: 0,
    linked: 0,
    events: 0,
    writeFailures: 0,
    productIds: new Set(),
  };
}

export function observeCollectorEvent(stats, event) {
  if (!stats || !event?.event) return;
  stats.events += 1;
  if (event.event === 'product_share_linked') stats.linked += 1;
  if (event.event !== 'product_found') return;

  stats.totalCollected += 1;
  const productId = String(event.product_id || '').trim();
  if (!productId) {
    stats.missingProductId += 1;
  } else if (stats.productIds.has(productId)) {
    stats.duplicates += 1;
  } else {
    stats.productIds.add(productId);
  }
  if (!String(event.price || '').trim()
      && !String(event.min_price || '').trim()
      && !String(event.max_price || '').trim()) {
    stats.missingPrice += 1;
  }
  stats.validProducts = stats.productIds.size;
}

export function snapshotCollectorStats(stats, extra = {}) {
  return {
    total_collected: stats?.totalCollected || 0,
    valid_products: stats?.productIds?.size || stats?.validProducts || 0,
    missing_product_id: stats?.missingProductId || 0,
    missing_price: stats?.missingPrice || 0,
    duplicates: stats?.duplicates || 0,
    product_share_linked: stats?.linked || 0,
    events: stats?.events || 0,
    write_failures: stats?.writeFailures || 0,
    ...extra,
  };
}

export function printCollectorStats(stats, output = process.stdout) {
  const value = stats && Object.prototype.hasOwnProperty.call(stats, 'total_collected')
    ? stats
    : snapshotCollectorStats(stats);
  output.write([
    '--- Android collector stats ---',
    `总采集数量: ${value.total_collected}`,
    `有效商品: ${value.valid_products}`,
    `缺 product_id: ${value.missing_product_id}`,
    `缺价格: ${value.missing_price}`,
    `重复数量: ${value.duplicates}`,
    `product_share_linked: ${value.product_share_linked}`,
    `SQLite 写入失败: ${value.write_failures}`,
  ].join('\n') + '\n');
}

function safeJson(value) {
  const seen = new WeakSet();
  try {
    const result = JSON.stringify(value, (_key, candidate) => {
      if (typeof candidate === 'bigint') return String(candidate);
      if (!candidate || typeof candidate !== 'object') return candidate;
      if (seen.has(candidate)) return '[Circular]';
      seen.add(candidate);
      return candidate;
    });
    return result === undefined ? 'null' : result;
  } catch (error) {
    return JSON.stringify({
      serialization_error: String(error?.message || error),
      value: String(value),
    });
  }
}

function createJsonlSink(eventsPath, { mirrorStdout = true } = {}) {
  const absolutePath = resolvePath(eventsPath);
  const failurePath = `${absolutePath}.failed`;
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const stream = fs.createWriteStream(absolutePath, { flags: 'a', encoding: 'utf8' });
  stream.on('error', (error) => {
    try {
      fs.appendFileSync(failurePath, `${JSON.stringify({
        ts: Date.now(),
        error: String(error?.stack || error),
      })}\n`, 'utf8');
    } catch (_) {}
  });
  return {
    path: absolutePath,
    failurePath,
    write(event) {
      try {
        const line = `${safeJson(event)}\n`;
        stream.write(line);
        if (mirrorStdout) process.stdout.write(line);
        return true;
      } catch (error) {
        try {
          fs.appendFileSync(failurePath, `${safeJson({
            ts: Date.now(),
            error: String(error?.stack || error),
            event,
          })}\n`, 'utf8');
        } catch (_) {}
        return false;
      }
    },
    close() {
      return new Promise((resolve) => stream.end(resolve));
    },
  };
}

function applicationMatches(processInfo, packageName) {
  const applications = processInfo?.parameters?.applications;
  if (Array.isArray(applications) && applications.includes(packageName)) return true;
  const name = String(processInfo?.name || '');
  return name === packageName || name.includes('livelite');
}

async function resolveDevice({ serial, fridaHost }) {
  const devices = await frida.enumerateDevices();
  const exact = devices.find((device) => device.id === serial);
  if (exact) return exact;

  if (serial === 'emulator-5554') {
    const knownRemote = devices.find((device) => device.id === fridaHost);
    if (knownRemote) return knownRemote;
  }

  const usb = devices.find((device) => device.type === 'usb');
  if (usb && serial === 'usb') return usb;

  return frida.getDeviceManager().addRemoteDevice(fridaHost);
}

async function resolveProcess(device, { packageName, pid }) {
  const processes = await device.enumerateProcesses({ scope: 'full' });
  if (pid) {
    const requested = Number(pid);
    const found = processes.find((processInfo) => processInfo.pid === requested);
    if (!found) throw new Error(`Process PID ${pid} was not found on Frida device ${device.id}`);
    return found;
  }
  const found = processes.find((processInfo) => applicationMatches(processInfo, packageName));
  if (!found) {
    throw new Error(`Process ${packageName} was not found. Start Douyin Mall before attaching.`);
  }
  return found;
}

export async function createAndroidCollector(options = {}) {
  const { SQLiteEventStore } = await import('./sqlite-store.mjs');
  const runId = options.runId || randomUUID();
  const dbPath = options.db || 'output/android-only.sqlite';
  const eventsPath = options.events || 'output/android-only-events.jsonl';
  const store = new SQLiteEventStore({ dbPath, runId });
  const sink = createJsonlSink(eventsPath, { mirrorStdout: options.stdout !== false });
  const correlator = new ProductShareCorrelator({
    runId,
    windowMs: Number.isFinite(options.windowMs) ? options.windowMs : 60_000,
  });
  const stats = createCollectorStats();
  let closed = false;
  let session = null;
  let script = null;

  const record = (event) => {
    observeCollectorEvent(stats, event);
    const stored = store.record(event);
    if (!stored) stats.writeFailures += 1;
    sink.write(event);
    return event;
  };

  try {
    const device = await resolveDevice({
      serial: options.serial || DEFAULT_SERIAL,
      fridaHost: options.fridaHost || DEFAULT_FRIDA_HOST,
    });
    const processInfo = await resolveProcess(device, {
      packageName: options.packageName || options.package || DEFAULT_PACKAGE,
      pid: options.pid,
    });
    session = await device.attach(processInfo.pid);
    const agentPath = resolvePath(options.agent || DEFAULT_AGENT);
    const agentSource = fs.readFileSync(agentPath, 'utf8');
    const scriptSource = buildAgentSource(agentSource, options.debug);
    script = await session.createScript(scriptSource);

    const handleEvent = (event) => {
      record(event);
      try {
        for (const linked of correlator.accept(event)) record(linked);
      } catch (error) {
        record(makeEvent({
          run_id: runId,
          event: 'collector_error',
          stage: 'event_processing',
          source: 'collector',
          pid: processInfo.pid,
          value: String(error?.stack || error),
        }));
      }
    };

    script.message.connect((message, data) => {
      const receivedAt = Date.now();
      if (message.type === 'send') {
        const payload = message.payload && typeof message.payload === 'object'
          ? message.payload
          : { value: String(message.payload ?? '') };
        if (options.debug
          && payload.debug !== true
          && !/^(agent_loaded|ready|hooked|hook_failed|hook_error)$/.test(String(payload.stage || ''))) {
          return;
        }
        try {
          for (const event of deriveCanonicalEvents(payload, {
            runId,
            receivedAt,
            pid: processInfo.pid,
          })) {
            handleEvent(event);
          }
        } catch (error) {
          handleEvent(makeEvent({
            run_id: runId,
            event: 'collector_error',
            stage: 'payload_parse',
            source: 'collector',
            pid: processInfo.pid,
            value: String(error?.stack || error),
          }));
        }
        return;
      }

      if (message.type === 'error') {
        handleEvent(makeEvent({
          run_id: runId,
          event: 'frida_error',
          stage: 'script_error',
          source: 'frida',
          ts: receivedAt,
          pid: processInfo.pid,
          value: String(message.stack || message.description || 'unknown Frida error'),
          raw: { message, data: data ? String(data) : '' },
        }));
      }
    });

    await script.load();
    handleEvent(makeEvent({
      run_id: runId,
      event: 'collector_status',
      stage: 'attached',
      source: 'collector',
      pid: processInfo.pid,
      value: `device=${device.id} process=${processInfo.name || ''}`,
      db_path: store.dbPath,
      events_path: sink.path,
    }));

    const close = async () => {
      if (closed) return snapshotCollectorStats(stats, { sqlite: store.stats() });
      closed = true;
      await script.unload().catch(() => {});
      await session.detach().catch(() => {});
      store.close();
      await sink.close();
      return snapshotCollectorStats(stats, { sqlite: store.stats() });
    };

    return {
      runId,
      device,
      processInfo,
      session,
      script,
      store,
      eventsPath: sink.path,
      dbPath: store.dbPath,
      stats,
      getStats: () => snapshotCollectorStats(stats, { sqlite: store.stats() }),
      close,
    };
  } catch (error) {
    if (script) await script.unload().catch(() => {});
    if (session) await session.detach().catch(() => {});
    store.close();
    await sink.close();
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  const collector = await createAndroidCollector({
    ...options,
    packageName: options.package,
  });
  const stop = async () => {
    const stats = await collector.close();
    printCollectorStats(stats);
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise(() => {});
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`[android-only] ${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
