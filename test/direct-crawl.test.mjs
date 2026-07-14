import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readLinksFromFile } from '../src/direct-crawl.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('readLinksFromFile', () => {
  let tmpDir;

  async function withTempFile(content, fn) {
    const tmpPath = path.join(os.tmpdir(), `test-links-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    await fs.writeFile(tmpPath, content, 'utf8');
    try {
      return await fn(tmpPath);
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }

  it('reads one link per line', async () => {
    await withTempFile(
      'https://v.douyin.com/AbCdEf123/\nhttps://v.douyin.com/XyZ987W/\n',
      async (tmpPath) => {
        const links = await readLinksFromFile(tmpPath);
        assert.equal(links.length, 2);
        assert.ok(links[0].startsWith('https://v.douyin.com/'));
        assert.ok(links[1].startsWith('https://v.douyin.com/'));
      },
    );
  });

  it('reads CSV with douyin links', async () => {
    await withTempFile(
      '商品品名,店铺名,价格,销量,分享的链接\r\nSome Product,Some Shop,100,50件,https://v.douyin.com/AbCdEf123/\r\n',
      async (tmpPath) => {
        const links = await readLinksFromFile(tmpPath);
        assert.equal(links.length, 1);
        assert.equal(links[0], 'https://v.douyin.com/AbCdEf123/');
      },
    );
  });

  it('reads JSON array of links', async () => {
    await withTempFile(
      JSON.stringify(['https://v.douyin.com/AbCdEf123/', 'https://v.douyin.com/XyZ987W/']),
      async (tmpPath) => {
        const links = await readLinksFromFile(tmpPath);
        assert.equal(links.length, 2);
      },
    );
  });

  it('reads JSON array of objects with 分享的链接 field', async () => {
    await withTempFile(
      JSON.stringify([
        { '分享的链接': 'https://v.douyin.com/AbCdEf123/' },
        { '分享的链接': 'https://v.douyin.com/XyZ987W/' },
      ]),
      async (tmpPath) => {
        const links = await readLinksFromFile(tmpPath);
        assert.equal(links.length, 2);
      },
    );
  });

  it('reads JSON with links array', async () => {
    await withTempFile(
      JSON.stringify({ links: ['https://v.douyin.com/AbCdEf123/'] }),
      async (tmpPath) => {
        const links = await readLinksFromFile(tmpPath);
        assert.equal(links.length, 1);
      },
    );
  });

  it('returns empty array for file with no douyin links', async () => {
    await withTempFile(
      'some random text\nno links here\n',
      async (tmpPath) => {
        const links = await readLinksFromFile(tmpPath);
        assert.equal(links.length, 0);
      },
    );
  });

  it('filters non-douyin URLs from JSON', async () => {
    await withTempFile(
      JSON.stringify([
        'https://v.douyin.com/AbCdEf123/',
        'https://example.com/other',
        'not a url',
      ]),
      async (tmpPath) => {
        const links = await readLinksFromFile(tmpPath);
        assert.equal(links.length, 1);
      },
    );
  });
});
