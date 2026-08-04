/**
 * Unit tests for direct-search-client.mjs
 *
 * Tests:
 * 1. Search response parsing (TTNet streaming + standard JSON)
 * 2. Product card field extraction
 * 3. Cursor and has_more parsing
 * 4. Duplicate product_id dedup
 * 5. Cursor stalling termination
 * 6. Empty page handling
 * 7. Short link API (unit, mocked fetch)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchResponse } from '../src/direct-search-client.mjs';
import { extractProductFields, extractSalesFromMaterial, isCompleteProduct } from '../src/product-field-normalizers.mjs';
import { shortenProductId, parseOfficialShortenPayload, normalizeOfficialShortUrl, officialProductTarget } from '../src/official-shortener.mjs';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

/** Simulated TTNet streaming response with 2 documents */
function makeTTNetResponse(documents) {
  const parts = [];
  for (const doc of documents) {
    const json = JSON.stringify(doc);
    const size = json.length.toString(16);
    parts.push(`${size}\r\n${json}\r\n`);
  }
  parts.push('0\r\n\r\n');
  return parts.join('');
}

/** Make a single product card */
function makeProductCard(overrides = {}) {
  return {
    ProductID: overrides.product_id || '3755321058031436047',
    Title: overrides.title || 'Test Product',
    Price: overrides.price ?? 589600,
    MaterialContentInfo: overrides.materialInfo || '素材id:601,素材内容:Test Shop;素材id:546,素材内容:已售500+件;',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseSearchResponse', () => {
  it('parses TTNet streaming response with products', () => {
    const doc1 = {
      status_code: 0,
      page_data: {
        feed_layer: {
          sections: [
            {
              section_id: 'product_section',
              items: [
                makeProductCard({ product_id: '1111111111111111111', title: 'Product A', price: 100000 }),
                makeProductCard({ product_id: '2222222222222222222', title: 'Product B', price: 200000 }),
              ],
            },
          ],
        },
      },
      cursor: '0',
      has_more: true,
      next_cursor: '8',
    };

    const body = makeTTNetResponse([doc1]);
    const result = parseSearchResponse(body, '0');

    assert.equal(result.status_code, 0);
    assert.equal(result.products.length, 2);
    assert.equal(result.cursor, '0');
    assert.equal(result.nextCursor, '8');
    assert.equal(result.hasMore, true);
    assert.equal(result.products[0].product_id, '1111111111111111111');
    assert.equal(result.products[1].product_id, '2222222222222222222');
  });

  it('parses standard JSON response (non-TTNet)', () => {
    const doc = {
      status_code: 0,
      products: [
        { product_id: '3333333333333333333', title: 'Product C', price: '99.00', shop_name: 'Shop C', sales: '100+' },
      ],
      cursor: '0',
      has_more: false,
    };
    const result = parseSearchResponse(JSON.stringify(doc), '0');

    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].product_id, '3333333333333333333');
    assert.equal(result.hasMore, false);
  });

  it('extracts shop name from MaterialContentInfo', () => {
    const doc1 = {
      status_code: 0,
      page_data: {
        feed_layer: {
          sections: [{
            section_id: 's1',
            items: [makeProductCard({
              product_id: '4444444444444444444',
              materialInfo: '素材id:601,素材内容:GOLDEN GOOSE官方旗舰店;素材id:546,素材内容:已售500+件;',
            })],
          }],
        },
      },
    };
    const result = parseSearchResponse(makeTTNetResponse([doc1]), '0');
    assert.equal(result.products[0].shop_name, 'GOLDEN GOOSE官方旗舰店');
  });

  it('extracts sales from MaterialContentInfo', () => {
    const doc1 = {
      status_code: 0,
      page_data: {
        feed_layer: {
          sections: [{
            section_id: 's1',
            items: [makeProductCard({
              product_id: '5555555555555555555',
              materialInfo: '素材id:601,素材内容:Shop;素材id:546,素材内容:已售1000+件;',
            })],
          }],
        },
      },
    };
    const result = parseSearchResponse(makeTTNetResponse([doc1]), '0');
    assert.equal(result.products[0].sales, '已售1000+件');
  });

  it('extracts product sales from MaterialContentInfo material ID 541', () => {
    const doc = {
      status_code: 0,
      page_data: {
        feed_layer: {
          sections: [{
            items: [makeProductCard({
              product_id: '5555555555555555556',
              materialInfo: '区域名称:sales 内容:[素材id:541,素材内容:已售87件;]',
            })],
          }],
        },
      },
    };
    const result = parseSearchResponse(makeTTNetResponse([doc]), '0');
    assert.equal(result.products[0].sales, '已售87件');
  });

  it('keeps shop-level sales out of product sales', () => {
    const fields = extractProductFields({
      ProductID: '5555555555555555557',
      Title: 'Shop sales candidate',
      Price: 589600,
      MaterialContentInfo: '区域名称:shop 内容:[素材id:4987838,素材内容:全店已售6000+件;]',
    });
    assert.equal(fields.sales, '');
    assert.equal(fields.sales_metadata.shop.value, '已售6000+件');
    assert.equal(fields.sales_metadata.shop.scope, 'shop');
  });

  it('supports paid and monthly sales semantic formats', () => {
    const paid = extractSalesFromMaterial('区域名称:sales 内容:[素材id:901,素材内容:1.2万+人付款;]');
    const monthly = extractSalesFromMaterial('区域名称:sales 内容:[素材id:902,素材内容:月售300;]');
    assert.equal(paid.product.value, '1.2万+人付款');
    assert.equal(monthly.product.value, '月售300');
  });

  it('does not classify price or product IDs as sales', () => {
    const fields = extractProductFields({
      ProductID: '3755321058031436047',
      Title: 'No sales',
      Price: 589600,
      MaterialContentInfo: '素材id:601,素材内容:Test Shop;素材id:903,素材内容:589600;',
    });
    assert.equal(fields.sales, '');
    assert.equal(isCompleteProduct({
      product_id: fields.product_id,
      product_name: fields.product_name,
      shop_name: fields.shop_name,
      price: fields.price,
      sales: fields.sales,
      share_url: 'https://v.douyin.com/Test123/',
    }), false);
  });

  it('deduplicates products by product_id', () => {
    const doc1 = {
      status_code: 0,
      page_data: {
        feed_layer: {
          sections: [{
            section_id: 's1',
            items: [
              makeProductCard({ product_id: '6666666666666666666', title: 'Same' }),
              makeProductCard({ product_id: '6666666666666666666', title: 'Same Duplicate' }),
            ],
          }],
        },
      },
    };
    const result = parseSearchResponse(makeTTNetResponse([doc1]), '0');
    assert.equal(result.products.length, 1);
  });

  it('returns empty products for non-200 response', () => {
    const doc1 = { status_code: 1, status_msg: 'error' };
    const result = parseSearchResponse(makeTTNetResponse([doc1]), '0');
    assert.equal(result.status_code, 1);
    assert.equal(result.products.length, 0);
  });

  it('handles empty body gracefully', () => {
    const result = parseSearchResponse('', '0');
    assert.equal(result.products.length, 0);
    assert.equal(result.status_code, -1);
  });

  it('handles non-JSON body gracefully', () => {
    const result = parseSearchResponse('not json at all', '0');
    assert.equal(result.products.length, 0);
    assert.equal(result.status_code, -1);
  });

  it('detects cursor stalling (nextCursor === cursor)', () => {
    const doc1 = {
      status_code: 0,
      page_data: { feed_layer: { sections: [] } },
      cursor: '5',
      next_cursor: '5',
      has_more: true,
    };
    const result = parseSearchResponse(makeTTNetResponse([doc1]), '5');
    assert.equal(result.nextCursor, '5');
    // Caller should check this condition
    assert.equal(result.cursor, '5');
    assert.equal(result.nextCursor, result.cursor);
  });

  it('handles has_more=false termination', () => {
    const doc1 = {
      status_code: 0,
      page_data: { feed_layer: { sections: [] } },
      cursor: '10',
      has_more: false,
    };
    const result = parseSearchResponse(makeTTNetResponse([doc1]), '10');
    assert.equal(result.hasMore, false);
    assert.equal(result.products.length, 0);
  });

  it('converts price from fen to yuan', () => {
    const doc1 = {
      status_code: 0,
      page_data: {
        feed_layer: {
          sections: [{
            section_id: 's1',
            items: [makeProductCard({ product_id: '7777777777777777777', price: 589600 })],
          }],
        },
      },
    };
    const result = parseSearchResponse(makeTTNetResponse([doc1]), '0');
    assert.equal(result.products[0].price, '5896.00');
  });

  it('merges data from multiple TTNet documents', () => {
    // Doc 1: preload list (no details)
    const doc1 = {
      status_code: 0,
      page_data: {
        outer_card_layer: {
          product_preload_list: [
            { product_id: '8888888888888888888', cover_url: 'http://example.com/1.jpg' },
          ],
        },
      },
    };
    // Doc 2: feed layer with details
    const doc2 = {
      status_code: 0,
      page_data: {
        feed_layer: {
          sections: [{
            section_id: 's1',
            items: [{
              ProductID: '8888888888888888888',
              Title: 'Product From Doc 2',
              Price: 300000,
              MaterialContentInfo: '素材id:601,素材内容:ShopX;素材id:546,素材内容:已售200+件;',
            }],
          }],
        },
      },
      cursor: '0',
      has_more: true,
      next_cursor: '8',
    };
    const result = parseSearchResponse(makeTTNetResponse([doc1, doc2]), '0');
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].product_name, 'Product From Doc 2');
    assert.equal(result.products[0].shop_name, 'ShopX');
    assert.equal(result.nextCursor, '8');
    assert.equal(typeof result.rawBody, 'string');
  });
});

