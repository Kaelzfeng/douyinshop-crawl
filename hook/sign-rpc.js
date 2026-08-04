/**
 * Enhanced Frida RPC sign + shorten agent.
 *
 * Combines NetworkParams signing (via native-signer-agent's approach)
 * with shorten API template capture (via capture-share-api's hooks).
 *
 * rpc.exports:
 *   sign(url, headers)     — native MetaSec signing → header map
 *   status()               — signer health / available hooks
 *   startCapture()         — begin capturing clipboard + network events
 *   stopCapture()          — stop capturing
 *   getCapturedEvents()    — return captured events (shorten templates, clipboard, etc.)
 *   clearCapturedEvents()  — reset capture buffer
 *
 * Prereq: app with NetworkParams provider loaded (opens after first network request).
 */
import Java from 'frida-java-bridge';

const NETWORK_PARAMS = 'com.bytedance.frameworks.baselib.network.http.NetworkParams';
const PACKAGE_NAME = 'com.ss.android.ugc.livelite';

let capturedEvents = [];
let captureActive = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendEv(p) {
  try { send(Object.assign({ ts: Date.now() }, p)); } catch (_) {}
}

function safeString(v) {
  try { return v === null || v === undefined ? '' : String(v); } catch (_) { return ''; }
}

function withJava(fn) {
  return new Promise((resolve, reject) => {
    Java.perform(() => {
      try { resolve(fn()); } catch (e) {
        reject(new Error(String(e?.stack || e)));
      }
    });
  });
}

function mapToObject(map) {
  if (!map) return null;
  const MapClass = Java.use('java.util.Map');
  const EntryClass = Java.use('java.util.Map$Entry');
  const out = {};
  const iter = Java.cast(map, MapClass).entrySet().iterator();
  while (iter.hasNext()) {
    const entry = Java.cast(iter.next(), EntryClass);
    out[String(entry.getKey())] = String(entry.getValue());
  }
  return out;
}

function buildHeaderMap(headers) {
  const HashMap = Java.use('java.util.HashMap');
  const ArrayList = Java.use('java.util.ArrayList');
  const map = HashMap.$new();
  for (const [name, value] of Object.entries(headers || {})) {
    const values = ArrayList.$new();
    values.add(String(value));
    map.put(String(name), values);
  }
  return map;
}

function getProvider(NetworkParams) {
  const field = NetworkParams.class.getDeclaredField('LJIILLIIL');
  field.setAccessible(true);
  return field.get(null);
}

// ---------------------------------------------------------------------------
// Capture hooks (shorten API template discovery)
// ---------------------------------------------------------------------------

function shouldCapture(s) {
  return /shorten|v\.douyin|haohuo|goods_detail|share|product|promotion|targets/i.test(String(s || ''));
}

