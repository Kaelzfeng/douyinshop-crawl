import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../events.mjs';
import { SQLiteEventStore } from '../sqlite-store.mjs';

test('persists events, products, shares, and product-share links', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'android-only-collector-'));
  const dbPath = path.join(tempDir, 'collector.sqlite');
  const productId = '3684801835211817377';
  const shareUrl = 'https://v.douyin.com/oFHP9Ieye8I/';
  const store = new SQLiteEventStore({ dbPath, runId: 'run-1' });

  try {
    store.record(makeEvent({
      run_id: 'run-1',
      event: 'product_found',
      stage: 'detail_request',
      ts: 1_000,
      product_id: productId,
      promotion_id: productId,
      title: 'Golden Goose Super Star Sabot',
      min_price: '490000',
      max_price: '520000',
      url: 'https://ecom.ecombdapi.com/ecom/product/detail/pack/async',
    }));
    store.record(makeEvent({
      run_id: 'run-1',
      event: 'share_found',
      stage: 'clipboard',
      ts: 1_500,
      share_url: shareUrl,
      title: 'Golden Goose Super Star Sabot',
    }));
    store.record(makeEvent({
      run_id: 'run-1',
      event: 'product_share_linked',
      stage: 'correlated',
      ts: 1_500,
      product_id: productId,
      share_url: shareUrl,
      correlation_reason: 'time_window',
      confidence: 0.75,
    }));

    assert.equal(store.all('SELECT COUNT(*) AS count FROM events')[0].count, 3);
    assert.equal(store.all('SELECT COUNT(*) AS count FROM products')[0].count, 1);
    assert.equal(store.all('SELECT COUNT(*) AS count FROM shares')[0].count, 1);
    assert.equal(store.all('SELECT COUNT(*) AS count FROM product_shares')[0].count, 1);
    const product = store.all('SELECT product_id, title, min_price, max_price FROM products')[0];
    assert.equal(product.product_id, productId);
    assert.equal(product.title, 'Golden Goose Super Star Sabot');
    assert.equal(product.min_price, '490000');
    assert.equal(product.max_price, '520000');
    const row = store.all('SELECT product_id, share_url, confidence FROM product_shares')[0];
    assert.equal(row.product_id, productId);
    assert.equal(row.share_url, shareUrl);
    assert.equal(row.confidence, 0.75);
  } finally {
    store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
