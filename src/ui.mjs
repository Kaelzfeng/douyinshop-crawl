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
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^I(?=(?:【[^】]+】)?Golden\s*Goose)/i, '');
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

export function findProductCandidates(nodes) {
  const seen = new Set();
  const candidates = [];

  for (const node of nodes) {
    const title = nodeValue(node);
    if (!node.bounds || !isGoldenGooseTitle(title)) continue;
    if (node.bounds.y < 200) continue;
    if (node.bounds.width < 120 || node.bounds.height > 120) continue;
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
