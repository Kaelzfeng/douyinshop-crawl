import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveCanonicalEvents,
  extractProductFields,
  extractProductId,
  extractShareUrl,
  ProductShareCorrelator,
} from '../events.mjs';

const PRODUCT_ID = '3684801835211817377';

test('extracts product identity from the 39.6.0 detail request body', () => {
  const body = [
    `promotion_ids=${PRODUCT_ID}`,
    `basic_info=${encodeURIComponent(JSON.stringify({ product_id: PRODUCT_ID, shop_id: '165747788' }))}`,
  ].join('&');

  assert.equal(extractProductId(body), PRODUCT_ID);
  assert.deepEqual(extractProductFields(body), {
    product_id: PRODUCT_ID,
    promotion_id: PRODUCT_ID,
    title: '',
    product_name: '',
    shop_name: '',
    min_price: '',
    max_price: '',
    price: '',
    sales: '',
  });
});

test('parses the ec_goods_detail deeplink schema', () => {
  const uri = `sslocal://ec_goods_detail?product_id=${PRODUCT_ID}&promotion_id=${PRODUCT_ID}&goods_detail=${encodeURIComponent(JSON.stringify({
    title: 'Golden Goose Super Star Sabot',
    sales: 91,
    min_price: 490000,
    max_price: 520000,
  }))}`;
  const events = deriveCanonicalEvents({
    stage: 'ec_goods_detail',
    kind: 'ec_goods_detail',
    ts: 900,
    uri,
    url: uri,
    value: uri,
    product_signal: true,
  }, { runId: 'run-1', pid: 123 });
  const product = events.find((event) => event.event === 'product_found');
  assert.ok(product);
  assert.equal(product.stage, 'ec_goods_detail');
  assert.equal(product.product_id, PRODUCT_ID);
  assert.equal(product.promotion_id, PRODUCT_ID);
  assert.equal(product.title, 'Golden Goose Super Star Sabot');
  assert.equal(product.sales, '91');
  assert.equal(product.min_price, '490000');
  assert.equal(product.max_price, '520000');
});

test('emits product_found from a detail request and response', () => {
  const requestEvents = deriveCanonicalEvents({
    stage: 'detail_request',
    ts: 1_000,
    url: 'https://ecom.ecombdapi.com/ecom/product/detail/pack/async',
    body: `promotion_ids=${PRODUCT_ID}&basic_info=${encodeURIComponent(JSON.stringify({ product_id: PRODUCT_ID }))}`,
  }, { runId: 'run-1', pid: 123 });
  const request = requestEvents.find((event) => event.event === 'product_found');
  assert.ok(request);
  assert.equal(request.product_id, PRODUCT_ID);
  assert.equal(request.stage, 'detail_request');

  const responseEvents = deriveCanonicalEvents({
    stage: 'detail_response',
    kind: 'gson',
    ts: 1_100,
    body: JSON.stringify({ data: { product_id: PRODUCT_ID, title: 'Golden Goose Super Star Sabot' } }),
  }, { runId: 'run-1', pid: 123 });
  const response = responseEvents.find((event) => event.event === 'product_found');
  assert.ok(response);
  assert.equal(response.product_id, PRODUCT_ID);
  assert.equal(response.title, 'Golden Goose Super Star Sabot');
});

test('emits share_found from clipboard text', () => {
  const text = '【抖音商城】https://v.douyin.com/oFHP9Ieye8I/ Golden Goose Super Star Sabot';
  assert.equal(extractShareUrl(text), 'https://v.douyin.com/oFHP9Ieye8I/');
  const events = deriveCanonicalEvents({
    stage: 'clipboard',
    kind: 'clipboard',
    ts: 2_000,
    text,
  }, { runId: 'run-1', pid: 123 });
  const share = events.find((event) => event.event === 'share_found');
  assert.ok(share);
  assert.equal(share.share_url, 'https://v.douyin.com/oFHP9Ieye8I/');
  assert.equal(share.stage, 'clipboard');
});

test('links a product and share by the time window when the clipboard has no product id', () => {
  const productEvents = deriveCanonicalEvents({
    stage: 'detail_request',
    ts: 10_000,
    url: 'https://ecom.ecombdapi.com/ecom/product/detail/pack/async',
    body: `promotion_ids=${PRODUCT_ID}`,
  }, { runId: 'run-1' });
  const product = productEvents.find((event) => event.event === 'product_found');
  const shareEvents = deriveCanonicalEvents({
    stage: 'clipboard',
    kind: 'clipboard',
    ts: 10_500,
    text: 'https://v.douyin.com/oFHP9Ieye8I/',
  }, { runId: 'run-1' });
  const share = shareEvents.find((event) => event.event === 'share_found');

  const correlator = new ProductShareCorrelator({ runId: 'run-1', windowMs: 1_000 });
  assert.deepEqual(correlator.accept(product), []);
  assert.equal(correlator.productCache.has(PRODUCT_ID), true);
  const generated = correlator.accept(share);
  const linked = generated.find((event) => event.event === 'product_share_linked');
  const debug = generated.find((event) => event.event === 'share_correlation_debug');
  assert.ok(linked);
  assert.ok(debug);
  assert.equal(linked.product_id, PRODUCT_ID);
  assert.equal(linked.share_url, 'https://v.douyin.com/oFHP9Ieye8I/');
  assert.equal(linked.correlation_reason, 'time_window');
  assert.equal(debug.association_status, 'linked');
});

test('links a share received before its product signal', () => {
  const share = deriveCanonicalEvents({
    stage: 'share_link',
    ts: 20_000,
    share_url: 'https://v.douyin.com/oFHP9Ieye8I/',
  }, { runId: 'run-1' }).find((event) => event.event === 'share_found');
  const product = deriveCanonicalEvents({
    stage: 'detail_request',
    ts: 20_400,
    url: 'https://ecom.ecombdapi.com/ecom/product/detail/pack/async',
    body: `promotion_ids=${PRODUCT_ID}`,
  }, { runId: 'run-1' }).find((event) => event.event === 'product_found');

  const correlator = new ProductShareCorrelator({ runId: 'run-1', windowMs: 1_000 });
  const pending = correlator.accept(share);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].event, 'share_correlation_debug');
  assert.equal(pending[0].association_status, 'waiting_for_time_window_product');
  const generated = correlator.accept(product);
  const linked = generated.find((event) => event.event === 'product_share_linked');
  assert.ok(linked);
  assert.equal(linked.product_id, PRODUCT_ID);
});
