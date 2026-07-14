/**
 * Extract product data from ProductDetailActivity UI dump.
 * Bypasses share link step entirely.
 */
import { dumpUi } from './android.mjs';

/**
 * Parse product info from a UI dump of the product detail page.
 * Returns { title, shop, price, sales, link } or null.
 */
export function extractProductFromUi(nodes) {
  const result = {};

  // Find the product title — longest text node in the main content area
  const titleCandidates = nodes.filter(n =>
    n.bounds && n.text && n.text.length > 5 &&
    n.bounds.y > 1000 && n.bounds.y < 1500 &&
    n.bounds.width > 200 &&
    !/^(券后价|已售|官方正品|正品保障|售后无忧|旗舰店|客服|加购|领券抢购|购物袋|更多视频|可选规格|共\d+款|图片\d+|平台券|¥)/.test(n.text)
  );
  if (titleCandidates.length > 0) {
    // Pick the one with the longest text
    titleCandidates.sort((a, b) => b.text.length - a.text.length);
    result.title = titleCandidates[0].text;
  }

  // Find price — nodes starting with ¥
  const priceNodes = nodes.filter(n =>
    n.bounds && n.text && /^¥\d/.test(n.text) &&
    n.bounds.y > 1050 && n.bounds.y < 1200
  );
  if (priceNodes.length >= 2) {
    // First is original price, second might be discounted
    result.price = priceNodes[0].text;
    result.discountPrice = priceNodes.length >= 2 ? priceNodes[1].text : null;
  } else if (priceNodes.length === 1) {
    result.price = priceNodes[0].text;
  }

  // Find sales count
  const salesNode = nodes.find(n =>
    n.bounds && n.text && /已售\d+/.test(n.text) &&
    n.bounds.y > 1100 && n.bounds.y < 1300
  );
  if (salesNode) {
    result.sales = salesNode.text;
  }

  // Find shop name — usually near "旗舰店" or similar
  const shopNodes = nodes.filter(n =>
    n.bounds && n.text && n.bounds.y > 1500 && n.bounds.y < 1560 &&
    n.text.length > 2 && n.text.length < 50 &&
    !/^(客服|加购|领券抢购|购物袋|1|¥|券后价)$/.test(n.text)
  );
  if (shopNodes.length > 0) {
    // Take the leftmost text node (usually the shop name)
    shopNodes.sort((a, b) => a.bounds.x - b.bounds.x);
    result.shop = shopNodes[0].text;
  }

  return Object.keys(result).length >= 2 ? result : null;
}

/**
 * Navigate to product detail and extract data directly from UI.
 */
export async function readProductFromDetail(device) {
  try {
    const { nodes } = await dumpUi(device);
    return extractProductFromUi(nodes);
  } catch (e) {
    return null;
  }
}
