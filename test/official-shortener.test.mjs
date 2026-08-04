import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeEvent } from '../android-only-collector/events.mjs';
import { SQLiteEventStore } from '../android-only-collector/sqlite-store.mjs';
import {
  SHORTEN_ENDPOINT,
  SHORTEN_USER_AGENT,
  shortenProductId,
  shortenProducts,
} from '../src/official-shortener.mjs';

const PRODUCT_ID = '3684801835211817377';
const SHORT_URL = 'https://v.douyin.com/oFHP9Ieye8I/';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('official shortener accepts a normal response and sends the required request', async () => {
  let request = null;
  const shortUrl = await shortenProductId(PRODUCT_ID, {
    maxRetries: 0,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ code: 0, data: [{ short_url: SHORT_URL }] });
    },
  });

  assert.equal(shortUrl, SHORT_URL);
  assert.equal(request.url, SHORTEN_ENDPOINT);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['User-Agent'], SHORTEN_USER_AGENT);
  assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get('targets'), `https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=${PRODUCT_ID}`);
  assert.equal(body.get('belong'), 'douyinecommerce');
  assert.equal(body.get('persist'), '1');
});

test('official shortener rejects a non-200 response', async () => {
  await assert.rejects(
    shortenProductId(PRODUCT_ID, {
      maxRetries: 0,
      fetchImpl: async () => response({ message: 'failed' }, 503),
    }),
    /HTTP 503/,
  );
});

test('official shortener rejects code other than zero', async () => {
  await assert.rejects(
    shortenProductId(PRODUCT_ID, {
      maxRetries: 0,
      fetchImpl: async () => response({ code: 1001, message: 'rejected', data: [] }),
    }),
    /code=1001/,
  );
});

test('official shortener rejects empty data', async () => {
  await assert.rejects(
    shortenProductId(PRODUCT_ID, {
      maxRetries: 0,
      fetchImpl: async () => response({ code: 0, data: [] }),
    }),
    /empty data/,
  );
});

test('official shortener rejects an invalid short_url', async () => {
  await assert.rejects(
    shortenProductId(PRODUCT_ID, {
      maxRetries: 0,
      fetchImpl: async () => response({ code: 0, data: [{ short_url: 'https://example.com/not-douyin' }] }),
    }),
    /invalid short_url/,
  );
});

test('official shortener retries with exponential backoff', async () => {
  let calls = 0;
  const delays = [];
  const shortUrl = await shortenProductId(PRODUCT_ID, {
    maxRetries: 3,
    backoffBaseMs: 25,
    sleepFn: async (delay) => { delays.push(delay); },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return response({ message: 'retry' }, 500);
      return response({ code: 0, data: [{ short_url: SHORT_URL }] });
    },
  });

  assert.equal(shortUrl, SHORT_URL);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [25, 50]);
});

test('one API failure does not interrupt the remaining product links', async () => {
  const secondProductId = '3684801835211817378';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'official-shortener-failure-'));
  const dbPath = path.join(tempDir, 'collector.sqlite');
  const seed = new SQLiteEventStore({ dbPath, runId: 'test-failure' });
  try {
    for (const productId of [PRODUCT_ID, secondProductId]) {
      seed.record(makeEvent({ event: 'product_found', product_id: productId, product_name: 'GGDB product' }));
    }
  } finally {
    seed.close();
  }

  const failurePath = path.join(tempDir, 'failures.jsonl');
  const stats = await shortenProducts({
    dbPath,
    productIds: [PRODUCT_ID, secondProductId],
    workers: 2,
    delayMs: 0,
    maxRetries: 0,
    cachePath: path.join(tempDir, 'cache.jsonl'),
    failurePath,
    fetchImpl: async (_url, options) => {
      const target = new URLSearchParams(options.body).get('targets');
      return target.endsWith(PRODUCT_ID)
        ? response({ message: 'failed' }, 500)
        : response({ code: 0, data: [{ short_url: SHORT_URL }] });
    },
  });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(stats.failed, 1);
    assert.equal(stats.linked, 1);
    assert.deepEqual(stats.failed_product_ids, [PRODUCT_ID]);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM product_shares').get().count, 1);
    assert.match(await fs.readFile(failurePath, 'utf8'), new RegExp(PRODUCT_ID));
  } finally {
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('shortenProducts does not overwrite an existing product share', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'official-shortener-existing-'));
  const dbPath = path.join(tempDir, 'collector.sqlite');
  const existingUrl = 'https://v.douyin.com/existingLink/';
  const store = new SQLiteEventStore({ dbPath, runId: 'test-existing' });
  try {
    store.record(makeEvent({
      run_id: 'test-existing',
      event: 'product_found',
      product_id: PRODUCT_ID,
      product_name: 'GGDB product',
    }));
    store.record(makeEvent({
      run_id: 'test-existing',
      event: 'product_share_linked',
      product_id: PRODUCT_ID,
      share_url: existingUrl,
      confidence: 0.75,
      correlation_reason: 'time_window',
      source: 'clipboard',
    }));
  } finally {
    store.close();
  }

  let calls = 0;
  const stats = await shortenProducts({
    dbPath,
    productIds: [PRODUCT_ID],
    delayMs: 0,
    cachePath: path.join(tempDir, 'cache.jsonl'),
    failurePath: path.join(tempDir, 'failures.jsonl'),
    fetchImpl: async () => {
      calls += 1;
      return response({ code: 0, data: [{ short_url: SHORT_URL }] });
    },
  });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(calls, 0);
    assert.equal(stats.skipped_existing, 1);
    assert.deepEqual(db.prepare('SELECT share_url FROM product_shares WHERE product_id = ?').all(PRODUCT_ID).map((row) => ({ ...row })), [
      { share_url: existingUrl },
    ]);
  } finally {
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('shortenProducts writes the direct product_id association to SQLite', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'official-shortener-link-'));
  const dbPath = path.join(tempDir, 'collector.sqlite');
  const store = new SQLiteEventStore({ dbPath, runId: 'test-direct' });
  try {
    store.record(makeEvent({
      run_id: 'test-direct',
      event: 'product_found',
      product_id: PRODUCT_ID,
      product_name: 'GGDB product',
      shop_name: 'GGDB shop',
      price: '490000',
      sales: '100+',
    }));
  } finally {
    store.close();
  }

  const stats = await shortenProducts({
    dbPath,
    productIds: [PRODUCT_ID],
    workers: 3,
    delayMs: 0,
    cachePath: path.join(tempDir, 'cache.jsonl'),
    failurePath: path.join(tempDir, 'failures.jsonl'),
    fetchImpl: async () => response({ code: 0, data: [{ short_url: SHORT_URL }] }),
  });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(stats.linked, 1);
    assert.deepEqual({ ...db.prepare('SELECT product_id, share_url, source FROM shares').get() }, {
      product_id: PRODUCT_ID,
      share_url: SHORT_URL,
      source: 'direct_shorten',
    });
    assert.deepEqual({ ...db.prepare(`
      SELECT product_id, share_url, confidence, correlation_reason, source
      FROM product_shares
    `).get() }, {
      product_id: PRODUCT_ID,
      share_url: SHORT_URL,
      confidence: 1,
      correlation_reason: 'direct_shorten_product_id',
      source: 'direct_shorten',
    });
  } finally {
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
