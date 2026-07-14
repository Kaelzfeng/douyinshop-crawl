/**
 * Native Chain Hook — Douyin Mall Retrofit2 + TTNet/Cronet + MetaSec Interceptor
 *
 * Hooks the full native API chain for /aweme/v2/shop/promotion/pack/
 * (the non-H5 endpoint used by ProductDetailActivity).
 *
 * Architecture:
 *   1. Java layer: Retrofit2 Request.Builder → OkHttp Request → BaseSsCall
 *   2. Native layer: libmetasec_ml.so sign function (via RegisterNatives ONLY)
 *
 * Uses frida-java-bridge for Java interop on Frida 17.
 *
 * Build:  npx frida-compile hook/native-chain.js -o hook/native-chain.bundle.js -B iife -S
 * Inject: node hook/run-native-chain.mjs
 *
 * Opt-in features (set via globalOpts before load):
 *   BYPASS_TURING=1 — enable BdTuringVerifyActivity bypass
 *   TRACE_ALL_EXPORTS=1 — hook ALL metasec exports (⚠️ may crash)
 *   TRACE_CRONET=1 — hook Cronet/TTNet exports (⚠️ may crash)
 */

import Java from 'frida-java-bridge';

// ─── Opt-in flags ──────────────────────────────────────────────────────────
// Set these BEFORE the script loads via Frida's global/env, or edit defaults here.
const OPTS = {
  BYPASS_TURING: (typeof globalThis !== 'undefined' && globalThis.BYPASS_TURING) || false,
  TRACE_ALL_EXPORTS: (typeof globalThis !== 'undefined' && globalThis.TRACE_ALL_EXPORTS) || false,
  TRACE_CRONET: (typeof globalThis !== 'undefined' && globalThis.TRACE_CRONET) || false,
};

const APP_ID = 'com.ss.android.ugc.livelite';
const TARGET_API = '/aweme/v2/shop/promotion/pack/';
const TARGET_HOSTS = ['jinritemai.com', 'douyin.com', 'snssdk.com', 'bytedance.com', 'ecombdapi.com'];
const METASEC_LIB = 'libmetasec_ml.so';

// ─── State ─────────────────────────────────────────────────────────────────
const captured = {
  requests: [],
  signCalls: [],
  nativeEvents: [],
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function isTargetUrl(url) {
  if (!url) return false;
  const s = String(url);
  return TARGET_HOSTS.some((h) => s.includes(h)) &&
    (s.includes('/aweme/') || s.includes('/ecom/') || s.includes('/shop/'));
}

function isPackApi(url) {
  if (!url) return false;
  const s = String(url);
  return s.includes('/promotion/pack') || s.includes('/shop/promotion/');
}

function redact(str, maxLen) {
  // Returns length + presence info, never the raw value
  if (str == null) return { present: false, length: 0 };
  const s = String(str);
  const result = { present: true, length: s.length };
  if (typeof maxLen === 'number' && s.length <= maxLen) {
    result.preview = s.slice(0, maxLen);
  }
  return result;
}

function headerNameOnly(headerStr) {
  // Extract just the header name from "Name: Value"
  const colon = headerStr.indexOf(':');
  return colon > 0 ? headerStr.slice(0, colon) : headerStr;
}

// Extract the actual value from a Java.Field wrapper or direct value.
// In frida-java-bridge on obfuscated APKs, field access may return a Field
// object whose toString() looks like:
//   Java.Field{holder: ..., value: <actualValue>}
function extractJavaValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  // If it's a Java.Field wrapper, parse out the value
  const str = String(raw);
  if (str.startsWith('Java.Field{')) {
    const match = str.match(/value:\s*(.+?)(?:,\s*\w+:|\})/);
    if (match) return match[1];
    // Fallback: try to find value: ... up to closing brace
    const match2 = str.match(/value:\s*(.+?)\}(?:,\s*\w+:|$)/);
    if (match2) return match2[1];
    return null;
  }
  return str;
}

