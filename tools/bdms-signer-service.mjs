import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';

const bdmsPath = new URL('../reverse/web_sign/bdms-1.0.0.38.js', import.meta.url);
const bdmsSource = await readFile(bdmsPath, 'utf8');
const browser = await chromium.launch({
  channel: process.env.DOUYIN_SIGNER_BROWSER_CHANNEL || 'msedge',
  headless: process.env.DOUYIN_SIGNER_HEADFUL !== '1',
});
const context = await browser.newContext({
  userAgent: process.env.DOUYIN_SIGNER_USER_AGENT
    || 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36',
  viewport: { width: 430, height: 932 },
  locale: 'zh-CN',
});
const page = await context.newPage();

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function close() {
  await browser.close().catch(() => {});
}

try {
  await page.setContent('<!doctype html><meta charset="utf-8"><title>local bdms signer</title>');
  await page.addScriptTag({ content: bdmsSource });

  const metadata = await page.evaluate(() => {
    const init = window.bdms?.init;
    const signer = init?._v?.[2]?.[21];
    if (typeof signer !== 'function') {
      throw new Error('bdms signer closure was not found at init._v[2][21]');
    }
    return {
      initEntryPc: init._v?.[0] ?? null,
      signerEntryPc: signer._v?.[0] ?? null,
      signerArity: signer._v?.[1] ?? null,
    };
  });

  writeMessage({ type: 'ready', ...metadata });

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      writeMessage({ ok: false, error: `invalid JSON: ${error.message}` });
      continue;
    }

    const id = request.id ?? null;
    if (request.op === 'close') {
      writeMessage({ id, ok: true });
      break;
    }

    if (request.op !== 'sign') {
      writeMessage({ id, ok: false, error: `unsupported operation: ${request.op}` });
      continue;
    }

    if (typeof request.query !== 'string' || typeof request.body !== 'string') {
      writeMessage({ id, ok: false, error: 'query and body must both be strings' });
      continue;
    }
    if (/(?:^|&)a_bogus=/i.test(request.query.replace(/^\?/, ''))) {
      writeMessage({ id, ok: false, error: 'query already contains a_bogus' });
      continue;
    }

    try {
      const signature = await page.evaluate(({ query, body }) => {
        const signer = window.bdms?.init?._v?.[2]?.[21];
        if (typeof signer !== 'function') throw new Error('bdms signer is unavailable');
        return signer.call(null, query.replace(/^\?/, ''), body);
      }, { query: request.query, body: request.body });

      if (typeof signature !== 'string' || signature.length !== 44) {
        throw new Error(`unexpected signer result: ${typeof signature} length ${signature?.length}`);
      }
      writeMessage({ id, ok: true, a_bogus: signature });
    } catch (error) {
      writeMessage({ id, ok: false, error: String(error?.stack || error) });
    }
  }
} catch (error) {
  writeMessage({ type: 'fatal', error: String(error?.stack || error) });
  process.exitCode = 1;
} finally {
  await close();
}