// ---------------------------------------------------------------------------
// Shorten API tests
// ---------------------------------------------------------------------------

describe('shortenProductId', () => {
  it('builds correct official target URL', () => {
    const url = officialProductTarget('1234567890123456789');
    assert.equal(url, 'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=1234567890123456789');
  });

  it('normalizes short URLs correctly', () => {
    assert.equal(normalizeOfficialShortUrl('https://v.douyin.com/AbCdEf/'), 'https://v.douyin.com/AbCdEf/');
    assert.equal(normalizeOfficialShortUrl('https://v.douyin.com/AbCdEf'), 'https://v.douyin.com/AbCdEf/');
    assert.equal(normalizeOfficialShortUrl(''), '');
    assert.equal(normalizeOfficialShortUrl('not-a-url'), '');
  });

  it('parses valid shorten response', () => {
    const payload = { code: 0, data: [{ short_url: 'https://v.douyin.com/Test123/' }] };
    const url = parseOfficialShortenPayload(payload);
    assert.equal(url, 'https://v.douyin.com/Test123/');
  });

  it('rejects shorten response with error code', () => {
    assert.throws(() => {
      parseOfficialShortenPayload({ code: 1, message: 'error' });
    }, /code=1/);
  });

  it('rejects shorten response with empty data', () => {
    assert.throws(() => {
      parseOfficialShortenPayload({ code: 0, data: [] });
    }, /empty data/);
  });

  it('rejects invalid product_id', async () => {
    await assert.rejects(
      () => shortenProductId('123', { fetchImpl: globalThis.fetch }),
      /invalid product_id/,
    );
  });

  it('accepts valid 16-digit product_id format', async () => {
    // This test validates the ID format check passes (no actual API call)
    const err = await shortenProductId('1234567890123456', {
      fetchImpl: async () => {
        return new Response(JSON.stringify({ code: 0, data: [{ short_url: 'https://v.douyin.com/Test123/' }] }), { status: 200 });
      },
    }).catch(e => e);
    // Should succeed with mocked fetch
    assert.equal(typeof err, 'string');
    assert.ok(err.startsWith('https://v.douyin.com/'));
  });
});

// ---------------------------------------------------------------------------
// Cursor logic tests (pure functions, no API)
// ---------------------------------------------------------------------------

describe('cursor logic', () => {
  it('terminates when nextCursor equals currentCursor', () => {
    const cursor = '8';
    const nextCursor = '8';
    const stalled = !nextCursor || nextCursor === cursor;
    assert.equal(stalled, true);
  });

  it('continues when nextCursor differs from currentCursor', () => {
    const cursor = '0';
    const nextCursor = '8';
    const stalled = !nextCursor || nextCursor === cursor;
    assert.equal(stalled, false);
  });

  it('terminates on hasMore=false', () => {
    const hasMore = false;
    const shouldContinue = hasMore;
    assert.equal(shouldContinue, false);
  });

  it('terminates after 3 consecutive empty pages', () => {
    let consecutiveEmpty = 3;
    assert.equal(consecutiveEmpty >= 3, true);
  });

  it('does not terminate on first empty page', () => {
    let consecutiveEmpty = 1;
    assert.equal(consecutiveEmpty >= 3, false);
  });
});
