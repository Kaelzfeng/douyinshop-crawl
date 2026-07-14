import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTPUT_FIELDS, toCsv } from '../src/output.mjs';

test('exports exactly the requested five fields', () => {
  const csv = toCsv([{
    商品品名: 'Golden Goose, Test',
    店铺名: '测试店',
    价格: '4400',
    销量: '775件',
    分享的链接: 'https://v.douyin.com/example/',
    productId: 'internal-only',
  }]);
  assert.ok(csv.startsWith(`\uFEFF${OUTPUT_FIELDS.join(',')}`));
  assert.match(csv, /"Golden Goose, Test"/);
  assert.doesNotMatch(csv, /productId|internal-only/);
});