function installCaptureHooks() {
  Java.perform(() => {
    // Clipboard
    try {
      const CM = Java.use('android.content.ClipboardManager');
      CM.setPrimaryClip.implementation = function (clip) {
        try {
          const item = clip.getItemAt(0);
          const text = item ? item.getText() : null;
          const s = text ? String(text) : '';
          if (s && captureActive) {
            capturedEvents.push({ type: 'clipboard', text: s.slice(0, 2000), _receivedAt: Date.now() });
          }
        } catch (_) {}
        return this.setPrimaryClip(clip);
      };
    } catch (_) {}

    // Uri.parse
    try {
      const Uri = Java.use('android.net.Uri');
      const parse = Uri.parse.overload('java.lang.String');
      parse.implementation = function (uri) {
        const s = String(uri);
        if (captureActive && shouldCapture(s)) {
          capturedEvents.push({ type: 'uri-parse', uri: s.slice(0, 4000), _receivedAt: Date.now() });
        }
        return parse.call(this, s);
      };
    } catch (_) {}

    // Form fields (targets=haohuo_url)
    try {
      const Form = Java.use('com.bytedance.retrofit2.mime.FormUrlEncodedTypedOutput');
      Form.addField.overload('java.lang.String', 'java.lang.String').implementation = function (name, value) {
        const n = String(name);
        const v = String(value);
        if (captureActive) {
          capturedEvents.push({ type: 'form-field', name: n, value: v.slice(0, 4000), _receivedAt: Date.now() });
        }
        return this.addField(name, value);
      };
    } catch (_) {}

    // OkHttp requests (capture shorten API calls)
    try {
      const OkBuilder = Java.use('okhttp3.Request$Builder');
      const okBuild = OkBuilder.build;
      OkBuilder.build.implementation = function () {
        const req = okBuild.call(this);
        try {
          const url = String(req.url());
          if (captureActive && shouldCapture(url)) {
            // Dump body if available
            let bodyText = '';
            try {
              const body = req.body();
              if (body) {
                const Buffer = Java.use('okio.Buffer');
                const buffer = Buffer.$new();
                body.writeTo(buffer);
                bodyText = String(buffer.readUtf8()).slice(0, 4000);
              }
            } catch (_) {}
            capturedEvents.push({
              type: 'okhttp-request',
              url: url.slice(0, 2000),
              method: String(req.method()),
              body: bodyText,
              _receivedAt: Date.now(),
            });
          }
        } catch (_) {}
        return req;
      };
    } catch (_) {}

    // Retrofit requests
    try {
      const BdBuilder = Java.use('com.bytedance.retrofit2.client.Request$Builder');
      const bdBuild = BdBuilder.build;
      BdBuilder.build.implementation = function () {
        const req = bdBuild.call(this);
        try {
          let url = '';
          try { url = String(req.getUrl()); } catch (_) {
            try { url = String(req.url()); } catch (__) {}
          }
          if (captureActive && shouldCapture(url)) {
            capturedEvents.push({
              type: 'bd-retrofit-request',
              url: url.slice(0, 2000),
              _receivedAt: Date.now(),
            });
          }
        } catch (_) {}
        return req;
      };
    } catch (_) {}
  });
}

// ---------------------------------------------------------------------------
// RPC exports
// ---------------------------------------------------------------------------

rpc.exports = {
  // ---- Signing (delegates to NetworkParams) ----

  async sign(url, headers) {
    return withJava(() => {
      const NetworkParams = Java.use(NETWORK_PARAMS);
      const provider = getProvider(NetworkParams);
      if (!provider) throw new Error('MetaSec provider not installed yet');
      const method = NetworkParams.LJIILLIIL.overload('java.lang.String', 'java.util.Map');
      const result = method.call(NetworkParams, String(url), buildHeaderMap(headers || {}));
      return mapToObject(result);
    });
  },

  async status() {
    return withJava(() => {
      const NetworkParams = Java.use(NETWORK_PARAMS);
      const provider = getProvider(NetworkParams);
      return {
        javaAvailable: Java.available,
        networkParamsLoaded: true,
        providerInstalled: provider !== null,
        providerClass: provider ? String(provider.getClass().getName()) : null,
        captureActive,
        capturedEventCount: capturedEvents.length,
      };
    });
  },

  // ---- Capture control ----

  async startCapture() {
    captureActive = true;
    capturedEvents = [];
    installCaptureHooks();
    sendEv({ type: 'capture-started' });
    return { ok: true, captureActive: true };
  },

  async stopCapture() {
    captureActive = false;
    sendEv({ type: 'capture-stopped', eventCount: capturedEvents.length });
    return { ok: true, captureActive: false, eventCount: capturedEvents.length };
  },

  async getCapturedEvents() {
    return capturedEvents.slice();
  },

  async clearCapturedEvents() {
    capturedEvents = [];
    return { ok: true };
  },

  // ---- Utility ----

  ping() {
    return { pid: Process.id, arch: Process.arch };
  },
};

// Lifecycle
sendEv({ type: 'agent-loaded' });
setTimeout(() => {
  installCaptureHooks();
  sendEv({ type: 'hooks-installed' });
}, 400);
