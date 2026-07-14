"""
Native Chain Probe — attach to Douyin Mall on MuMu via Frida and capture
the native /aweme/v2/shop/promotion/pack/ API call with its MetaSec signature.

Targets both the native and emulated Frida realms to intercept:
  - Retrofit2 Request.Builder.build() (Java layer)
  - OkHttp Request.Builder.build() (fallback)
  - libmetasec_ml.so native sign function (via RegisterNatives hook)
  - BdTuringVerifyActivity auto-bypass

Uses the pre-compiled native-chain.bundle.js (build with `npm run build:native-chain`).

Usage:
  python hook/native-probe.py                        # attach to running app
  python hook/native-probe.py --spawn                # spawn fresh
  python hook/native-probe.py --output capture.json  # custom output path
  python hook/native-probe.py --dual-realm           # attach both native + emulated realms
"""

import json
import sys
import time
import threading
from pathlib import Path

import frida


APP_ID = "com.ss.android.ugc.livelite"
DEFAULT_SERIAL = "127.0.0.1:16384"
HOOK_DIR = Path(__file__).parent
BUNDLE_PATH = HOOK_DIR / "native-chain.bundle.js"
OUTPUT_DIR = Path(__file__).parent.parent / "output"

# ── Per-realm native probe (no Java bridge, works in emulated realm too) ──
NATIVE_ONLY_SCRIPT = r"""
'use strict';

const METASEC_LIB = 'libmetasec_ml.so';
const TARGET_LIBS = ['libmetasec_ml.so', 'libEncryptor.so', 'libsgmain.so',
                     'libkrypton.so', 'libsheo.so', 'libttcrypto.so'];

send({ event: 'agent-loaded', pid: Process.id, arch: Process.arch });

// ── Hook dlopen for library load detection ──
['android_dlopen_ext', 'dlopen'].forEach(function(name) {
  try {
    const addr = Module.findExportByName(null, name);
    if (!addr) return;
    Interceptor.attach(addr, {
      onEnter(args) {
        try {
          const path = args[0].readCString();
          if (path && TARGET_LIBS.some(function(lib) { return path.indexOf(lib) !== -1; })) {
            send({ event: 'library-loading', library: path, pid: Process.id });
            setTimeout(tryHookModules, 300);
          }
        } catch(e) {}
      }
    });
  } catch(e) {}
});

// ── Hook RegisterNatives ──
function hookRegisterNatives() {
  let addr = Module.findExportByName(null, 'RegisterNatives');
  if (!addr) {
    try {
      const libart = Process.getModuleByName('libart.so');
      if (libart) {
        libart.enumerateSymbols().forEach(function(sym) {
          if (sym.name.indexOf('RegisterNatives') !== -1 && sym.name.indexOf('CheckJNI') === -1) {
            addr = sym.address;
          }
        });
      }
    } catch(e) {}
  }

  if (!addr) {
    setTimeout(hookRegisterNatives, 1000);
    return;
  }

  send({ event: 'hook-ready', target: 'RegisterNatives', address: addr.toString() });

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

          if (TARGET_LIBS.some(function(lib) { return ownerName.indexOf(lib) !== -1; })) {
            send({ event: 'jni-registered', name: name, sig: sig, module: ownerName, address: fnPtr.toString() });
            hookFunction(fnPtr, name, ownerName);
          }
        } catch(e) {}
      }
    }
  });
}

// ── Hook individual sign functions ──
const hookedFns = {};

function hookFunction(addr, name, moduleName) {
  const key = addr.toString();
  if (hookedFns[key]) return;
  hookedFns[key] = true;

  Interceptor.attach(addr, {
    onEnter(args) {
      this.fnName = name;
      this.module = moduleName;
      this.startTime = Date.now();
      const argSummary = [];
      for (let i = 0; i < 6; i++) {
        try {
          if (args[i] && !args[i].isNull()) {
            const str = args[i].readCString();
            if (str && str.length > 0 && str.length < 10000) {
              argSummary.push({ index: i, value: str.slice(0, 500) });
            } else {
              argSummary.push({ index: i, pointer: args[i].toString() });
            }
          }
        } catch(e) {
          argSummary.push({ index: i, raw: String(args[i]) });
        }
      }
      send({ event: 'sign-call', fnName: name, module: moduleName, args: argSummary });
    },
    onLeave(retval) {
      const elapsed = Date.now() - this.startTime;
      try {
        if (retval && !retval.isNull()) {
          const result = retval.readCString();
          if (result && result.length > 0) {
            send({ event: 'sign-result', fnName: this.fnName, result: result.slice(0, 500), elapsedMs: elapsed });
          }
        }
      } catch(e) {
        send({ event: 'sign-result', fnName: this.fnName, retval: retval.toString(), elapsedMs: elapsed });
      }
    }
  });
}

// ── Try to hook already-loaded modules ──
function tryHookModules() {
  TARGET_LIBS.forEach(function(libName) {
    try {
      const mod = Process.getModuleByName(libName);
      if (!mod) return;
      send({ event: 'module-found', name: libName, base: mod.base.toString(), size: mod.size });

      // Hook JNI_OnLoad
      const jniOnLoad = Module.findExportByName(libName, 'JNI_OnLoad');
      if (jniOnLoad) {
        Interceptor.attach(jniOnLoad, {
          onEnter(args) {
            send({ event: 'jni-onload', library: libName, javaVm: args[0].toString() });
          },
          onLeave(retval) {
            send({ event: 'jni-onload-return', library: libName, jniVersion: retval.toInt32() });
          }
        });
      }

      // Enumerate and hook sign-like exports
      mod.enumerateExports().forEach(function(exp) {
        if (exp.type !== 'function') return;
        const name = exp.name.toLowerCase();
        if (name.indexOf('sign') !== -1 || name.indexOf('encrypt') !== -1 ||
            name.indexOf('bogus') !== -1 || name.indexOf('sec') !== -1 ||
            name.indexOf('hash') !== -1 || name.indexOf('hmac') !== -1) {
          try {
            Interceptor.attach(exp.address, {
              onEnter(args) {
                send({ event: 'native-call', library: libName, function: exp.name });
                for (let i = 0; i < 4; i++) {
                  try {
                    if (args[i] && !args[i].isNull()) {
                      const str = args[i].readCString();
                      if (str && str.length > 0 && str.length < 5000) {
                        send({ event: 'native-arg', function: exp.name, index: i, value: str.slice(0, 500) });
                      }
                    }
                  } catch(e) {}
                }
              },
              onLeave(retval) {
                try {
                  if (retval && !retval.isNull()) {
                    const result = retval.readCString();
                    if (result && result.length > 0) {
                      send({ event: 'native-result', function: exp.name, result: result.slice(0, 200) });
                    }
                  }
                } catch(e) {}
              }
            });
          } catch(e) {}
        }
      });
    } catch(e) {}
  });
}

// Initial scan + periodic retry
tryHookModules();
hookRegisterNatives();
setInterval(tryHookModules, 5000);
setInterval(hookRegisterNatives, 5000);
"""


