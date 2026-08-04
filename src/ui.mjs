const ENTITY_MAP = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

function decodeXml(value = '') {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (_, entity) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITY_MAP[entity.toLowerCase()] ?? _;
  });
}

export function cleanUiText(value = '') {
  return decodeXml(value)
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^I(?=(?:[^]+)?Golden\s*Goose)/i, '');
}

function parseBounds(value = '') {
  const match = value.match(/^\[(\d+),(\d+)]\[(\d+),(\d+)]$/);
  if (!match) return null;
  const [, x1, y1, x2, y2] = match.map(Number);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function parseUiNodes(xml) {
  const nodes = [];
  for (const nodeMatch of xml.matchAll(/<node\b([^>]*)\/?\s*>/g)) {
    const attrs = {};
    for (const attrMatch of nodeMatch[1].matchAll(/([\w:+.-]+)="([^"]*)"/g)) {
      attrs[attrMatch[1]] = decodeXml(attrMatch[2]);
    }
    nodes.push({
      ...attrs,
      text: cleanUiText(attrs.text),
      desc: cleanUiText(attrs['content-desc']),
      bounds: parseBounds(attrs.bounds),
    });
  }
  return nodes;
}

export function nodeValue(node) {
  return cleanUiText(node.desc || node.text || '');
}

export function findByResource(nodes, suffix) {
  return nodes.find((node) => (node['resource-id'] || '').endsWith(suffix));
}

export function findByValue(nodes, pattern) {
  return nodes.find((node) => pattern.test(nodeValue(node)));
}

export function centerOf(node) {
  if (!node?.bounds) return null;
  return {
    x: Math.round(node.bounds.x + node.bounds.width / 2),
    y: Math.round(node.bounds.y + node.bounds.height / 2),
  };
}

function isGoldenGooseTitle(value) {
  const compact = value.toLowerCase().replace(/[^a-z]/g, '');
  return compact.includes('goldengoose') && value.length >= 16;
}

function isSearchProductTitle(value, query = '') {
  // Golden Goose products always match
  if (isGoldenGooseTitle(value)) return true;

  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const q = String(query || '').trim().toLowerCase();

  // No query: match Golden Goose / GGDB / 小脏鞋 products
  if (!q) {
    if (value.includes('小脏鞋') || value.includes('脏脏鞋') || value.includes('脏鞋')) return true;
    return value.length >= 8 && value.length <= 200
      && /ggdb|golden|goose/i.test(compact)
      && !/^(搜索|综合|销量|价格|筛选|店铺|直播|视频|用户|商品)/.test(value);
  }

  // ggdb: must contain ggdb (case-insensitive via compact)
  if (q === 'ggdb') {
    return compact.includes('ggdb');
  }

  // 小脏鞋: match 小脏鞋 / 脏脏鞋 / 脏鞋 / GGDB / Golden Goose
  if (q === '小脏鞋') {
    if (value.includes('小脏鞋')) return true;
    if (value.includes('脏脏鞋')) return true;
    if (compact.includes('脏鞋')) return true;
    // Also catch GGDB / Golden Goose products surfaced by search
    if (compact.includes('ggdb')) return true;
    if (compact.includes('goldengoose')) return value.length >= 8;
    return false;
  }

  // Any other query: must appear literally in compact title
  const cq = q.replace(/[^a-z0-9]/g, '');
  if (!cq) return false; // query was purely non-alphanumeric (Chinese etc), no match
  return compact.includes(cq);
}

function hasNearbyProductSignal(nodes, titleNode) {
  return nodes.some((other) => {
    if (!other.bounds) return false;
    const value = nodeValue(other);
    if (!value) return false;
    const nearY = other.bounds.y >= titleNode.bounds.y - 80
      && other.bounds.y <= titleNode.bounds.y + 260;
    const overlapsX = other.bounds.x < titleNode.bounds.x + titleNode.bounds.width + 80
      && other.bounds.x + other.bounds.width > titleNode.bounds.x - 80;
    return nearY && overlapsX && /¥|￥|已售|券后价|到手价|立减|包邮|\d+件/.test(value);
  });
}

export function findProductCandidates(nodes, query = '') {
  const seen = new Set();
  const candidates = [];

  for (const node of nodes) {
    const title = nodeValue(node);
    if (!node.bounds || !isSearchProductTitle(title, query)) continue;
    if (node.bounds.y < 200) continue;
    if (node.bounds.width < 120 || node.bounds.height > 120) continue;
    // Skip sales/promotional text misidentified as products
    if (/^(已售|全店已售|券后价|到手价|好评率|店铺销量|包邮|\d+件|周上新|官方正品|正品保障|售后无忧)/.test(title)) continue;
    if (!hasNearbyProductSignal(nodes, node)) continue;
    if (seen.has(title)) continue;

    const isLive = nodes.some((other) => {
      if (!other.bounds || !/直播/.test(nodeValue(other))) return false;
      const overlapsX = other.bounds.x < node.bounds.x + node.bounds.width
        && other.bounds.x + other.bounds.width > node.bounds.x;
      return overlapsX && other.bounds.y < node.bounds.y && other.bounds.y > node.bounds.y - 650;
    });

    seen.add(title);
    candidates.push({
      title,
      isLive,
      titleBounds: node.bounds,
      tapPoint: {
        x: Math.round(node.bounds.x + node.bounds.width / 2),
        y: Math.max(150, Math.round(node.bounds.y - 220)),
      },
    });
  }

  return candidates.sort((a, b) => a.titleBounds.y - b.titleBounds.y || a.titleBounds.x - b.titleBounds.x);
}
