import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../src/args.mjs';

test('--all removes the product and scroll caps', () => {
  const config = parseArgs(['--all'], 'E:\\douyin-golden-goose-crawler');

  assert.equal(config.all, true);
  assert.equal(config.limit, Number.POSITIVE_INFINITY);
  assert.equal(config.maxScrolls, Number.POSITIVE_INFINITY);
});

test('--all can retain an explicit safety scroll cap', () => {
  const config = parseArgs(['--all', '--max-scrolls', '250'], 'E:\\douyin-golden-goose-crawler');

  assert.equal(config.all, true);
  assert.equal(config.maxScrolls, 250);
});

test('fixed-count mode keeps its existing defaults', () => {
  const config = parseArgs([], 'E:\\douyin-golden-goose-crawler');

  assert.equal(config.all, false);
  assert.equal(config.limit, 20);
  assert.equal(config.maxScrolls, 30);
  assert.equal(config.maxSharesPerWindow, 8);
  assert.equal(config.shareWindowMs, 15 * 60_000);
  assert.equal(config.accessDeniedCooldownMs, 15 * 60_000);
  assert.equal(config.maxAccessDeniedRetries, 3);
});

test('rate-limit controls can be configured', () => {
  const config = parseArgs([
    '--max-shares-per-window', '4',
    '--share-window-minutes', '20',
    '--access-denied-cooldown-minutes', '30',
    '--max-access-denied-retries', '2',
  ], 'E:\\douyin-golden-goose-crawler');

  assert.equal(config.maxSharesPerWindow, 4);
  assert.equal(config.shareWindowMs, 20 * 60_000);
  assert.equal(config.accessDeniedCooldownMs, 30 * 60_000);
  assert.equal(config.maxAccessDeniedRetries, 2);
});
