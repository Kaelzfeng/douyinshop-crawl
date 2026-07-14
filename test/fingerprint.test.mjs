import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFingerprint, UA_POOL, VIEWPORT_PRESETS } from '../src/fingerprint.mjs';

describe('generateFingerprint', () => {
  it('returns an object with all required fields', () => {
    const fp = generateFingerprint();
    assert.equal(typeof fp, 'object');
    assert.equal(typeof fp.userAgent, 'string');
    assert.equal(typeof fp.viewport, 'object');
    assert.equal(typeof fp.viewport.width, 'number');
    assert.equal(typeof fp.viewport.height, 'number');
    assert.equal(typeof fp.deviceScaleFactor, 'number');
    assert.equal(fp.hasTouch, true);
    assert.equal(fp.isMobile, true);
    assert.equal(fp.locale, 'zh-CN');
    assert.equal(fp.timezoneId, 'Asia/Shanghai');
    assert.equal(typeof fp.hardwareConcurrency, 'number');
    assert.equal(typeof fp.deviceMemory, 'number');
    assert.equal(typeof fp.platform, 'string');
  });

  it('produces a user agent from the pool', () => {
    const uas = new Set();
    for (let i = 0; i < 50; i++) {
      uas.add(generateFingerprint().userAgent);
    }
    // Should have picked at least some distinct UAs over 50 calls
    assert.ok(uas.size >= 2, `Expected >=2 distinct UAs, got ${uas.size}`);
    // All should be from the pool
    for (const ua of uas) {
      assert.ok(UA_POOL.includes(ua), `UA not in pool: ${ua}`);
    }
  });

  it('returns viewport from the presets', () => {
    const fps = Array.from({ length: 20 }, () => generateFingerprint());
    for (const fp of fps) {
      const match = VIEWPORT_PRESETS.some(
        (v) => v.width === fp.viewport.width && v.height === fp.viewport.height,
      );
      assert.ok(match, `Viewport ${fp.viewport.width}x${fp.viewport.height} not in presets`);
    }
  });

  it('generates hardwareConcurrency between 4 and 8', () => {
    for (let i = 0; i < 20; i++) {
      const fp = generateFingerprint();
      assert.ok(fp.hardwareConcurrency >= 4 && fp.hardwareConcurrency <= 8,
        `Expected 4-8, got ${fp.hardwareConcurrency}`);
    }
  });

  it('generates deviceMemory between 4 and 8', () => {
    for (let i = 0; i < 20; i++) {
      const fp = generateFingerprint();
      assert.ok(fp.deviceMemory >= 4 && fp.deviceMemory <= 8,
        `Expected 4-8, got ${fp.deviceMemory}`);
    }
  });

  it('generates fingerprints that differ between calls', () => {
    const fp1 = generateFingerprint();
    const fp2 = generateFingerprint();
    // At least one field should differ (not guaranteed but very likely over many fields)
    const differs = fp1.userAgent !== fp2.userAgent
      || fp1.viewport.width !== fp2.viewport.width
      || fp1.hardwareConcurrency !== fp2.hardwareConcurrency
      || fp1.deviceMemory !== fp2.deviceMemory;
    // Run in a loop to avoid flaky failures
    let anyDiffer = differs;
    for (let i = 0; i < 10 && !anyDiffer; i++) {
      const a = generateFingerprint();
      const b = generateFingerprint();
      anyDiffer = a.userAgent !== b.userAgent
        || a.viewport.width !== b.viewport.width
        || a.hardwareConcurrency !== b.hardwareConcurrency;
    }
    assert.ok(anyDiffer, 'Expected fingerprints to differ across calls');
  });
});

describe('UA_POOL', () => {
  it('has at least 10 entries', () => {
    assert.ok(UA_POOL.length >= 10);
  });

  it('all entries are valid mobile Chrome UAs', () => {
    for (const ua of UA_POOL) {
      assert.ok(ua.includes('Android'), `Expected Android in UA: ${ua}`);
      assert.ok(ua.includes('Chrome/'), `Expected Chrome in UA: ${ua}`);
      assert.ok(ua.includes('Mobile'), `Expected Mobile in UA: ${ua}`);
      assert.ok(ua.includes('AppleWebKit'), `Expected AppleWebKit in UA: ${ua}`);
    }
  });
});
