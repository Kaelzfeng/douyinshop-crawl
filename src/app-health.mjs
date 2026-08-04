/**
 * App health monitoring and soft recovery for Douyin Mall.
 *
 * Provides crash detection, safe restart (NO force-stop), and
 * human-like inter-product cooldown pacing.
 *
 * All crawl modes import this via re-exports from android.mjs.
 */

const PACKAGE_NAME = 'com.ss.android.ugc.livelite';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Process health
// ---------------------------------------------------------------------------

/**
 * Check if the Douyin Mall process is alive.
 * Fast (~50ms via ADB shell pidof).
 *
 * @param {import('playwright').AndroidDevice} device
 * @returns {Promise<boolean>}
 */
export async function isAppAlive(device) {
  try {
    const pid = (await device.shell(`pidof ${PACKAGE_NAME}`)).toString().trim();
    return pid.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Soft restart (NEVER force-stop)
// ---------------------------------------------------------------------------

async function tapAt(device, point) {
  if (!point) return;
  await device.shell(`input tap ${Math.round(point.x)} ${Math.round(point.y)}`);
}

/**
 * Soft-restart the app WITHOUT force-stop.
 *
 * Strategy:
 *   1. Pre-grant permissions (idempotent).
 *   2. `am start` to bring to foreground (idempotent — works whether
 *      app is alive or dead).
 *   3. Dismiss any dialogs that appear during startup.
 *
 * Returns { restarted: true } if caller should re-attach external services
 * (Frida, etc.).
 *
 * @param {import('playwright').AndroidDevice} device
 * @param {{ width: number, height: number }} screen
 * @param {{ startupWaitMs?: number, dismissDialogs?: boolean }} [opts]
 * @returns {Promise<{ restarted: boolean, wasDead: boolean }>}
 */
export async function softRestart(device, screen, opts = {}) {
  const startupWaitMs = opts.startupWaitMs ?? 8000;
  const dismissDialogs = opts.dismissDialogs !== false;

  const wasDead = !(await isAppAlive(device));

  // Pre-grant permissions to prevent dialogs (idempotent, fast)
  const perms = ['RECORD_AUDIO', 'CAMERA', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE'];
  for (const perm of perms) {
    await device.shell(`pm grant ${PACKAGE_NAME} android.permission.${perm}`).catch(() => {});
  }

  // Start app — idempotent: brings to foreground if already running
  await device.shell(
    `am start -n ${PACKAGE_NAME}/com.ss.android.ugc.aweme.main.MainActivity`,
  );
  await sleep(startupWaitMs);

  // Verify process is running
  let running = await isAppAlive(device);
  if (!running) {
    // One retry with extra warm-up time
    await device.shell(
      `am start -n ${PACKAGE_NAME}/com.ss.android.ugc.aweme.main.MainActivity`,
    );
    await sleep(startupWaitMs + 2000);
    running = await isAppAlive(device);
    if (!running) {
      throw new Error(`Failed to start Douyin Mall (${PACKAGE_NAME})`);
    }
  }

  // Quick dialog dismissal loop (shorter than bringDouyinMallToFront's full cycle)
  if (dismissDialogs) {
    // Dynamic import to avoid circular dependency at module level
    const { dumpUi } = await import('./android.mjs');
    const { centerOf: ctr } = await import('./ui.mjs');

    for (let i = 0; i < 4; i++) {
      const result = await dumpUi(device, { maxAttempts: 2, throwOnFail: false });
      const nodes = result.nodes || [];
      if (!nodes.length) break;

      const val = (n) => (n.desc || n.text || '');

      const allowBtn = nodes.find((n) => /允许|始终允许/.test(val(n)) && n.bounds);
      if (allowBtn) { await tapAt(device, ctr(allowBtn)); await sleep(600); continue; }

      const denyBtn = nodes.find((n) => /拒绝/.test(val(n)) && n.bounds && n.bounds.y > 400);
      if (denyBtn) { await tapAt(device, ctr(denyBtn)); await sleep(600); continue; }

      const dismissBtn = nodes.find((n) =>
        /以后再说|暂不|稍后|知道了|跳过/.test(val(n)) && n.bounds);
      if (dismissBtn) { await tapAt(device, ctr(dismissBtn)); await sleep(600); continue; }

      break; // No dialogs found
    }
  }

  return { restarted: true, wasDead };
}

// ---------------------------------------------------------------------------
// Combined check + recover
// ---------------------------------------------------------------------------

/**
 * Ensure the app is alive before an interaction. Soft-restarts if dead.
 *
 * @param {import('playwright').AndroidDevice} device
 * @param {{ width: number, height: number }} screen
 * @param {object} [opts]
 * @returns {Promise<{ ok: boolean, restarted: boolean }>}
 */
export async function ensureAppAlive(device, screen, opts = {}) {
  if (await isAppAlive(device)) return { ok: true, restarted: false };

  console.warn('[health] App process dead — performing soft restart...');
  try {
    const result = await softRestart(device, screen, opts);
    console.log('[health] Soft restart successful.');
    return { ok: true, restarted: result.restarted };
  } catch (e) {
    console.error(`[health] Soft restart failed: ${e.message}`);
    return { ok: false, restarted: false };
  }
}

// ---------------------------------------------------------------------------
// Inter-product cooldown (human-like pacing)
// ---------------------------------------------------------------------------

/**
 * Pause between product interactions to appear more human and
 * avoid triggering Douyin's anti-bot rate-of-interaction heuristics.
 *
 * @param {object} [opts]
 * @param {number} [opts.minMs=3000]   minimum cooldown
 * @param {number} [opts.maxMs=7000]   maximum cooldown
 * @param {number} [opts.extraChance=0.15] probability of an extra 2-5s pause
 */
export async function interProductCooldown({
  minMs = 3000,
  maxMs = 7000,
  extraChance = 0.15,
} = {}) {
  const base = minMs + Math.round(Math.random() * (maxMs - minMs));
  const extra = Math.random() < extraChance
    ? 2000 + Math.round(Math.random() * 3000)
    : 0;
  const total = base + extra;
  console.log(`[cooldown] ${Math.round(total / 1000)}s`);
  await sleep(total);
}