def load_bundle_or_fallback():
    """Load the compiled Java+Native bundle, or fall back to native-only script."""
    if BUNDLE_PATH.exists():
        return BUNDLE_PATH.read_text(encoding="utf-8")
    print("[WARN] native-chain.bundle.js not found. Run: npm run build:native-chain")
    print("[WARN] Falling back to native-only probe (no Java hooks).")
    return NATIVE_ONLY_SCRIPT


def on_message_native(message, data, pid, realm):
    """Handle messages from the native/emulated realm agent."""
    if message["type"] == "send":
        payload = message["payload"]
        event = payload.get("event", "unknown")
        if event in ("sign-call", "sign-result", "jni-registered", "native-call", "native-result"):
            print(f"[{realm}:{pid}] {event}: {json.dumps(payload, ensure_ascii=False, default=str)[:300]}")
        elif event in ("hook-ready", "module-found", "library-loading", "jni-onload"):
            print(f"[{realm}:{pid}] {event}: {json.dumps(payload, ensure_ascii=False, default=str)[:200]}")
        # Quiet for other events
    elif message["type"] == "error":
        print(f"[{realm}:{pid}] ERROR: {message.get('description', message)}")


def on_message_java(message, data, pid):
    """Handle messages from the Java bundle agent."""
    if message["type"] == "send":
        payload = message["payload"]
        event_type = payload.get("type", payload.get("event", "unknown"))

        if event_type == "pack-request":
            print(f"\n📦 [PACK] {payload.get('method', '?')} {payload.get('url', '?')[:200]}")
            if payload.get("headers"):
                for h in payload["headers"]:
                    if any(kw in h.lower() for kw in ("bogus", "sign", "token", "fp", "verify", "auth", "metasec")):
                        print(f"   Header: {h}")
        elif event_type == "sign-param":
            val = payload.get("value", "")
            print(f"🔑 [SIGN] {payload.get('source')}: {payload.get('name')}={val[:80]}...")
        elif event_type == "turing-bypass":
            print(f"🛡️ [TURING BYPASS] {payload.get('activity')}")
        elif event_type == "hook-ready":
            print(f"✅ Hook: {payload.get('target')}")
        elif event_type == "hook-failed":
            print(f"⚠️ Failed: {payload.get('target')} — {payload.get('error', '')[:120]}")
        elif event_type in ("agent-loaded", "status"):
            pass  # Quiet
        else:
            # Print any unrecognized event for debugging
            pass
    elif message["type"] == "error":
        print(f"[Java:{pid}] ERROR: {message.get('description', message)}")