// Safe Java method/field access — handles both direct values and Field wrappers
function safeJavaStr(obj, methodName) {
  try {
    const raw = obj[methodName];
    if (raw === undefined || raw === null) return null;
    // If it's callable and the result is useful, call it
    if (typeof raw === 'function' && methodName !== 'build') {
      try {
        const called = raw.call(obj);
        const extracted = extractJavaValue(called);
        if (extracted) return extracted;
      } catch (e) { /* fall through to extractJavaValue */ }
    }
    return extractJavaValue(raw);
  } catch (e) {
    return null;
  }
}

function safeJavaObj(obj, methodName) {
  try {
    const raw = obj[methodName];
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'function' && methodName !== 'build') {
      try { return raw.call(obj); } catch (e) { /* fall through */ }
    }
    return raw;
  } catch (e) {
    return null;
  }
}

function sendEvent(type, data) {
  send({ type, pid: Process.id, arch: Process.arch, ts: Date.now(), ...data });
}

// ─── 1. Java Hooks (frida-java-bridge) ──────────────────────────────────────
function installJavaHooks() {
  if (!Java.available) {
    setTimeout(installJavaHooks, 500);
    return;
  }

  Java.perform(() => {
    // ── 1a. Retrofit2 Request.Builder.build() — PRIMARY ──
    try {
      const RetrofitRequestBuilder = Java.use('com.bytedance.retrofit2.client.Request$Builder');
      const origRetrofitBuild = RetrofitRequestBuilder.build;
      RetrofitRequestBuilder.build.implementation = function () {
        const request = origRetrofitBuild.call(this);
        try {
          // Retrofit2 Request has public fields: url, method, headers, body
          const url = safeJavaStr(request, 'url');
          const method = safeJavaStr(request, 'method');

          if (url && isTargetUrl(url)) {
            // Collect header NAMES only (no values) for listing
            const headerNames = [];
            try {
              const headers = request['headers']; // List<Header> field
              if (headers && typeof headers.size === 'function') {
                const size = headers.size();
                for (let i = 0; i < size && i < 50; i++) {
                  try {
                    const h = headers.get(i);
                    const name = safeJavaStr(h, 'name');
                    if (name) headerNames.push(name);
                  } catch (e) { /* skip */ }
                }
              }
            } catch (e) { /* best-effort */ }

            // Detect signing-related header names
            const signHeaders = headerNames.filter((n) =>
              /bogus|sign|token|fp|verify|auth|metasec|ttnet|gorgan|argus|khronos|ladon|ss-stub/i.test(n)
            );

            // Try to read body/promotion_ids
            let bodyInfo = { present: false };
            try {
              const body = request['body']; // TypedOutput field
              if (body) {
                bodyInfo.present = true;
                // Try to read as string if it has a readable method
                try {
                  const bodyStr = safeJavaStr(body, 'toString');
                  if (bodyStr && bodyStr.length < 5000) {
                    bodyInfo.hasPromotionIds = bodyStr.includes('promotion_ids');
                    bodyInfo.length = bodyStr.length;
                  }
                } catch (e) { /* ignore */ }
              }
            } catch (e) { /* ignore */ }

            const entry = {
              layer: 'retrofit2',
              method: method || '?',
              url: url,
              headerNames: headerNames,
              signHeaderNames: signHeaders,
              bodyInfo: bodyInfo,
              bodyEncrypted: request['isBodyEncryptEnabled'] || false,
              queryEncrypted: request['isQueryEncryptEnabled'] || false,
            };
            captured.requests.push(entry);

            if (isPackApi(url)) {
              sendEvent('pack-request', entry);
              console.log('\n[RETROFIT REQ] ' + method + ' ' + url);
              if (signHeaders.length > 0) {
                console.log('  Sign headers: ' + signHeaders.join(', '));
              }
              if (bodyInfo.present) {
                console.log('  Body: present=' + bodyInfo.present + ' hasPromotionIds=' + (bodyInfo.hasPromotionIds || false) + ' len=' + (bodyInfo.length || 0));
              }
            }
          }
        } catch (e) {
          sendEvent('hook-error', { layer: 'retrofit2-build', error: String(e) });
        }
        return request;
      };
      sendEvent('hook-ready', { target: 'Retrofit2 Request.Builder.build()' });
      console.log('[JAVA] Retrofit2 Request.Builder.build() hooked');
    } catch (e) {
      sendEvent('hook-failed', { target: 'Retrofit2 Request.Builder.build()', error: String(e) });
      console.log('[JAVA] Retrofit2 Request.Builder not found: ' + String(e).slice(0, 120));
    }

    // ── 1b. OkHttp Request.Builder.build() — FALLBACK ──
    try {
      const OkHttpRequestBuilder = Java.use('okhttp3.Request$Builder');
      const origOkHttpBuild = OkHttpRequestBuilder.build;
      OkHttpRequestBuilder.build.implementation = function () {
        const request = origOkHttpBuild.call(this);
        try {
          // OkHttp Request uses METHODS: url(), method(), headers()
          const urlObj = safeJavaObj(request, 'url');
          const url = urlObj ? String(urlObj) : null;

          if (url && isPackApi(url)) {
            const method = safeJavaStr(request, 'method') || '?';
            const headerNames = [];
            try {
              const headers = safeJavaObj(request, 'headers');
              if (headers && typeof headers.size === 'function') {
                for (let i = 0; i < headers.size() && i < 50; i++) {
                  try {
                    headerNames.push(String(headers.name(i)));
                  } catch (e) { /* skip */ }
                }
              }
            } catch (e) { /* ignore */ }

            const signHeaders = headerNames.filter((n) =>
              /bogus|sign|token|fp|verify|auth|metasec|ttnet|gorgan|argus|khronos|ladon|ss-stub/i.test(n)
            );

            console.log('\n[OKHTTP REQ] ' + method + ' ' + url);
            if (signHeaders.length > 0) {
              console.log('  Sign headers: ' + signHeaders.join(', '));
            }

            const entry = {
              layer: 'okhttp',
              method: method,
              url: url,
              headerNames: headerNames,
              signHeaderNames: signHeaders,
            };
            captured.requests.push(entry);
            sendEvent('pack-request', entry);
          }
        } catch (e) { /* best-effort */ }
        return request;
      };
      sendEvent('hook-ready', { target: 'OkHttp Request.Builder.build()' });
      console.log('[JAVA] OkHttp Request.Builder.build() hooked');
    } catch (e) {
      sendEvent('hook-failed', { target: 'OkHttp Request.Builder.build()', error: String(e) });
      console.log('[JAVA] OkHttp Request.Builder not found: ' + String(e).slice(0, 120));
    }

    // ── 1c. BaseSsCall.enqueue() — capture signed request dispatch ──
    // BaseSsCall is abstract; the concrete enqueue lives in subclasses.
    // Try multiple known subclasses; fall back to SsCall interface.
    const ssCallTargets = [
      'com.bytedance.frameworks.baselib.network.http.impl.BaseSsCall',
      'com.bytedance.retrofit2.client.SsCall',
    ];
    let ssCallHooked = false;
    for (const target of ssCallTargets) {
      if (ssCallHooked) break;
      try {
        const SsCall = Java.use(target);
        // Check if enqueue exists on this class
        let enqueueMethod = null;
        try {
          enqueueMethod = SsCall.enqueue;
        } catch (e) { continue; }

        if (typeof enqueueMethod === 'undefined') continue;

        // Try overload resolution
        let origEnqueue;
        try {
          origEnqueue = SsCall.enqueue.overload('com.bytedance.retrofit2.Callback');
        } catch (e1) {
          try {
            origEnqueue = SsCall.enqueue.overload('com.bytedance.retrofit2.client.Callback');
          } catch (e2) {
            try {
              origEnqueue = SsCall.enqueue.overload('okhttp3.Callback');
            } catch (e3) {
              origEnqueue = SsCall.enqueue;
            }
          }
        }

        SsCall.enqueue.implementation = function (callback) {
          try {
            const request = this['a'] || this['request'];
            if (request) {
              const url = safeJavaStr(request, 'url');
              if (url && isPackApi(url)) {
                console.log('\n[BaseSsCall] enqueue → ' + url);
                sendEvent('sscall-enqueue', { url: url, urlLength: url.length });
              }
            }
          } catch (e) { /* best-effort */ }
          return origEnqueue.call(this, callback);
        };
        ssCallHooked = true;
        sendEvent('hook-ready', { target: target + '.enqueue()' });
        console.log('[JAVA] ' + target + '.enqueue() hooked');
      } catch (e) {
        // Try next target
      }
    }
    if (!ssCallHooked) {
      sendEvent('hook-failed', { target: 'SsCall.enqueue (all targets)', error: 'Abstract class — using Retrofit2+OkHttp hooks instead' });
      console.log('[JAVA] SsCall.enqueue not available — relying on Retrofit2+OkHttp hooks');
    }

    // ── 1d. URL query parameter signing observer (name only) ──
    try {
      const UriBuilder = Java.use('android.net.Uri$Builder');
      const origAppendQueryParameter = UriBuilder.appendQueryParameter;
      UriBuilder.appendQueryParameter.implementation = function (name, value) {
        if (name && /a_bogus|verifyFp|sign|bogus|gorgan|argus|khronos|ladon|ss-stub/i.test(String(name))) {
          const valStr = String(value || '');
          console.log('\n[URI SIGN] ' + name + ' (len=' + valStr.length + ')');
          captured.signCalls.push({
            source: 'Uri.Builder.appendQueryParameter',
            name: String(name),
            valueLength: valStr.length,
            ts: Date.now(),
          });
          sendEvent('sign-param', {
            source: 'Uri.Builder',
            name: String(name),
            valueLength: valStr.length,
          });
        }
        return origAppendQueryParameter.call(this, name, value);
      };
      sendEvent('hook-ready', { target: 'Uri.Builder.appendQueryParameter' });
      console.log('[JAVA] Uri.Builder.appendQueryParameter hooked');
    } catch (e) {
      // Non-critical
    }

    // ── 1e. OPT-IN: BdTuringVerifyActivity bypass ──
    if (OPTS.BYPASS_TURING) {
      console.log('[JAVA] ⚠️ BdTuring bypass ENABLED (opt-in)');
      const turingPatterns = [
        'com.bytedance.android.turingverify.BdTuringVerifyActivity',
        'com.bytedance.turingverify.BdTuringVerifyActivity',
        'com.ss.android.ugc.aweme.turing.TuringVerifyActivity',
      ];
      let bypassInstalled = false;
      for (const cls of turingPatterns) {
        try {
          const Activity = Java.use(cls);
          const origOnCreate = Activity.onCreate;
          Activity.onCreate.implementation = function (bundle) {
            console.log('[BYPASS] ' + cls + ' — finish immediately');
            this.finish();
          };
          sendEvent('hook-ready', { target: cls + ' bypass (opt-in)' });
          console.log('[JAVA] ' + cls + ' bypass installed');
          bypassInstalled = true;
          break;
        } catch (e) { /* try next */ }
      }
      if (!bypassInstalled) {
        sendEvent('hook-failed', { target: 'BdTuring bypass (all patterns)', error: 'No matching class found' });
      }
    } else {
      console.log('[JAVA] BdTuring bypass DISABLED (default). Set BYPASS_TURING=1 to enable.');
    }
  });
}

