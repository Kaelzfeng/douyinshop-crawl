const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Human-like timing helpers
// ---------------------------------------------------------------------------

/**
 * Adds ±factor randomness to baseMs using a Box-Muller-like approximation.
 * For a base of 1000ms and factor 0.3, returns roughly 700–1300ms.
 *
 * @param {number} baseMs — center of the delay range
 * @param {number} factor — jitter magnitude (0–1, default 0.3)
 * @returns {number} jittered delay in ms (never below 0)
 */
export function jitter(baseMs, factor = 0.3) {
  // Simple triangular distribution: sum of two uniforms approximates a
  // normal-ish shape while staying bounded, which looks more human than
  // a flat uniform distribution.
  const u1 = Math.random();
  const u2 = Math.random();
  const normalish = (u1 + u2 - 1); // range [-1, 1], center-peaked
  const offset = Math.round(baseMs * factor * normalish);
  return Math.max(0, baseMs + offset);
}

/**
 * Returns a human-like delay: baseMs plus Gaussian-ish jitter at 50% magnitude.
 *
 * @param {number} baseMs — minimum delay
 * @returns {number} jittered delay
 */
export function humanDelay(baseMs) {
  return jitter(baseMs, 0.5);
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

export function rollingWindowDelay(timestamps, now, maxActions, windowMs) {
  const recent = timestamps.filter((timestamp) => now - timestamp < windowMs);
  if (recent.length < maxActions) return { delayMs: 0, recent };
  return {
    delayMs: Math.max(0, recent[0] + windowMs - now),
    recent,
  };
}

export function accessDeniedBackoff(baseMs, attempt) {
  return baseMs * (2 ** Math.max(0, attempt - 1));
}

export function createShareRateLimiter({
  maxActions,
  windowMs,
  now = () => Date.now(),
  wait = sleep,
  onWait = () => {},
}) {
  let timestamps = [];
  return {
    async waitForSlot() {
      const result = rollingWindowDelay(timestamps, now(), maxActions, windowMs);
      timestamps = result.recent;
      if (result.delayMs > 0) {
        onWait(result.delayMs);
        await wait(result.delayMs);
        timestamps = timestamps.filter((timestamp) => now() - timestamp < windowMs);
      }
    },
    recordAction() {
      timestamps.push(now());
    },
  };
}
