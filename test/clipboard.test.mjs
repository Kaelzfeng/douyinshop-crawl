import test from 'node:test';
import assert from 'node:assert/strict';
import { extractShareUrl } from '../src/clipboard.mjs';

test('extracts the Douyin Mall short link from a share command', () => {
  const text = '【抖音商城】https://v.douyin.com/1gROYzHbWMY/ Golden Goose商品';
  assert.equal(extractShareUrl(text), 'https://v.douyin.com/1gROYzHbWMY/');
  assert.equal(extractShareUrl('not a share command'), null);
});
