import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SQLiteEventStore } from '../android-only-collector/sqlite-store.mjs';

function productEvent(productId, fields = {}) {
  return {
    event_id: `product-${productId}`,
    run_id: 'test',
    ts: 1,
    event: 'product_found',
    stage: 'search_response',
    source: 'test',
    product_id: productId,
    product_name: fields.product_name || '',
    title: fields.product_name || '',
    shop_name: fields.shop_name || '',
    price: fields.price || '',
    sales: fields.sales || '',
    raw: { product_id: productId },
  };
}

describe('offline SQLite product backfill', () => {
  it('fills only empty fields and is idempotent', () => {
    const store = new SQLiteEventStore({ dbPath: ':memory:', runId: 'test' });
    const productId = '3710238673955062247';
    store.record(productEvent(productId, {
      product_name: 'Existing title',
      shop_name: 'Existing shop',
      price: '5896.00',
    }));
    store.record({
      event_id: 'link-1',
      run_id: 'test',
      ts: 2,
      event: 'product_share_linked',
      stage: 'direct_shorten',
      source: 'direct_shorten',
      product_id: productId,
      share_url: 'https://v.douyin.com/Test123/',
      confidence: 1,
      correlation_reason: 'direct_shorten_product_id',
      raw: { product_id: productId },
    });

    const before = {
      products: store.all('SELECT COUNT(*) AS count FROM products')[0].count,
      shares: store.all('SELECT COUNT(*) AS count FROM shares')[0].count,
      product_shares: store.all('SELECT COUNT(*) AS count FROM product_shares')[0].count,
    };

    const first = store.backfillProducts([{
      product_id: productId,
      product_name: 'Replacement title',
      shop_name: 'Replacement shop',
      price: '9999.00',
      sales: '已售87件',
    }]);
    assert.equal(first.updated, 1);
    assert.equal(first.fields_updated.sales, 1);
    assert.equal(first.fields_updated.product_name, 0);
    assert.equal(first.fields_updated.shop_name, 0);
    assert.equal(first.fields_updated.price, 0);

    const row = store.all('SELECT product_name, shop_name, price, sales FROM products WHERE product_id = ?', productId)[0];
    assert.deepEqual({ ...row }, {
      product_name: 'Existing title',
      shop_name: 'Existing shop',
      price: '5896.00',
      sales: '已售87件',
    });

    const second = store.backfillProducts([{
      product_id: productId,
      product_name: 'Replacement title',
      shop_name: 'Replacement shop',
      price: '9999.00',
      sales: '已售87件',
    }]);
    assert.equal(second.updated, 0);
    assert.equal(second.fields_updated.sales, 0);

    const after = {
      products: store.all('SELECT COUNT(*) AS count FROM products')[0].count,
      shares: store.all('SELECT COUNT(*) AS count FROM shares')[0].count,
      product_shares: store.all('SELECT COUNT(*) AS count FROM product_shares')[0].count,
    };
    assert.deepEqual(after, before);
    store.close();
  });
});