// ─── 2. Native Hooks (libmetasec_ml.so) ─────────────────────────────────────
function installNativeHooks() {
  // Each section is independent — one failure won't block others

  // ── 2a. Hook dlopen/android_dlopen_ext ──
  try {
    const dlopenNames = ['android_dlopen_ext', 'dlopen'];
    for (const name of dlopenNames) {
      try {
        const addr = Module.findExportByName(null, name);
        if (!addr) continue;
        Interceptor.attach(addr, {
          onEnter(args) {
            try {
              const path = args[0].readCString();
              if (path && (path.includes('metasec') || path.includes('Encryptor') || path.includes('sgmain'))) {
                console.log('[DLOPEN] ' + path);
                sendEvent('library-loading', { library: path });
                setTimeout(tryHookMetaSec, 300);
              }
            } catch (e) { /* ignore */ }
          },
        });
      } catch (e) { /* ignore */ }
    }
    console.log('[NATIVE] dlopen hooks installed');
  } catch (e) {
    console.log('[NATIVE] dlopen hooks failed: ' + String(e).slice(0, 100));
  }

  // ── 2b. Hook RegisterNatives ──
  try {
    hookRegisterNatives();
  } catch (e) {
    console.log('[NATIVE] RegisterNatives hook failed: ' + String(e).slice(0, 100));
    sendEvent('hook-failed', { target: 'RegisterNatives', error: String(e) });
  }

  // ── 2c. Scan for already-loaded metasec_ml ──
  try {
    tryHookMetaSec();
  } catch (e) {
    console.log('[NATIVE] MetaSec scan failed: ' + String(e).slice(0, 100));
  }

  // ── 2d. Periodic retry ──
  let retryCount = 0;
  const retryInterval = setInterval(() => {
    retryCount++;
    if (retryCount > 40) { clearInterval(retryInterval); return; }
    try { tryHookMetaSec(); } catch (e) { /* ignore */ }
    try { hookRegisterNatives(); } catch (e) { /* ignore */ }
  }, 3000);

  console.log('[NATIVE] Native hook installer complete');
}

