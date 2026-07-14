/**
 * Targeted MetaSec signing hook based on jadx analysis by Codex.
 *
 * Chain: Retrofit → SsHttpCall → ICronetClient.openConnection
 *        → libsscronet.so (adds a_bogus) → libmetasec_ml.so (ms.bd.c.f3.a)
 *
 * Targets:
 *   1. Java: ICronetClient.openConnection — capture URL before native signing
 *   2. Java: MSB.<clinit> / d3.LIZIZ — detect MetaSec loading
 *   3. Native: JNI_OnLoad of libmetasec_ml.so / libsscronet.so
 *   4. Native: ms.bd.c.f3.a via RegisterNatives
 */
import Java from 'frida-java-bridge';

const TARGET_HOSTS = ['ecombdapi.com', 'snssdk.com', 'jinritemai.com', 'douyin.com'];
const SEC_LIBS = ['libmetasec_ml.so', 'libsscronet.so', 'libEncryptor.so', 'libttcrypto.so'];

function extractVal(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  const s = String(raw);
  if (s.startsWith('Java.Field{')) {
    const m = s.match(/value:\s*(.+?)(?:,\s*\w+:|\})/);
    return m ? m[1] : null;
  }
  return s;
}

function isApiUrl(u) {
  return u && TARGET_HOSTS.some(h => u.includes(h)) && /\/aweme\/|\/ecom\/|\/shop\/|\/promotion/.test(u);
}

// ─── 1. Java hooks ───
function javaHooks() {
  if (!Java.available) { setTimeout(javaHooks, 500); return; }

  Java.perform(() => {
    // ── 1a. ICronetClient.openConnection (pre-signing boundary) ──
    const cronetTargets = [
      'com.bytedance.cronet.ICronetClient',
      'com.bytedance.retrofit2.client.ICronetClient',
      'X.0ujw',  // The obfuscated class that calls newSsCall
    ];
    for (const cls of cronetTargets) {
      try {
        const C = Java.use(cls);
        const methods = C.class.getDeclaredMethods();
        send({ type: 'cronet-methods', class: cls, count: methods.length });
        // Try to hook openConnection if it exists
        try {
          const orig = C.openConnection;
          if (orig) {
            C.openConnection.implementation = function () {
              const result = orig.apply(this, arguments);
              try {
                // Log the request being sent through Cronet
                send({ type: 'cronet-open', args: Array.from(arguments).map(a => extractVal(a)) });
              } catch(e) {}
              return result;
            };
            send({ type: 'hooked', target: cls + '.openConnection' });
          }
        } catch(e) {}
        break; // Stop after first match
      } catch(e) { /* try next */ }
    }

    // ── 1b. MSB.<clinit> / MetaSec loader ──
    try {
      const MSB = Java.use('X.C0Tpp'); // MetaSec bootstrap per Codex
      send({ type: 'found', class: 'X.C0Tpp (MetaSec bootstrap)' });
    } catch(e) {}

    // ── 1c. SsRetrofitClient / X.0ujw — where Retrofit meets Cronet ──
    try {
      const SsClient = Java.use('com.bytedance.retrofit2.client.SsRetrofitClient');
      send({ type: 'found', class: 'SsRetrofitClient' });
    } catch(e) {}

    // ── 1d. BaseSsCall / X.0ulG — URL before Cronet ──
    try {
      const ulG = Java.use('X.0ulG');
      send({ type: 'found', class: 'X.0ulG (BaseSsCall impl)' });
      // Try hooking any method that looks like it builds the final request
      const declMethods = ulG.class.getDeclaredMethods();
      const interestingMethods = [];
      for (let i = 0; i < Math.min(declMethods.length, 20); i++) {
        interestingMethods.push(String(declMethods[i].getName()));
      }
      send({ type: '0ulG-methods', methods: interestingMethods });
    } catch(e) {}

    // ── 1e. Retrofit2 Request.Builder (keep as fallback) ──
    try {
      const B = Java.use('com.bytedance.retrofit2.client.Request$Builder');
      const orig = B.build;
      B.build.implementation = function () {
        const r = orig.call(this);
        try {
          const url = extractVal(r.url);
          if (url && isApiUrl(url)) {
            const hdrs = [];
            try {
              const h = r.headers;
              if (h && h.size) for (let i = 0; i < h.size(); i++) {
                hdrs.push(String(h.get(i).name));
              }
            } catch(e) {}
            send({
              type: 'request-built',
              url: url,
              method: extractVal(r.method),
              headerNames: hdrs.filter(n => /bogus|sign|token|fp|verify|metasec|ttnet|gorgan|argus|khronos|ladon|ss-stub|cronet/i.test(n)),
              allHeaders: hdrs.slice(0, 30),
            });
          }
        } catch(e) {}
        return r;
      };
      send({ type: 'hooked', target: 'Retrofit2 Request.Builder' });
    } catch(e) {}
  });
}

