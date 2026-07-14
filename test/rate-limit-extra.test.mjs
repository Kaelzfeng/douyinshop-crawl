import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jitter, humanDelay, rollingWindowDelay, accessDeniedBackoff, createShareRateLimiter } from '../src/rate-limit.mjs';

describe('jitter', () => {
  it('returns a number close to baseMs', () => {
    const base = 1000;
    for (let i = 0; i < 50; i++) {
      const result = jitter(base, 0.3);
      assert.ok(result >= 0, `Expected >= 0, got ${result}`);
      // With factor 0.3 and triangular dist, should stay within ~±60% of base
      assert.ok(result <= base * 1.7, `Expected <= ${base * 1.7}, got ${result}`);
    }
  });

  it('centers around baseMs on average', () => {
    const base = 1000;
    let sum = 0;
    const count = 200;
    for (let i = 0; i < count; i++) {
      sum += jitter(base, 0.3);
    }
    const avg = sum / count;
    // Average should be within 10% of base
    assert.ok(Math.abs(avg - base) < base * 0.1,
      `Expected avg ~${base}, got ${avg.toFixed(0)}`);
  });

  it('returns 0 for baseMs 0', () => {
    assert.equal(jitter(0, 0.5), 0);
  });

  it('produces variation (not all same)', () => {
    const values = new Set();
    for (let i = 0; i < 30; i++) {
      values.add(jitter(1000, 0.5));
    }
    assert.ok(values.size > 5, `Expected >5 distinct values, got ${values.size}`);
  });
});

describe('humanDelay', () => {
  it('returns a positive number', () => {
    for (let i = 0; i < 20; i++) {
      assert.ok(humanDelay(500) >= 0);
    }
  });
});

describe('rollingWindowDelay', () => {
  it('still works correctly (existing test logic)', () => {
    const now = 100_000;
    const windowMs = 60_000;
    const maxActions = 3;
    const timestamps = [now - 10_000, now - 20_000];
    const result = rollingWindowDelay(timestamps, now, maxActions, windowMs);
    assert.equal(result.delayMs, 0);
    assert.equal(result.recent.length, 2);
  });
});

describe('accessDeniedBackoff', () => {
  it('still works correctly (existing test logic)', () => {
    assert.equal(accessDeniedBackoff(60_000, 1), 60_000);
    assert.equal(accessDeniedBackoff(60_000, 2), 120_000);
    assert.equal(accessDeniedBackoff(60_000, 3), 240_000);
  });
});
