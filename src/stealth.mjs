/**
 * Stealth browser setup — anti-fingerprinting measures for Playwright Chromium.
 *
 * Implements browser-level evasion to prevent Douyin from detecting
 * automated access. Uses Playwright's built-in APIs (addInitScript,
 * launch args, context options) — no external dependencies.
 */

import { chromium } from 'playwright';

// ---------------------------------------------------------------------------
// Chromium launch flags to suppress automation signals
// ---------------------------------------------------------------------------
export const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-dev-shm-usage',
  '--disable-infobars',
  '--hide-scrollbars',
  '--no-default-browser-check',
  '--no-first-run',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-component-update',
  '--disable-client-side-phishing-detection',
  '--disable-crash-reporter',
];

// ---------------------------------------------------------------------------
// Inject a comprehensive evasion script before any page loads.
// Must be called via page.addInitScript() BEFORE page.goto().
// ---------------------------------------------------------------------------
export const STEALTH_LITE_SCRIPT = `
  // Minimal anti-detection: only hide webdriver flag
  // Aggressive overrides (plugins, languages, canvas, etc.) trip Douyin's risk detection
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
  });

  // Remove Playwright-specific traces
  delete self.__pw_init_script;
  delete self.__pw_manual;
  delete self.__pw_traces;
  delete self.__pw_testing;
  if (self.playwright) delete self.playwright;
  if (self.__playwright) delete self.__playwright;
`;

export const STEALTH_INIT_SCRIPT = `
  // 1. Hide webdriver flag — the #1 bot detection vector
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
  });

  // 2. Override plugins — real Android Chrome has at least 3
  //    Use try-catch since PluginArray.prototype may not exist in all contexts
  try {
    const pluginProto = PluginArray.prototype;
    const pluginsArr = Array.from({ length: 3 }, (_, i) => {
      const names = ['Chrome PDF Plugin', 'Chrome PDF Viewer', 'Native Client'];
      const files = ['internal-pdf-viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'internal-nacl-plugin'];
      const descs = ['Portable Document Format', '', ''];
      return {
        name: names[i], filename: files[i], description: descs[i], length: i < 2 ? 1 : 0,
        item: function(j) { return j === 0 ? { type: 'application/pdf', suffixes: 'pdf', description: '' } : null; },
        namedItem: function() { return null; },
        [Symbol.iterator]: Array.prototype[Symbol.iterator],
      };
    });
    pluginsArr.item = function(i) { return this[i] || null; };
    pluginsArr.namedItem = function() { return null; };
    pluginsArr.refresh = function() {};
    Object.setPrototypeOf(pluginsArr, pluginProto);
    Object.defineProperty(navigator, 'plugins', { get: () => pluginsArr });
  } catch (_) {
    // Fallback: just ensure length > 0
    Object.defineProperty(navigator, 'plugins', { get: () => ({ length: 3, item: () => null, namedItem: () => null, refresh: () => {} }) });
  }

  // 3. Override languages — consistent with zh-CN locale
  Object.defineProperty(navigator, 'languages', {
    get: () => ['zh-CN', 'zh', 'en'],
  });

  // 4. Override platform
  Object.defineProperty(navigator, 'platform', {
    get: () => 'Linux armv8l',
  });

  // 5. Override hardwareConcurrency and deviceMemory (injected per-session via args)
  //    (these are set below by the caller via variables)

  // 6. chrome.runtime — real Chrome has {} not undefined
  if (typeof chrome === 'undefined') {
    window.chrome = {};
  }
  if (!chrome.runtime) {
    chrome.runtime = {};
  }
  if (!chrome.runtime.id) {
    chrome.runtime.id = undefined;
  }
  // chrome.loadTimes — some sites check this
  if (!chrome.loadTimes) {
    chrome.loadTimes = () => ({});
  }
  // chrome.csi
  if (!chrome.csi) {
    chrome.csi = () => ({});
  }
  // chrome.app (should NOT exist on mobile, but some detection checks)
  if (chrome.app) {
    delete chrome.app;
  }

  // 7. Patch permissions.query — some bot detection uses this
  const originalQuery = navigator.permissions.query;
  if (originalQuery) {
    navigator.permissions.query = function (parameters) {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return originalQuery.call(navigator.permissions, parameters);
    };
  }

  // 8. Override screen properties to match viewport
  const overrideScreen = () => {
    // screen.width/height reflect device pixels = css pixels * deviceScaleFactor
    // These are set per fingerprint; defaults below get overridden if caller passes values
  };

  // 9. Remove Playwright / automation traces
  delete self.__pw_init_script;
  delete self.__pw_manual;
  delete self.__pw_traces;
  delete self.__pw_testing;
  if (self.playwright) delete self.playwright;
  if (self.__playwright) delete self.__playwright;

  // 10. Override navigator.vendor
  Object.defineProperty(navigator, 'vendor', {
    get: () => 'Google Inc.',
  });
  Object.defineProperty(navigator, 'vendorSub', {
    get: () => '',
  });
  Object.defineProperty(navigator, 'productSub', {
    get: () => '20030107',
  });

  // 11. Intl.DateTimeFormat — verify timezone matches (set via context option)
  //     (no override needed; Playwright respects the timezoneId option)

  // 12. Override navigator.getBattery if present (some fingerprinting uses this)
  if (navigator.getBattery) {
    navigator.getBattery = () => Promise.resolve({
      charging: true,
      chargingTime: Infinity,
      dischargingTime: Infinity,
      level: 1,
      onchargingchange: null,
      onchargingtimechange: null,
      ondischargingtimechange: null,
      onlevelchange: null,
    });
  }

  // 13. Override navigator.connection
  if (navigator.connection) {
    // Keep real connection but override downlink for consistency
  } else {
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
        onchange: null,
      }),
    });
  }

  // 14. Override navigator.mediaDevices.enumerateDevices — common fingerprint vector
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    const origEnumDev = navigator.mediaDevices.enumerateDevices;
    navigator.mediaDevices.enumerateDevices = function () {
      return origEnumDev.call(navigator.mediaDevices).then((devices) => {
        // Return empty — real phones often have no labeled devices
        return devices.map((d) => ({ ...d, label: '', deviceId: '', groupId: '' }));
      }).catch(() => []);
    };
  }

  // 15. Override navigator.userAgentData if present (User-Agent Client Hints)
  if (navigator.userAgentData) {
    const origGetHighEntropy = navigator.userAgentData.getHighEntropyValues;
    if (origGetHighEntropy) {
      navigator.userAgentData.getHighEntropyValues = function (hints) {
        return origGetHighEntropy.call(navigator.userAgentData, hints).then((values) => ({
          ...values,
          fullVersionList: (values.fullVersionList || []).map((item) => {
            // Keep brand info but randomize versions slightly
            return item;
          }),
        }));
      };
    }
  }

  // 16. Override canvas fingerprinting with careful error handling
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
      try {
        if (this.width > 4 && this.height > 4) {
          const ctx = this.getContext('2d');
          if (ctx && Math.random() < 0.005) {
            const px = ctx.getImageData(1, 1, 1, 1);
            if (px && px.data && px.data.length >= 4) {
              px.data[3] = px.data[3] ^ 1;
              ctx.putImageData(px, 1, 1);
            }
          }
        }
      } catch (_) { /* canvas may be tainted, too small, or not 2d */ }
      return origToDataURL.apply(this, arguments);
    };
  } catch (_) { /* ignore */ }
`;

