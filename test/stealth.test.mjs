import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STEALTH_LAUNCH_ARGS, STEALTH_INIT_SCRIPT } from '../src/stealth.mjs';

describe('STEALTH_LAUNCH_ARGS', () => {
  it('includes the critical AutomationControlled flag', () => {
    assert.ok(STEALTH_LAUNCH_ARGS.includes('--disable-blink-features=AutomationControlled'));
  });

  it('includes --no-sandbox', () => {
    assert.ok(STEALTH_LAUNCH_ARGS.includes('--no-sandbox'));
  });

  it('includes --disable-dev-shm-usage', () => {
    assert.ok(STEALTH_LAUNCH_ARGS.includes('--disable-dev-shm-usage'));
  });

  it('all args are strings', () => {
    for (const arg of STEALTH_LAUNCH_ARGS) {
      assert.equal(typeof arg, 'string');
    }
  });
});

describe('STEALTH_INIT_SCRIPT', () => {
  it('is a non-empty string', () => {
    assert.equal(typeof STEALTH_INIT_SCRIPT, 'string');
    assert.ok(STEALTH_INIT_SCRIPT.length > 100);
  });

  it('overrides navigator.webdriver', () => {
    assert.ok(STEALTH_INIT_SCRIPT.includes("navigator, 'webdriver'"));
    assert.ok(STEALTH_INIT_SCRIPT.includes('get: () => undefined'));
  });

  it('overrides navigator.plugins', () => {
    assert.ok(STEALTH_INIT_SCRIPT.includes("navigator, 'plugins'"));
  });

  it('overrides chrome.runtime', () => {
    assert.ok(STEALTH_INIT_SCRIPT.includes('chrome.runtime'));
  });

  it('patches permissions.query', () => {
    assert.ok(STEALTH_INIT_SCRIPT.includes('permissions.query'));
  });

  it('removes playwright traces', () => {
    assert.ok(STEALTH_INIT_SCRIPT.includes('__pw_'));
    assert.ok(STEALTH_INIT_SCRIPT.includes('delete self.playwright'));
  });

  it('overrides navigator.vendor', () => {
    assert.ok(STEALTH_INIT_SCRIPT.includes("navigator, 'vendor'"));
    assert.ok(STEALTH_INIT_SCRIPT.includes('Google Inc.'));
  });

  it('overrides canvas toDataURL for fingerprint noise', () => {
    assert.ok(STEALTH_INIT_SCRIPT.includes('toDataURL'));
  });

  it('handles getBattery API', () => {
    assert.ok(STEALTH_INIT_SCRIPT.includes('getBattery'));
  });

  it('handles mediaDevices.enumerateDevices', () => {
    assert.ok(STEALTH_INIT_SCRIPT.includes('enumerateDevices'));
  });
});
