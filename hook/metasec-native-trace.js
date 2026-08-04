/**
 * MetaSec native entry tracer (pure-reverse helper).
 *
 * Captures:
 *  - dlsym/dlopen of getEncodedP / metasec symbols
 *  - JNI RegisterNatives rows (class + method + fnPtr)
 *  - f3.a Java calls with op/handle/text + output pairs
 *  - Optional: resolve ArtMethod entry for ms.bd.c.f3.a
 *
 * rpc.exports:
 *   ping / status / install / dump / signProbe(url, headers)
 */

import Java from 'frida-java-bridge';

const PACKAGE = 'com.ss.android.ugc.livelite';
const state = {
  installed: false,
  dlsym: [],
  dlopen: [],
  registerNatives: [],
  f3Calls: [],
  artMethod: null,
  errors: [],
};

function cap(v, n = 500) {
  try {
    const s = v === null || v === undefined ? '' : String(v);
    return s.length > n ? s.slice(0, n) + '…' : s;
  } catch (_) {
    return '';
  }
}

function withJava(fn) {
  return new Promise((resolve, reject) => {
    Java.perform(() => {
      try {
        resolve(fn());
      } catch (e) {
        reject(new Error(String(e?.stack || e)));
      }
    });
  });
}

function pushRing(arr, item, max = 200) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function hookDlsym() {
  const names = ['dlsym', '__dlsym'];
  for (const name of names) {
    const addr = Module.findExportByName(null, name);
    if (!addr) continue;
    Interceptor.attach(addr, {
      onEnter(args) {
        try {
          this.sym = args[1].isNull() ? null : args[1].readCString();
          this.handle = args[0];
        } catch (_) {
          this.sym = null;
        }
      },
      onLeave(retval) {
        const sym = this.sym || '';
        if (!sym) return;
        if (!/encode|meta|sec|gorgon|sign|jni|f3|neptune|argus|khronos|ladon/i.test(sym)) return;
        const item = {
          ts: Date.now(),
          api: name,
          symbol: sym,
          address: retval.isNull() ? null : retval.toString(),
        };
        pushRing(state.dlsym, item);
        send({ event: 'dlsym', ...item });
      },
    });
    return name;
  }
  return null;
}

function hookDlopen() {
  for (const name of ['android_dlopen_ext', 'dlopen']) {
    const addr = Module.findExportByName(null, name);
    if (!addr) continue;
    Interceptor.attach(addr, {
      onEnter(args) {
        try {
          this.path = args[0].isNull() ? null : args[0].readCString();
        } catch (_) {
          this.path = null;
        }
      },
      onLeave(retval) {
        const path = this.path || '';
        if (!/metasec|sscronet|libms/i.test(path)) return;
        const item = {
          ts: Date.now(),
          api: name,
          path,
          handle: retval.isNull() ? null : retval.toString(),
        };
        pushRing(state.dlopen, item);
        send({ event: 'dlopen', ...item });
      },
    });
    return name;
  }
  return null;
}

function hookRegisterNatives() {
  // libart RegisterNatives variants
  const art = Process.findModuleByName('libart.so');
  if (!art) return null;
  const candidates = Module.enumerateSymbolsSync('libart.so').filter((s) =>
    /RegisterNatives/i.test(s.name) && s.type === 'function',
  );
  let hooked = 0;
  for (const sym of candidates.slice(0, 8)) {
    try {
      Interceptor.attach(sym.address, {
        onEnter(args) {
          // JNIEnv*, jclass, JNINativeMethod*, jint
          try {
            this.env = args[0];
            this.clazz = args[1];
            this.methods = args[2];
            this.count = args[3].toInt32();
          } catch (_) {
            this.count = 0;
          }
        },
        onLeave(retval) {
          if (!this.methods || !this.count || this.count < 0 || this.count > 256) return;
          try {
            const env = Java.vm.tryGetEnv();
            let className = null;
            try {
              if (env && this.clazz) {
                // best-effort via Java
              }
            } catch (_) {}
            // JNINativeMethod: {char* name, char* sig, void* fnPtr} — 3 pointers
            const ptrSize = Process.pointerSize;
            const rows = [];
            for (let i = 0; i < this.count; i++) {
              const base = this.methods.add(i * ptrSize * 3);
              const namePtr = base.readPointer();
              const sigPtr = base.add(ptrSize).readPointer();
              const fnPtr = base.add(ptrSize * 2).readPointer();
              const name = namePtr.isNull() ? null : namePtr.readCString();
              const sig = sigPtr.isNull() ? null : sigPtr.readCString();
              rows.push({
                name,
                sig,
                fnPtr: fnPtr.isNull() ? null : fnPtr.toString(),
              });
            }
            const item = {
              ts: Date.now(),
              artSymbol: sym.name,
              count: this.count,
              className,
              methods: rows,
            };
            pushRing(state.registerNatives, item, 50);
            send({ event: 'RegisterNatives', ...item });
          } catch (e) {
            pushRing(state.errors, { where: 'RegisterNatives', error: cap(e) });
          }
        },
      });
      hooked += 1;
    } catch (e) {
      pushRing(state.errors, { where: 'hook ' + sym.name, error: cap(e) });
    }
  }
  return hooked;
}