// ─── 2. Native hooks ───
function nativeHooks() {
  // ── dlopen trace ──
  ['android_dlopen_ext', 'dlopen'].forEach(name => {
    try {
      const addr = Module.findExportByName(null, name);
      if (!addr) return;
      Interceptor.attach(addr, {
        onEnter(args) {
          try {
            const path = args[0].readCString();
            if (path && SEC_LIBS.some(l => path.includes(l))) {
              send({ type: 'lib-loading', lib: path });
              setTimeout(scanSecurityLibs, 200);
            }
          } catch(e) {}
        }
      });
    } catch(e) {}
  });

  // ── Scan for already-loaded security libs ──
  function scanSecurityLibs() {
    for (const libName of SEC_LIBS) {
      try {
        const mod = Process.getModuleByName(libName);
        if (!mod) continue;
        send({
          type: 'sec-lib-found',
          name: libName,
          base: mod.base.toString(),
          size: mod.size,
          exports: mod.enumerateExports().length,
        });

        // Hook JNI_OnLoad
        const jol = Module.findExportByName(libName, 'JNI_OnLoad');
        if (jol) {
          try {
            Interceptor.attach(jol, {
              onEnter(args) {
                send({ type: 'jni-onload', lib: libName });
              },
              onLeave(rv) {
                send({ type: 'jni-onload-done', lib: libName, version: rv.toInt32() });
                // RegisterNatives will fire after this — hook it
                setTimeout(hookRegisterNatives, 50);
              }
            });
          } catch(e) {}
        }

        // Try to hook sign-like exports directly
        const exps = mod.enumerateExports();
        for (let i = 0; i < exps.length; i++) {
          const exp = exps[i];
          if (exp.type !== 'function') continue;
          if (/sign|encrypt|bogus|hash|hmac/i.test(exp.name || '')) {
            try {
              const key = exp.address.toString();
              Interceptor.attach(exp.address, {
                onEnter(args) {
                  const sizes = [];
                  for (let j = 0; j < 4; j++) {
                    try {
                      if (args[j] && !args[j].isNull()) {
                        const s = args[j].readCString();
                        if (s) sizes.push({i:j, len: s.length});
                      }
                    } catch(e) {}
                  }
                  if (sizes.length > 0) send({ type: 'sign-call', lib: libName, fn: exp.name, args: sizes });
                },
                onLeave(rv) {
                  try {
                    if (rv && !rv.isNull()) {
                      const s = rv.readCString();
                      if (s) send({ type: 'sign-result', lib: libName, fn: exp.name, len: s.length });
                    }
                  } catch(e) {}
                }
              });
            } catch(e) {}
          }
        }
      } catch(e) {}
    }
  }

  // ── Hook RegisterNatives for ms.bd.c.f3.a ──
  let rnHooked = false;
  function hookRegisterNatives() {
    if (rnHooked) return;
    try {
      const libart = Process.getModuleByName('libart.so');
      if (!libart) return;
      const symbols = libart.enumerateSymbols();
      if (!symbols || !symbols.length) return;

      let addr = null;
      for (let i = 0; i < symbols.length && i < 50000; i++) {
        try {
          const s = symbols[i];
          if (s && s.name && typeof s.name === 'string' &&
              s.name.indexOf('RegisterNatives') !== -1 &&
              s.name.indexOf('CheckJNI') === -1) {
            addr = s.address;
            break;
          }
        } catch(e) {}
      }
      if (!addr) return;

      rnHooked = true;
      send({ type: 'rn-hooked', addr: addr.toString() });

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
              const sig = sigPtr.isNull() ? '' : sigPtr.readCString();
              const owner = Process.findModuleByAddress(fnPtr);
              const ownerName = owner ? owner.name : '?';

              if (SEC_LIBS.some(l => ownerName.includes(l)) ||
                  name.includes('ms.bd.c') || sig.includes('IIJ')) {
                send({ type: 'jni-reg', name, sig, module: ownerName, addr: fnPtr.toString() });

                // Hook this function
                const fAddr = fnPtr;
                Interceptor.attach(fAddr, {
                  onEnter(args2) {
                    const dump = { fn: name, sig };
                    for (let j = 0; j < 5; j++) {
                      try {
                        if (args2[j] && !args2[j].isNull()) {
                          try {
                            const cs = args2[j].readCString();
                            dump['a'+j] = cs ? cs.slice(0, 500) : args2[j].toString();
                          } catch(e) { dump['a'+j] = args2[j].toString(); }
                        }
                      } catch(e) {}
                    }
                    send({ type: 'metasec-call', ...dump });
                  },
                  onLeave(rv) {
                    try {
                      if (rv && !rv.isNull()) {
                        const r = rv.readCString();
                        send({ type: 'metasec-result', fn: name, resultLen: r ? r.length : 0 });
                      }
                    } catch(e) {}
                  }
                });
              }
            } catch(e) {}
          }
        }
      });
    } catch(e) { send({ type: 'rn-error', err: String(e) }); }
  }

  // Initial scan
  scanSecurityLibs();
  hookRegisterNatives();

  // Retry
  let retries = 0;
  setInterval(() => {
    if (++retries > 60) return;
    scanSecurityLibs();
    hookRegisterNatives();
  }, 3000);
}

// ─── Main ───
send({ type: 'start', pid: Process.id, arch: Process.arch });
setTimeout(javaHooks, 2000);
nativeHooks();