// ─── 2-support. Shared native hook helpers ────────────────────────────────
const hookedNative = new Set();
let registerNativesHooked = false;

function hookSignFunction(addr, name, moduleName) {
  const key = addr.toString();
  if (hookedNative.has(key)) return;
  hookedNative.add(key);

  try {
    Interceptor.attach(addr, {
      onEnter(args) {
        this.fnName = name;
        this.module = moduleName;
        this.startTime = Date.now();
        const argSummary = [];
        for (let i = 0; i < Math.min(4, 6); i++) {
          try {
            if (args[i] && !args[i].isNull()) {
              try {
                const str = args[i].readCString();
                if (str && str.length > 0 && str.length < 10000) {
                  argSummary.push({ index: i, stringLen: str.length });
                } else {
                  argSummary.push({ index: i, ptr: args[i].toString() });
                }
              } catch (e2) {
                argSummary.push({ index: i, ptr: args[i].toString() });
              }
            }
          } catch (e) { /* skip arg */ }
        }
        sendEvent('sign-call', { fnName: name, module: moduleName, args: argSummary });
      },
      onLeave(retval) {
        const elapsed = Date.now() - this.startTime;
        try {
          if (retval && !retval.isNull()) {
            try {
              const result = retval.readCString();
              if (result && result.length > 0) {
                captured.signCalls.push({
                  source: 'native', fnName: this.fnName, module: this.module,
                  resultLength: result.length, elapsedMs: elapsed, ts: Date.now(),
                });
                sendEvent('sign-result', { fnName: this.fnName, resultLength: result.length, elapsedMs: elapsed });
              }
            } catch (e2) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }
      },
    });
  } catch (e) { /* skip */ }
}

function tryHookMetaSec() {
  try {
    const mod = Process.getModuleByName(METASEC_LIB);
    if (!mod) return;

    // Hook JNI_OnLoad
    const jniOnLoad = Module.findExportByName(METASEC_LIB, 'JNI_OnLoad');
    if (jniOnLoad && !hookedNative.has('jol_' + METASEC_LIB)) {
      hookedNative.add('jol_' + METASEC_LIB);
      Interceptor.attach(jniOnLoad, {
        onEnter(args) {
          sendEvent('jni-onload', { library: METASEC_LIB });
        },
        onLeave(retval) {
          sendEvent('jni-onload-return', { library: METASEC_LIB, jniVersion: retval.toInt32() });
        },
      });
    }

    sendEvent('module-found', {
      name: METASEC_LIB, base: mod.base.toString(), size: mod.size,
      exportsCount: mod.enumerateExports().length,
    });

    // Search exports for sign/encrypt/bogus-related functions and hook them
    const exports = mod.enumerateExports();
    let signHooks = 0;
    for (let i = 0; i < exports.length; i++) {
      const exp = exports[i];
      if (exp.type !== 'function') continue;
      const name = exp.name || '';
      // Target: functions with sign/encrypt/bogus/sec in their name
      if (/sign|encrypt|bogus|hash|hmac/i.test(name)) {
        if (hookedNative.has(exp.address.toString())) continue;
        hookedNative.add(exp.address.toString());
        try {
          Interceptor.attach(exp.address, {
            onEnter(args) {
              const argSizes = [];
              for (let j = 0; j < Math.min(4, 6); j++) {
                try {
                  if (args[j] && !args[j].isNull()) {
                    try {
                      const s = args[j].readCString();
                      if (s && s.length > 0 && s.length < 10000) {
                        argSizes.push({ idx: j, len: s.length });
                      } else {
                        argSizes.push({ idx: j, ptr: args[j].toString() });
                      }
                    } catch (e) { argSizes.push({ idx: j, ptr: args[j].toString() }); }
                  }
                } catch (e) { /* skip */ }
              }
              if (argSizes.length > 0) {
                console.log('[METASEC:' + name + '] args=' + JSON.stringify(argSizes));
                sendEvent('sign-call', { fnName: name, module: METASEC_LIB, args: argSizes });
              }
            },
            onLeave(retval) {
              try {
                if (retval && !retval.isNull()) {
                  const r = retval.readCString();
                  if (r && r.length > 0) {
                    console.log('[METASEC:' + name + '] => len=' + r.length);
                    captured.signCalls.push({
                      source: 'native-direct', fnName: name, module: METASEC_LIB,
                      resultLength: r.length, ts: Date.now(),
                    });
                    sendEvent('sign-result', { fnName: name, resultLength: r.length, source: 'direct-export' });
                  }
                }
              } catch (e) { /* ignore */ }
            },
          });
          signHooks++;
        } catch (e) { /* skip */ }
      }
    }
    if (signHooks > 0) {
      console.log('[NATIVE] Direct-hooked ' + signHooks + ' sign functions in ' + METASEC_LIB);
      sendEvent('hook-ready', { target: METASEC_LIB + ' direct (' + signHooks + ' sign functions)' });
    }

    // OPT-IN: Full export tracing
    if (OPTS.TRACE_ALL_EXPORTS) {
      const exports = mod.enumerateExports();
      let count = 0;
      for (const exp of exports) {
        if (exp.type !== 'function') continue;
        if (exp.name === '__cxa_finalize' || exp.name === '__cxa_atexit') continue;
        try { Interceptor.attach(exp.address, { onEnter() {} }); count++; } catch (e) { /* skip */ }
      }
      sendEvent('hook-ready', { target: METASEC_LIB + ' full trace (' + count + ' exports)' });
    }
  } catch (e) { /* not loaded */ }
}

function hookRegisterNatives() {
  if (registerNativesHooked) return;

  let addr = null;
  // Module.findExportByName(null, ...) throws "not a function" in
  // frida-compile bundles.  Go straight to libart symbol enumeration,
  // which works with an indexed loop.
  try {
    const libart = Process.getModuleByName('libart.so');
    if (libart && typeof libart.enumerateSymbols === 'function') {
      const symbols = libart.enumerateSymbols();
      if (symbols && typeof symbols.length === 'number') {
        for (let si = 0; si < symbols.length && si < 50000; si++) {
          try {
            const sym = symbols[si];
            if (sym && sym.name && typeof sym.name === 'string' &&
                sym.name.indexOf('RegisterNatives') !== -1 &&
                sym.name.indexOf('CheckJNI') === -1) {
              addr = sym.address;
              break;
            }
          } catch (e) { /* skip symbol */ }
        }
      }
    }
  } catch (e) { /* ignore */ }

  if (!addr) return; // Not available yet, will retry

  registerNativesHooked = true;
  sendEvent('hook-ready', { target: 'RegisterNatives', address: addr.toString() });

  try {
    Interceptor.attach(addr, {
      onEnter(args) {
        const count = args[3].toInt32();
        const methods = args[2];
        const ps = Process.pointerSize;
        for (let i = 0; i < count && i < 100; i++) {
          try {
            const entry = methods.add(i * ps * 3);
            const namePtr = entry.readPointer();
            const sigPtr = entry.add(ps).readPointer();
            const fnPtr = entry.add(ps * 2).readPointer();
            if (namePtr.isNull()) continue;
            const name = namePtr.readCString();
            const sig = sigPtr.isNull() ? '(null)' : sigPtr.readCString();
            const owner = Process.findModuleByAddress(fnPtr);
            const ownerName = owner ? owner.name : '(unknown)';
            if (ownerName.includes('metasec') || ownerName.includes('Encryptor') || ownerName.includes('sgmain')) {
              sendEvent('jni-registered', { name: name, signature: sig, module: ownerName, address: fnPtr.toString() });
              hookSignFunction(fnPtr, name, ownerName);
            }
          } catch (e) { /* skip */ }
        }
      },
    });
  } catch (e) {
    sendEvent('hook-failed', { target: 'RegisterNatives.attach', error: String(e) });
    registerNativesHooked = false;
  }
}

// ─── 3. Main ───────────────────────────────────────────────────────────────
sendEvent('agent-loaded', {
  pid: Process.id,
  arch: Process.arch,
  appId: APP_ID,
  targetApi: TARGET_API,
  opts: OPTS,
});

console.log('[NATIVE-CHAIN] Starting hooks...');
console.log('[NATIVE-CHAIN] Target: ' + TARGET_API);
console.log('[NATIVE-CHAIN] PID: ' + Process.id + ' Arch: ' + Process.arch);
console.log('[NATIVE-CHAIN] Opts: BYPASS_TURING=' + OPTS.BYPASS_TURING +
  ' TRACE_ALL_EXPORTS=' + OPTS.TRACE_ALL_EXPORTS +
  ' TRACE_CRONET=' + OPTS.TRACE_CRONET);

// Phase 1: Java hooks (wait for VM — delay depends on spawn vs attach)
// In spawn mode the VM needs ~3s; in attach mode it's already running.
function bootJavaAndNative() {
  if (!Java.available) {
    setTimeout(bootJavaAndNative, 500);
    return;
  }
  console.log('[NATIVE-CHAIN] Java VM available, installing hooks...');
  installJavaHooks();

  // Phase 2: Native hooks — ONLY after Java VM confirmed ready.
  // Hooking dlopen/RegisterNatives during early process init can
  // crash houdini (ARM→x86 translator). Deferring avoids this.
  try {
    installNativeHooks();
  } catch (e) {
    console.log('[NATIVE-CHAIN] Native hooks failed: ' + String(e).slice(0, 120));
    sendEvent('hook-failed', { target: 'native-hooks', error: String(e) });
  }
}
setTimeout(bootJavaAndNative, 3000);

// Phase 3: Status updates
let tickCount = 0;
setInterval(() => {
  tickCount++;
  if (tickCount % 20 === 0) { // Every ~100 seconds
    sendEvent('status', {
      uptimeSeconds: tickCount * 5,
      requestsCaptured: captured.requests.length,
      signCallsCaptured: captured.signCalls.length,
      nativeEvents: captured.nativeEvents.length,
    });
  }
}, 5000);

console.log('[NATIVE-CHAIN] Waiting for Java VM... Open a product detail page in Douyin Mall.\n');