function hookF3Java() {
  return withJava(() => {
    const F3 = Java.use('ms.bd.c.f3');
    const overload = F3.a.overload('int', 'int', 'long', 'java.lang.String', 'java.lang.Object');
    overload.implementation = function (op, arg, handle, text, payload) {
      const started = Date.now();
      const result = overload.call(F3, op, arg, handle, text, payload);
      const inputPairs = [];
      const outputPairs = [];
      try {
        if (payload !== null) {
          const ReflectArray = Java.use('java.lang.reflect.Array');
          try {
            const len = ReflectArray.getLength(payload);
            for (let i = 0; i < len; i++) inputPairs.push(String(ReflectArray.get(payload, i)));
          } catch (_) {
            try {
              const list = Java.cast(payload, Java.use('java.util.List'));
              for (let i = 0; i < list.size(); i++) inputPairs.push(String(list.get(i)));
            } catch (__) {}
          }
        }
      } catch (_) {}
      try {
        if (result !== null) {
          const ReflectArray = Java.use('java.lang.reflect.Array');
          const len = ReflectArray.getLength(result);
          for (let i = 0; i < len; i++) outputPairs.push(String(ReflectArray.get(result, i)));
        }
      } catch (_) {}

      // Try resolve native entry from ArtMethod handle (best-effort, ART version dependent)
      let nativeEntry = null;
      try {
        // Frida exposes method handle as NativePointer on some versions
        const h = overload.handle || overload._p || null;
        if (h) {
          // On many ARTs, entry_point_from_jni_ / data_ is at fixed offsets — probe a few
          const ptrSize = Process.pointerSize;
          for (const off of [ptrSize * 2, ptrSize * 3, ptrSize * 4, 24, 32, 40, 48]) {
            try {
              const p = ptr(h).add(off).readPointer();
              if (p.isNull()) continue;
              const mod = Process.findModuleByAddress(p);
              if (mod && /metasec|ms|sscronet/i.test(mod.name)) {
                nativeEntry = { address: p.toString(), module: mod.name, offset: p.sub(mod.base).toString(16), probeOff: off };
                break;
              }
            } catch (_) {}
          }
          state.artMethod = { handle: String(h), nativeEntry };
        }
      } catch (e) {
        pushRing(state.errors, { where: 'artMethod', error: cap(e) });
      }

      const item = {
        ts: started,
        op,
        arg,
        handle: String(handle),
        text: text === null ? null : String(text),
        input_pairs: inputPairs,
        output_pairs: outputPairs,
        elapsed_ms: Date.now() - started,
        native_entry: nativeEntry,
      };
      // Keep all HTTP-sign related ops
      if (op === 50331649 || op === 0x03000001 || op === 100663297 || op === 50331650) {
        pushRing(state.f3Calls, item, 100);
        send({ event: 'f3.a', ...item });
      }
      return result;
    };
    return true;
  });
}

function installNativeHooks() {
  if (state.installed) return state.summary;
  const dlsym = hookDlsym();
  const dlopen = hookDlopen();
  const rn = hookRegisterNatives();
  state.summary = {
    dlsym,
    dlopen,
    registerNativesHooks: rn,
    modules: Process.enumerateModules().filter((m) =>
      /metasec|sscronet|libart/i.test(m.name),
    ).map((m) => ({ name: m.name, base: m.base.toString(), size: m.size })),
  };
  state.installed = true;
  return state.summary;
}

rpc.exports = {
  ping() {
    return { pid: Process.id, arch: Process.arch };
  },

  async status() {
    return {
      installed: state.installed,
      summary: state.summary || null,
      counts: {
        dlsym: state.dlsym.length,
        dlopen: state.dlopen.length,
        registerNatives: state.registerNatives.length,
        f3Calls: state.f3Calls.length,
        errors: state.errors.length,
      },
      artMethod: state.artMethod,
    };
  },

  async install() {
    const native = installNativeHooks();
    let f3 = false;
    let f3Error = null;
    try {
      f3 = await hookF3Java();
    } catch (e) {
      f3Error = cap(e);
      pushRing(state.errors, { where: 'hookF3Java', error: f3Error });
    }
    return { ok: true, native, f3, f3Error };
  },

  async dump() {
    return {
      ts: Date.now(),
      ...await this.status(),
      dlsym: state.dlsym.slice(-50),
      dlopen: state.dlopen.slice(-20),
      registerNatives: state.registerNatives.slice(-20),
      f3Calls: state.f3Calls.slice(-30),
      errors: state.errors.slice(-30),
    };
  },

  /** Trigger one NetworkParams sign to force f3.a */
  async signProbe(url, headersJson) {
    return withJava(() => {
      const NetworkParams = Java.use('com.bytedance.frameworks.baselib.network.http.NetworkParams');
      const field = NetworkParams.class.getDeclaredField('LJIILLIIL');
      field.setAccessible(true);
      const provider = field.get(null);
      if (provider === null) throw new Error('MetaSec provider not installed');

      const HashMap = Java.use('java.util.HashMap');
      const ArrayList = Java.use('java.util.ArrayList');
      const map = HashMap.$new();
      let headers = {};
      try {
        headers = headersJson ? JSON.parse(String(headersJson)) : {};
      } catch (_) {
        headers = {};
      }
      for (const [k, v] of Object.entries(headers || {})) {
        const list = ArrayList.$new();
        list.add(String(v));
        map.put(String(k), list);
      }
      const method = NetworkParams.LJIILLIIL.overload('java.lang.String', 'java.util.Map');
      const result = method.call(NetworkParams, String(url || 'https://ecom.ecombdapi.com/'), map);
      const out = {};
      if (result) {
        const iter = Java.cast(result, Java.use('java.util.Map')).entrySet().iterator();
        const Entry = Java.use('java.util.Map$Entry');
        while (iter.hasNext()) {
          const e = Java.cast(iter.next(), Entry);
          out[String(e.getKey())] = String(e.getValue());
        }
      }
      return {
        headers: out,
        lastF3: state.f3Calls.length ? state.f3Calls[state.f3Calls.length - 1] : null,
        artMethod: state.artMethod,
      };
    });
  },
};
