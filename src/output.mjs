import fs from 'node:fs/promises';
import path from 'node:path';

export const OUTPUT_FIELDS = ['搜索关键词', '商品id', '商品品名', '店铺名', '价格', '销量', '分享的链接'];

function fieldValue(product, field) {
  if (field === '商品id') return product.商品id || product.productId || '';
  return product[field] ?? '';
}

export function productIdentityKey(product) {
  const productId = product.商品id || product.productId;
  if (productId) return `id:${productId}`;

  const shareLink = product.分享的链接;
  if (shareLink) return `link:${shareLink}`;

  const title = product.商品品名 || '';
  const shop = product.店铺名 || '';
  return `title-shop:${title}|${shop}`;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(products) {
  const rows = [OUTPUT_FIELDS.join(',')];
  for (const product of products) {
    rows.push(OUTPUT_FIELDS.map((field) => csvCell(fieldValue(product, field))).join(','));
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

export async function loadCheckpoint(checkpointPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    return Array.isArray(parsed.products) ? parsed.products : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeArtifacts({ products, outputPath, checkpointPath, summaryPath, summary }) {
  await Promise.all([
    fs.mkdir(path.dirname(outputPath), { recursive: true }),
    fs.mkdir(path.dirname(checkpointPath), { recursive: true }),
    fs.mkdir(path.dirname(summaryPath), { recursive: true }),
  ]);
  await fs.writeFile(outputPath, toCsv(products), 'utf8');
  await fs.writeFile(checkpointPath, `${JSON.stringify({ products }, null, 2)}\n`, 'utf8');
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}
