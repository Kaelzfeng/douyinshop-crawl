import assert from 'node:assert/strict';
import test from 'node:test';

import { accessDeniedBackoff, createShareRateLimiter, rollingWindowDelay } from '../src/rate-limit.mjs';

test('rolling window delays the ninth share until the oldest action expires', () => {
  const timestamps = Array.from({ length: 8 }, (_, index) => index * 60_000);
  const result = rollingWindowDelay(timestamps, 8 * 60_000, 8, 15 * 60_000);

  assert.equal(result.delayMs, 7 * 60_000);
});

test('share limiter waits before admitting an action over the window limit', async () => {
  let clock = 0;
  const waits = [];
  const limiter = createShareRateLimiter({
    maxActions: 2,
    windowMs: 100,
    now: () => clock,
    wait: async (delayMs) => {
      waits.push(delayMs);
      clock += delayMs;
    },
  });

  limiter.recordAction();
  clock = 10;
  limiter.recordAction();
  clock = 20;
  await limiter.waitForSlot();

  assert.deepEqual(waits, [80]);
});

test('access denied backoff doubles after each denial', () => {
  assert.equal(accessDeniedBackoff(15 * 60_000, 1), 15 * 60_000);
  assert.equal(accessDeniedBackoff(15 * 60_000, 3), 60 * 60_000);
});
