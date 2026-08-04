#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createAndroidCollector,
  printCollectorStats,
} from './collector.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
      agent: { type: 'string', default: DEFAULT_AGENT },
      'window-ms': { type: 'string', default: '60000' },
      'retry-ms': { type: 'string', default: '5000' },
      debug: { type: 'boolean', default: false },
      once: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  return {
    ...values,
    windowMs: Number(values['window-ms']),
    retryMs: Number(values['retry-ms']),
  };
}

function helpText() {
  return `Android-only collector runner

Usage:
  node android-only-collector/collector-runner.mjs [options]

Options:
  --serial <id>          Frida device id (default: ${DEFAULT_SERIAL})
  --frida-host <host>   Frida remote host (default: ${DEFAULT_FRIDA_HOST})
  --package <name>      Android package (default: ${DEFAULT_PACKAGE})
  --pid <pid>           Attach to an explicit process id
  --agent <path>        Agent bundle (default: android-only-collector/agent.bundle.js)
  --db <path>           SQLite output (default: output/android-only.sqlite)
  --events <path>       JSONL output (default: output/android-only-events.jsonl)
  --window-ms <ms>      Product/share correlation window
  --retry-ms <ms>       Reconnect delay after process/session loss
  --debug               Runtime debug mode
  --once                Exit after the first attach session ends
  -h, --help            Show this help
`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

let stopping = false;
let activeCollector = null;
let wakeWaiter = null;

function requestStop() {
  stopping = true;
  if (wakeWaiter) wakeWaiter('signal');
}

function waitForSessionEnd(collector, { pollMs = 1000, maxPollErrors = 3 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let polling = false;
    let pollErrors = 0;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      wakeWaiter = null;
      resolve(reason || 'detached');
    };
    wakeWaiter = finish;
    if (stopping) {
      finish('signal');
      return;
    }
    try {
      collector.session.detached.connect((reason) => finish(`detached:${reason || 'unknown'}`));
    } catch (_) {
      // Ctrl+C remains a valid stop path even if this Frida binding has no signal.
    }

    const pollProcess = async () => {
      if (settled || polling) return;
      polling = true;
      try {
        if (collector.session?.isDetached === true) {
          finish('session-detached');
          return;
        }
        const processes = await collector.device.enumerateProcesses({ scope: 'full' });
        const pid = Number(collector.processInfo?.pid);
        const alive = processes.some((item) => Number(item.pid) === pid);
        if (!alive) {
          finish('process-exited');
          return;
        }
        pollErrors = 0;
      } catch (error) {
        pollErrors += 1;
        if (pollErrors >= maxPollErrors) {
          finish(`process-poll-failed:${error?.message || error}`);
          return;
        }
      } finally {
        polling = false;
        if (!settled) timer = setTimeout(pollProcess, Math.max(250, pollMs));
      }
    };

    timer = setTimeout(pollProcess, Math.max(250, pollMs));
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);

  while (!stopping) {
    try {
      process.stderr.write(`[collector-runner] attaching ${options.package}\n`);
      activeCollector = await createAndroidCollector({
        ...options,
        packageName: options.package,
      });
      process.stderr.write(
        `[collector-runner] attached pid=${activeCollector.processInfo.pid} agent=${options.agent}\n`,
      );

      const reason = await waitForSessionEnd(activeCollector);
      const stats = await activeCollector.close();
      printCollectorStats(stats, process.stderr);
      activeCollector = null;
      if (stopping || options.once) break;
      process.stderr.write(`[collector-runner] session ${reason}; retrying\n`);
    } catch (error) {
      if (activeCollector) {
        await activeCollector.close().catch(() => {});
        activeCollector = null;
      }
      if (stopping) break;
      process.stderr.write(`[collector-runner] ${error?.stack || error}\n`);
      if (options.once) break;
    }

    if (!stopping && !options.once) await sleep(Number.isFinite(options.retryMs) ? options.retryMs : 5000);
  }
}

main().catch((error) => {
  process.stderr.write(`[collector-runner] fatal: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
