/**
 * Node wrapper around tools/enrich_csv_h5.py (H5 pack + a_bogus).
 * Used by semi-crawl to fill 商品品名/价格/销量/店铺名 from product_id.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'tools', 'enrich_csv_h5.py');

function runPython(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', args, {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`h5-enrich timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* continue */
    }
  }
  return null;
}

/**
 * Enrich a list of product objects (mutates copies).
 * @param {Array<Record<string, string>>} products
 * @param {{ onlyMissing?: boolean, delayMs?: number }} [opts]
 */
export async function enrichProductsViaH5(products, opts = {}) {
  if (!products?.length) return { products: [], summary: { ok: false, reason: 'empty' } };

  const tmpDir = path.join(ROOT, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const stamp = Date.now();
  const inCsv = path.join(tmpDir, `h5-enrich-in-${stamp}.csv`);
  const outCsv = path.join(tmpDir, `h5-enrich-out-${stamp}.csv`);

  const fields = ['搜索关键词', '商品id', '商品品名', '店铺名', '价格', '销量', '分享的链接'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [
    fields.join(','),
    ...products.map((p) => fields.map((f) => esc(p[f])).join(',')),
  ].join('\r\n');
  await fs.writeFile(inCsv, `\uFEFF${body}\r\n`, 'utf8');

  const args = [
    SCRIPT,
    inCsv,
    '--output',
    outCsv,
    '--delay-ms',
    String(opts.delayMs ?? 500),
  ];
  if (opts.onlyMissing) args.push('--only-missing');

  const { code, stdout, stderr } = await runPython(args, {
    timeoutMs: Math.max(60_000, products.length * 20_000),
  });
  const summary = parseLastJsonLine(stdout) || { ok: false, code, stderr: stderr.slice(0, 300) };

  if (code !== 0 && !summary.ok) {
    throw new Error(`H5 enrich failed: ${summary.error || stderr.slice(0, 200) || stdout.slice(-200)}`);
  }

  const text = await fs.readFile(outCsv, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const enriched = lines.slice(1).filter(Boolean).map((line) => {
    // simple CSV split (fields rarely quoted multi-comma in our writes)
    const cols = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = !q;
      } else if (ch === ',' && !q) {
        cols.push(cur);
        cur = '';
      } else cur += ch;
    }
    cols.push(cur);
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = cols[i] ?? '';
    });
    return obj;
  });

  // cleanup temps (best effort)
  await fs.unlink(inCsv).catch(() => {});
  // keep outCsv for debug; optional delete

  return { products: enriched, summary, stdout: stdout.slice(-500) };
}

/**
 * Enrich a single product by id.
 */
export async function enrichOneProductId(productId, base = {}) {
  const { products } = await enrichProductsViaH5(
    [
      {
        搜索关键词: base.搜索关键词 || '',
        商品id: String(productId),
        商品品名: base.商品品名 || '',
        店铺名: base.店铺名 || '',
        价格: base.价格 || '',
        销量: base.销量 || '',
        分享的链接: base.分享的链接 || '',
      },
    ],
    { onlyMissing: false },
  );
  return products[0] || null;
}
