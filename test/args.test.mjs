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

test('fixed-count mode defaults are aggressive by default', () => {
  const config = parseArgs([], 'E:\\douyin-golden-goose-crawler');

  assert.equal(config.all, false);
  assert.deepEqual(config.queries, ['ggdb', '小脏鞋']);
  assert.equal(config.query, 'ggdb');
  assert.equal(config.limit, 20);
  assert.equal(config.maxScrolls, 30);
  // Aggressive defaults
  assert.equal(config.maxSharesPerWindow, 20);
  assert.equal(config.shareWindowMs, 10 * 60_000);
  assert.equal(config.accessDeniedCooldownMs, 3 * 60_000);
  assert.equal(config.maxAccessDeniedRetries, 6);
});

test('--gentle reverts to conservative rate limits', () => {
  const config = parseArgs(['--gentle'], 'E:\\douyin-golden-goose-crawler');

  assert.equal(config.maxSharesPerWindow, 8);
  assert.equal(config.shareWindowMs, 15 * 60_000);
  assert.equal(config.accessDeniedCooldownMs, 15 * 60_000);
  assert.equal(config.maxAccessDeniedRetries, 3);
});

test('--query keeps single-keyword behavior', () => {
  const config = parseArgs(['--query', 'ggdb'], 'E:\\douyin-golden-goose-crawler');

  assert.deepEqual(config.queries, ['ggdb']);
  assert.equal(config.query, 'ggdb');
});

test('--queries accepts comma-separated keyword batches', () => {
  const config = parseArgs(['--queries', 'ggdb,小脏鞋'], 'E:\\douyin-golden-goose-crawler');

  assert.deepEqual(config.queries, ['ggdb', '小脏鞋']);
  assert.equal(config.query, 'ggdb');
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