// ---------------------------------------------------------------------------
// Browser launch helper — launches Chromium with all stealth flags
// ---------------------------------------------------------------------------
export async function launchStealthBrowser({ headless = true, proxy } = {}) {
  const args = [...STEALTH_LAUNCH_ARGS];

  if (proxy) {
    args.push(`--proxy-server=${proxy.server}`);
  }

  // Try bundled Chromium first (best stealth), fall back to msedge
  let browser;
  try {
    browser = await chromium.launch({ headless, args });
  } catch (error) {
    if (error.message && error.message.includes('Executable doesn\'t exist')) {
      console.warn('[stealth] Bundled Chromium not found, falling back to msedge channel.');
      browser = await chromium.launch({ channel: 'msedge', headless, args });
    } else {
      throw error;
    }
  }

  return browser;
}

// ---------------------------------------------------------------------------
// Create an isolated BrowserContext with a given fingerprint.
// Each context has its own cookies, storage, and browser fingerprint.
// ---------------------------------------------------------------------------
export async function createStealthContext(browser, fingerprint) {
  const { userAgent, viewport, deviceScaleFactor, hasTouch, isMobile, locale, timezoneId, hardwareConcurrency, deviceMemory } = fingerprint;

  // Build a per-context init script that sets the fingerprint-specific values
  const initScript = `
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => ${hardwareConcurrency},
    });
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => ${deviceMemory},
    });
    // screen dimensions in device pixels
    Object.defineProperty(screen, 'width', {
      get: () => ${Math.round(viewport.width * deviceScaleFactor)},
    });
    Object.defineProperty(screen, 'height', {
      get: () => ${Math.round(viewport.height * deviceScaleFactor)},
    });
    Object.defineProperty(screen, 'availWidth', {
      get: () => ${Math.round(viewport.width * deviceScaleFactor)},
    });
    Object.defineProperty(screen, 'availHeight', {
      get: () => ${Math.round((viewport.height - 48) * deviceScaleFactor)},
    });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
    // window outer dimensions
    Object.defineProperty(window, 'outerWidth', {
      get: () => ${viewport.width},
    });
    Object.defineProperty(window, 'outerHeight', {
      get: () => ${viewport.height},
    });
    Object.defineProperty(window, 'innerWidth', {
      get: () => ${viewport.width},
    });
    Object.defineProperty(window, 'innerHeight', {
      get: () => ${viewport.height},
    });
  `;

  const context = await browser.newContext({
    userAgent,
    viewport,
    deviceScaleFactor,
    hasTouch,
    isMobile,
    locale,
    timezoneId,
    // Prevent automatic HTTPS upgrades that might leak fingerprint
    ignoreHTTPSErrors: true,
    // Extra HTTP headers for User-Agent Client Hints
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Sec-CH-UA': '"Chromium";v="135", "Google Chrome";v="135", "Not?A_Brand";v="99"',
      'Sec-CH-UA-Mobile': '?1',
      'Sec-CH-UA-Platform': '"Android"',
    },
    // Permissions to grant (mimics a real phone)
    permissions: [],
    // Geolocation (Beijing area — common for Douyin users)
    geolocation: { latitude: 39.9042, longitude: 116.4074 },
  });

  // Inject the stealth script on every page in this context
  await context.addInitScript(STEALTH_LITE_SCRIPT);
  // Inject the fingerprint-specific overrides
  await context.addInitScript(initScript);

  return context;
}

// ---------------------------------------------------------------------------
// Apply stealth to an existing page (for singleton use).
// Must be called BEFORE page.goto().
// ---------------------------------------------------------------------------
export async function applyStealth(page) {
  await page.addInitScript(STEALTH_LITE_SCRIPT);
  return page;
}
