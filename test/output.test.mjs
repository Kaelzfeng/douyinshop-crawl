import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTPUT_FIELDS, productIdentityKey, toCsv } from '../src/output.mjs';

test('exports requested fields including search keyword and product id', () => {
  const csv = toCsv([{
    搜索关键词: 'ggdb',
    商品品名: 'Golden Goose, Test',
    店铺名: '测试店',
    价格: '4400',
    销量: '775件',
    分享的链接: 'https://v.douyin.com/example/',
    productId: 'internal-only',
  }]);
  assert.ok(csv.startsWith(`\uFEFF${OUTPUT_FIELDS.join(',')}`));
  assert.match(csv, /搜索关键词,商品id,商品品名,店铺名,价格,销量,分享的链接/);
  assert.match(csv, /ggdb,internal-only,/);
  assert.match(csv, /"Golden Goose, Test"/);
  assert.doesNotMatch(csv, /productId/);
});

test('product identity prefers id, then share link, then title and shop', () => {
  assert.equal(productIdentityKey({
    商品id: '111',
    分享的链接: 'https://v.douyin.com/a/',
    商品品名: 'A',
    店铺名: 'S',
  }), 'id:111');
  assert.equal(productIdentityKey({
    分享的链接: 'https://v.douyin.com/a/',
    商品品名: 'A',
    店铺名: 'S',
  }), 'link:https://v.douyin.com/a/');
  assert.equal(productIdentityKey({
    商品品名: 'A',
    店铺名: 'S',
  }), 'title-shop:A|S');
});