def attach_realm(device, pid, realm, script_source, on_msg):
    """Attach to a specific Frida realm and inject script."""
    try:
        session = device.attach(pid, realm=realm)
        script = session.create_script(script_source)
        script.on("message", lambda msg, data: on_msg(msg, data, pid, realm))
        script.load()
        print(f"  Attached to realm='{realm}' (PID={pid})")
        return session, script
    except (frida.ProcessNotFoundError, frida.NotSupportedError,
            frida.InvalidOperationError, frida.ProtocolError) as e:
        if realm != "emulated":
            print(f"  Failed to attach realm='{realm}': {e}")
        return None, None


def main():
    spawn_mode = "--spawn" in sys.argv
    dual_realm = "--dual-realm" in sys.argv
    output_arg = None
    for i, arg in enumerate(sys.argv):
        if arg == "--output" and i + 1 < len(sys.argv):
            output_arg = sys.argv[i + 1]

    script_source = load_bundle_or_fallback()
    device = frida.get_device(DEFAULT_SERIAL, timeout=10)

    # ── Attach or spawn ──
    if spawn_mode:
        pid = device.spawn(APP_ID)
        print(f"Spawned {APP_ID} suspended (PID={pid})")
    else:
        applications = device.enumerate_applications()
        target = next((a for a in applications if a.identifier == APP_ID and a.pid), None)
        if target is None:
            print(f"{APP_ID} is not running. Start it or use --spawn.")
            sys.exit(1)
        pid = target.pid
        print(f"Attaching to {target.name} (PID={pid})")

    sessions = []
    scripts = []

    # ── Attach native realm (always) ──
    native_sess, native_script = attach_realm(device, pid, "native", script_source, on_message_native)
    if native_sess:
        sessions.append(native_sess)
        scripts.append(native_script)

    # ── Attach emulated realm (ARM64 translation layer) ──
    if dual_realm:
        emu_sess, emu_script = attach_realm(device, pid, "emulated", NATIVE_ONLY_SCRIPT, on_message_native)
        if emu_sess:
            sessions.append(emu_sess)
            scripts.append(emu_script)
        else:
            print("[WARN] Emulated realm not available. ARM64 libs may not be hooked.")

    if not sessions:
        print("ERROR: Could not attach to any realm.")
        sys.exit(1)

    # ── Resume if spawned ──
    if spawn_mode:
        device.resume(pid)
        print(f"Resumed PID {pid}")

    print(f"\n🟢 Probes active ({len(sessions)} realm(s)). Open a product detail in Douyin Mall.")
    print("Press Ctrl+C to stop.\n")

    # ── Event loop ──
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        for script in scripts:
            try:
                script.unload()
            except Exception:
                pass
        for session in sessions:
            try:
                session.detach()
            except Exception:
                pass

        # Save output summary
        if output_arg:
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            output_path = OUTPUT_DIR / output_arg if not Path(output_arg).is_absolute() else Path(output_arg)
            summary = {
                "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "appId": APP_ID,
                "pid": pid,
                "dualRealm": dual_realm,
                "note": "Full capture requires running node hook/run-native-chain.mjs for structured JSON output."
            }
            output_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"Summary saved to {output_path}")

        print("Done.")


if __name__ == "__main__":
    main()
