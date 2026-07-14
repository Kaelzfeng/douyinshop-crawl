import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const cliArgs = process.argv.slice(2);
const shareLink = cliArgs.find((arg) => !arg.startsWith('--'))
  || 'https://v.douyin.com/JtFzR4YIV8c/';
const traceVmCalls = cliArgs.includes('--trace-vm');
const outputDir = new URL('../output/playwright/', import.meta.url);
const outputName = `sign-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const outputUrl = new URL(outputName, outputDir);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36',
  viewport: { width: 430, height: 932 },
  locale: 'zh-CN',
});
const page = await context.newPage();

const preTransport = [];
const sdkLifecycle = [];
const network = [];
const responses = [];
const pending = [];

function requestIdentity(method, rawUrl, baseUrl) {
  try {
    const url = new URL(rawUrl, baseUrl);
    return `${String(method).toUpperCase()} ${url.origin}${url.pathname}`;
  } catch {
    return `${String(method).toUpperCase()} ${String(rawUrl).split('?')[0]}`;
  }
}

function buildTransformations(entries, baseUrl) {
  const transformations = [];
  const pendingUnsigned = new Map();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.transport !== 'xhr-open-outer') continue;

    const identity = requestIdentity(entry.method, entry.url, baseUrl);
    const signed = /[?&]a_bogus=/i.test(entry.url);
    if (!signed) {
      pendingUnsigned.set(identity, { index, entry });
      continue;
    }

    const input = pendingUnsigned.get(identity);
    if (!input) continue;

    const bodyEntry = entries.slice(index + 1).find((candidate) =>
      candidate.transport === 'xhr'
      && requestIdentity(candidate.method, candidate.url, baseUrl) === identity
      && /[?&]a_bogus=/i.test(candidate.url));

    transformations.push({
      identity,
      unsignedObservedAt: input.entry.observedAt,
      signedObservedAt: entry.observedAt,
      unsignedUrl: input.entry.url,
      signedUrl: entry.url,
      body: bodyEntry?.body ?? null,
      unsignedStack: input.entry.stack,
      signedStack: entry.stack,
    });
    pendingUnsigned.delete(identity);
  }

  return transformations;
}

await page.exposeFunction('__reportRequestBeforeTransport', (entry) => {
  preTransport.push({ observedAt: new Date().toISOString(), ...entry });
});

await page.exposeFunction('__reportSdkLifecycle', (entry) => {
  sdkLifecycle.push({ observedAt: new Date().toISOString(), ...entry });
});

await page.addInitScript(({ traceVmCalls }) => {
  const summarize = (value, depth = 0, seen = new WeakSet()) => {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (typeof value !== 'object') return `[${typeof value}]`;
    if (seen.has(value)) return '[circular]';
    if (depth >= 3) return Array.isArray(value) ? `[array:${value.length}]` : '[object]';

    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 30).map((item) => summarize(item, depth + 1, seen));
    }

    const result = {};
    for (const key of Object.keys(value).slice(0, 100)) {
      try {
        result[key] = summarize(value[key], depth + 1, seen);
      } catch (error) {
        result[key] = `[unreadable: ${error.message}]`;
      }
    }
    return result;
  };

  const reportSdk = (event, details = {}) => {
    void window.__reportSdkLifecycle({ event, ...details });
  };

  const wrapBdms = (value) => {
    if (!value || typeof value !== 'object' || typeof value.init !== 'function') return value;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'init');
    const original = value.init;
    if (original.__signProbeInitProxy) return value;

    const proxy = new Proxy(original, {
      apply(target, thisArg, args) {
        reportSdk('bdms.init.call', { args: summarize(args) });
        try {
          const result = Reflect.apply(target, thisArg, args);
          reportSdk('bdms.init.return', { result: summarize(result) });
          return result;
        } catch (error) {
          reportSdk('bdms.init.throw', { error: String(error?.stack || error) });
          throw error;
        }
      },
    });
    Object.defineProperty(proxy, '__signProbeInitProxy', { value: true });

    try {
      if (!descriptor || descriptor.configurable) {
        Object.defineProperty(value, 'init', {
          configurable: descriptor?.configurable ?? true,
          enumerable: descriptor?.enumerable ?? true,
          writable: true,
          value: proxy,
        });
      } else {
        value.init = proxy;
      }
      reportSdk('bdms.init.wrapped', {
        originalName: original.name,
        originalLength: original.length,
      });
    } catch (error) {
      reportSdk('bdms.init.wrap-failed', { error: error.message });
    }
    return value;
  };

  try {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'bdms');
    if (!descriptor || descriptor.configurable) {
      let current = descriptor?.value;
      Object.defineProperty(window, 'bdms', {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() {
          return current;
        },
        set(value) {
          current = wrapBdms(value);
          reportSdk('window.bdms.assigned', { value: summarize(value) });
        },
      });
      if (current) current = wrapBdms(current);
    }
  } catch (error) {
    reportSdk('window.bdms.watch-failed', { error: error.message });
  }

  if (traceVmCalls) {
    const nativeApply = Function.prototype.apply;
    const nativeToString = Function.prototype.toString;
    let active = false;
    let captured = 0;

    const applyProxy = new Proxy(nativeApply, {
      apply(target, calledFunction, args) {
        if (active) return Reflect.apply(target, calledFunction, args);

        const stack = new Error().stack || '';
        const fromBdms = /bdms(?:[-.][^/\\:]*)?\.js:1:/i.test(stack);
        if (!fromBdms || captured >= 1_000) {
          return Reflect.apply(target, calledFunction, args);
        }

        active = true;
        captured += 1;
        const details = {
          sequence: captured,
          functionName: calledFunction?.name || '',
          functionSource: (() => {
            try {
              return nativeToString.call(calledFunction).slice(0, 500);
            } catch (error) {
              return `[unreadable: ${error.message}]`;
            }
          })(),
          thisArg: summarize(args[0]),
          args: summarize(args[1]),
          stack: stack.split('\n').slice(0, 8).join('\n'),
        };

        try {
          const result = Reflect.apply(target, calledFunction, args);
          reportSdk('bdms.vm.external-call', { ...details, result: summarize(result) });
          return result;
        } catch (error) {
          reportSdk('bdms.vm.external-throw', {
            ...details,
            error: String(error?.stack || error),
          });
          throw error;
        } finally {
          active = false;
        }
      },
    });

    Object.defineProperty(Function.prototype, 'apply', {
      configurable: true,
      writable: true,
      value: applyProxy,
    });
  }

  const normalizeBody = (body) => {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    return Object.prototype.toString.call(body);
  };

  const report = (transport, method, url, body) => {
    if (!/jinritemai\.com|\/aweme\//i.test(String(url))) return;
    void window.__reportRequestBeforeTransport({
      transport,
      method,
      url: String(url),
      body: normalizeBody(body),
      stack: new Error().stack,
    });
  };

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function(input, init = {}) {
      const requestUrl = typeof input === 'string' ? input : input?.url;
      const requestMethod = init.method || input?.method || 'GET';
      const requestBody = init.body ?? null;
      report('fetch', requestMethod, requestUrl, requestBody);
      return originalFetch.apply(this, arguments);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__signProbeMethod = method;
    this.__signProbeUrl = url;
    report('xhr-open-inner', method, url, null);
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    report('xhr', this.__signProbeMethod || 'GET', this.__signProbeUrl, body);
    return originalSend.apply(this, arguments);
  };

  setInterval(() => {
    const currentOpen = XMLHttpRequest.prototype.open;
    if (currentOpen.__signProbeOuter) return;
    function outerOpen(method, url) {
      report('xhr-open-outer', method, url, null);
      return currentOpen.apply(this, arguments);
    }
    outerOpen.__signProbeOuter = true;
    XMLHttpRequest.prototype.open = outerOpen;
  }, 25);
}, { traceVmCalls });

page.on('request', (request) => {
  const url = request.url();
  if (!/jinritemai\.com|\/aweme\//i.test(url)) return;
  const task = request.allHeaders().then((headers) => {
    const safeHeaders = {};
    for (const name of ['content-type', 'origin', 'referer', 'user-agent']) {
      if (headers[name]) safeHeaders[name] = headers[name];
    }
    network.push({
      observedAt: new Date().toISOString(),
      method: request.method(),
      url,
      body: request.postData(),
      headers: safeHeaders,
      resourceType: request.resourceType(),
    });
  });
  pending.push(task);
});

page.on('response', (response) => {
  const url = response.url();
  if (!/jinritemai\.com|\/aweme\//i.test(url)) return;
  responses.push({
    observedAt: new Date().toISOString(),
    url,
    status: response.status(),
  });
});

let navigationError = null;
try {
  await page.goto(shareLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(15_000);
} catch (error) {
  navigationError = error.message;
}

await Promise.allSettled(pending);

const sdkGlobals = await page.evaluate(() => {
  const summarizeValue = (value) => {
    const summary = { type: typeof value };
    if (typeof value === 'function') {
      summary.name = value.name;
      summary.length = value.length;
      try {
        summary.source = Function.prototype.toString.call(value).slice(0, 4_000);
      } catch (error) {
        summary.sourceError = error.message;
      }
      summary.customProperties = {};
      for (const key of Object.getOwnPropertyNames(value)) {
        if (['length', 'name', 'arguments', 'caller', 'prototype'].includes(key)) continue;
        try {
          const property = value[key];
          if (typeof property === 'function') {
            summary.customProperties[key] = {
              type: 'function',
              name: property.name,
              length: property.length,
              source: Function.prototype.toString.call(property).slice(0, 4_000),
            };
          } else if (Array.isArray(property)) {
            summary.customProperties[key] = {
              type: 'array',
              length: property.length,
              preview: property.slice(0, 10).map((item) => {
                if (item == null || ['string', 'number', 'boolean'].includes(typeof item)) return item;
                return `[${typeof item}]`;
              }),
            };
          } else {
            summary.customProperties[key] = {
              type: typeof property,
              value: ['string', 'number', 'boolean'].includes(typeof property)
                ? property
                : null,
            };
          }
        } catch (error) {
          summary.customProperties[key] = { type: 'unreadable', error: error.message };
        }
      }
    } else if (typeof value === 'string') {
      summary.value = value.slice(0, 500);
    }
    return summary;
  };

  const names = Object.getOwnPropertyNames(window)
    .filter((name) => /sign|sec|bogus|crawler|bdms|msdk/i.test(name))
    .slice(0, 200);
  const details = {};
  for (const name of names) {
    try {
      const value = window[name];
      details[name] = {
        type: typeof value,
        keys: value && (typeof value === 'object' || typeof value === 'function')
          ? Object.keys(value).slice(0, 50)
          : [],
        value: summarizeValue(value),
        members: value && (typeof value === 'object' || typeof value === 'function')
          ? Object.fromEntries(Object.getOwnPropertyNames(value).slice(0, 50).map((key) => {
              try {
                return [key, summarizeValue(value[key])];
              } catch (error) {
                return [key, { type: 'unreadable', error: error.message }];
              }
            }))
          : {},
      };
    } catch (error) {
      details[name] = { type: 'unreadable', error: error.message };
    }
  }
  return details;
}).catch((error) => ({ __error: error.message }));

const directSignerProbe = await page.evaluate(() => {
  try {
    const init = window.bdms?.init;
    const signer = init?._v?.[2]?.[21];
    if (typeof signer !== 'function') {
      return { available: false };
    }

    const inputs = [
      { query: 'x=1', body: 'y=2' },
      { query: 'x=1', body: 'y=2' },
      { query: 'x=2', body: 'y=2' },
      { query: 'x=1', body: 'y=3' },
    ];
    const samples = inputs.map(({ query, body }) => {
      const signature = signer.call(null, query, body);
      return {
        query,
        body,
        signature,
        signatureLength: typeof signature === 'string' ? signature.length : null,
      };
    });

    return {
      available: true,
      entryPc: signer._v?.[0] ?? null,
      declaredArity: signer._v?.[1] ?? null,
      sharesDispatcherWithInit: signer._u === init._u,
      samples,
    };
  } catch (error) {
    return { available: false, error: String(error?.stack || error) };
  }
});

const transformations = buildTransformations(preTransport, page.url());
const artifact = {
  capturedAt: new Date().toISOString(),
  shareLink,
  traceVmCalls,
  finalPageUrl: page.url(),
  navigationError,
  preTransport,
  transformations,
  network,
  responses,
  sdkGlobals,
  sdkLifecycle,
  directSignerProbe,
  interpretation: {
    preTransportSigned: preTransport.some((entry) => /[?&]a_bogus=/i.test(entry.url)),
    networkSigned: network.some((entry) => /[?&]a_bogus=/i.test(entry.url)),
    pairedTransformations: transformations.length,
  },
};

await mkdir(outputDir, { recursive: true });
await writeFile(outputUrl, JSON.stringify(artifact, null, 2), 'utf8');
console.log(JSON.stringify({
  output: outputUrl.pathname,
  finalPageUrl: (() => {
    try {
      const url = new URL(artifact.finalPageUrl);
      return `${url.origin}${url.pathname}`;
    } catch {
      return artifact.finalPageUrl;
    }
  })(),
  preTransportCount: preTransport.length,
  networkCount: network.length,
  responseCount: responses.length,
  interpretation: artifact.interpretation,
}, null, 2));

await browser.close();
