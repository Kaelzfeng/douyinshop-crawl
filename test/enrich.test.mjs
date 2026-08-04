import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProductId, extractShopName, formatPrice, parseResolvedProduct } from '../src/enrich.mjs';

test('parses exact product fields from resolved share URL', () => {
  const goods = encodeURIComponent(JSON.stringify({
    title: 'Golden Goose男女Super Star内增高板鞋',
    sales: 775,
    min_price: 440000,
    max_price: 440000,
  }));
  const url = `https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3684773501413228571&goods_detail=${goods}`;
  const product = parseResolvedProduct(url, '商品评价\nGOLDEN GOOSE官方旗舰店\n进店逛逛', 'https://v.douyin.com/example/');
  assert.equal(product.商品品名, 'Golden Goose男女Super Star内增高板鞋');
  assert.equal(product.店铺名, 'GOLDEN GOOSE官方旗舰店');
  assert.equal(product.价格, '4400');
  assert.equal(product.销量, '775件');
  assert.equal(product.productId, '3684773501413228571');
  assert.equal(product.商品id, '3684773501413228571');
});

test('extracts product id from real URL before share URL fallback', () => {
  assert.equal(
    extractProductId(
      'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?product_id=1111111111111111111',
      'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=2222222222222222222',
    ),
    '1111111111111111111',
  );
  assert.equal(
    extractProductId(
      'https://v.douyin.com/abc/',
      'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=2222222222222222222',
    ),
    '2222222222222222222',
  );
});

test('formats price range and extracts shop name', () => {
  assert.equal(formatPrice({ min_price: 590000, max_price: 630000 }), '5900-6300');
  assert.equal(extractShopName('店铺\n测试专卖店\n客服'), '测试专卖店');
});
