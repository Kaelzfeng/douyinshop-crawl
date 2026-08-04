/**
 * Direct Search Frida RPC Agent
 *
 * Provides app-internal HTTP request proxying for the Douyin Mall search API.
 * Node.js constructs the search URL/body → this agent signs and executes the
 * HTTP request from inside the app process → returns the raw response to Node.
 *
 * rpc.exports:
 *   search(url, postBody, extraHeaders) → {status, headers, body, url}
 *   signOnly(url, headers)              → {url, headers}
 *   status()                            → signer health
 *   ping()                              → liveness check
 *
 * The request uses java.net.HttpURLConnection (NOT app's Retrofit/OkHttp)
 * to avoid consuming the app's connection pool. Security headers are obtained
 * from NetworkParams.LJIILLIIL() before the request is sent.
 */

import Java from 'frida-java-bridge';

const NETWORK_PARAMS = 'com.bytedance.frameworks.baselib.network.http.NetworkParams';
const PACKAGE_NAME = 'com.ss.android.ugc.livelite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    try {
      out[String(entry.getKey())] = String(entry.getValue());
    } catch (_) {}
  }
  return out;
}

function mapToListOfStrings(map) {
  // HttpURLConnection.getRequestProperties() returns Map<String,List<String>>
  if (!map) return {};
  const out = {};
  try {
    const MapClass = Java.use('java.util.Map');
    const typedMap = Java.cast(map, MapClass);
    const iterator = typedMap.entrySet().iterator();
    const EntryClass = Java.use('java.util.Map$Entry');
    while (iterator.hasNext()) {
      const entry = Java.cast(iterator.next(), EntryClass);
      const key = String(entry.getKey() || '');
      const val = entry.getValue();
      if (val === null) { out[key] = ''; continue; }
      try {
        // List<String>
        const iter2 = Java.cast(val, Java.use('java.util.List')).iterator();
        const parts = [];
        while (iter2.hasNext()) parts.push(String(iter2.next()));
        out[key] = parts.join(', ');
      } catch (_) {
        try { out[key] = String(val); } catch (__) { out[key] = ''; }
      }
    }
  } catch (_) {}
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
  try {
    const field = NetworkParams.class.getDeclaredField('LJIILLIIL');
    field.setAccessible(true);
    return field.get(null);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP request from within the app
// ---------------------------------------------------------------------------

/** Last successful sign/wire snapshot for Node-side classification dumps. */
let lastWireSnapshot = null;

function collectCookiesForUrl(url) {
  const cookies = {};
  const cookieHeaderParts = [];

  try {
    const CookieManager = Java.use('android.webkit.CookieManager');
    const cm = CookieManager.getInstance();
    const raw = safeString(cm.getCookie(String(url || 'https://ecom.ecombdapi.com/')));
    if (raw) {
      cookieHeaderParts.push(raw);
      for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx > 0) {
          const k = part.slice(0, idx).trim();
          const v = part.slice(idx + 1).trim();
          if (k) cookies[k] = v;
        }
      }
    }
  } catch (_) {}

  try {
    const handler = Java.use('java.net.CookieHandler').getDefault();
    if (handler) {
      const URI = Java.use('java.net.URI');
      const uri = URI.create(String(url || 'https://ecom.ecombdapi.com/'));
      const HashMap = Java.use('java.util.HashMap');
      const empty = HashMap.$new();
      const map = handler.get(uri, empty);
      const obj = mapToListOfStrings(map);
      for (const [k, v] of Object.entries(obj || {})) {
        if (String(k).toLowerCase() === 'cookie' && v) {
          cookieHeaderParts.push(String(v));
        }
      }
    }
  } catch (_) {}

  return {
    cookie_header: cookieHeaderParts.filter(Boolean).join('; '),
    cookies,
  };
}

function signUrlHeaders(url, headers) {
  const NetworkParams = Java.use(NETWORK_PARAMS);
  const provider = getProvider(NetworkParams);
  if (!provider) throw new Error('MetaSec provider not installed yet');
  const method = NetworkParams.LJIILLIIL.overload('java.lang.String', 'java.util.Map');
  const result = method.call(NetworkParams, String(url || ''), buildHeaderMap(headers || {}));
  return mapToObject(result) || {};
}

function httpRequest(url, method, postBody, headers) {
  return withJava(() => {
    const URL = Java.use('java.net.URL');
    const urlObj = URL.$new(String(url));
    const conn = Java.cast(urlObj.openConnection(), Java.use('java.net.HttpURLConnection'));

    conn.setRequestMethod(String(method || 'POST'));
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(30000);
    conn.setInstanceFollowRedirects(false);
    conn.setDoInput(true);

    const baseHeaders = { ...(headers || {}) };
    for (const [name, value] of Object.entries(baseHeaders)) {
      if (name && value) conn.setRequestProperty(String(name), String(value));
    }

    let signedHeaders = {};
    let signError = '';
    try {
      const currentHeaders = conn.getRequestProperties();
      const headerMap = mapToListOfStrings(currentHeaders);
      signedHeaders = signUrlHeaders(url, headerMap);
      for (const [k, v] of Object.entries(signedHeaders)) {
        try { conn.setRequestProperty(k, String(v)); } catch (_) {}
      }
    } catch (e) {
      signError = safeString(e);
    }

    const requestHeadersBeforeSend = mapToListOfStrings(conn.getRequestProperties());
    const cookieInfo = collectCookiesForUrl(url);

    if (postBody && (method === 'POST' || method === 'PUT')) {
      conn.setDoOutput(true);
      // UTF-8 body bytes (not charCodeAt which breaks non-ASCII)
      const JString = Java.use('java.lang.String');
      const bodyBytes = JString.$new(String(postBody)).getBytes('UTF-8');
      conn.setRequestProperty('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
      const os = conn.getOutputStream();
      os.write(bodyBytes);
      os.close();
    }

    const status = conn.getResponseCode();
    const responseHeaders = mapToListOfStrings(conn.getHeaderFields());
    let body = '';

    try {
      const is = conn.getInputStream();
      const BAOS = Java.use('java.io.ByteArrayOutputStream');
      const buffer = Java.array('byte', new Array(8192).fill(0));
      const baos = BAOS.$new();
      let n;
      while ((n = is.read(buffer)) > 0) {
        baos.write(buffer, 0, n);
      }
      is.close();
      body = String(baos.toString('UTF-8'));
      baos.close();
    } catch (e) {
      try {
        const es = conn.getErrorStream();
        if (es) {
          const BAOS = Java.use('java.io.ByteArrayOutputStream');
          const buffer = Java.array('byte', new Array(8192).fill(0));
          const baos = BAOS.$new();
          let n;
          while ((n = es.read(buffer)) > 0) {
            baos.write(buffer, 0, n);
          }
          es.close();
          body = String(baos.toString('UTF-8'));
          baos.close();
        }
      } catch (_) {}
    } finally {
      try { conn.disconnect(); } catch (_) {}
    }

    lastWireSnapshot = {
      captured_at: Date.now(),
      url: String(url),
      method: String(method || 'POST'),
      body: String(postBody || ''),
      base_headers: baseHeaders,
      signed_headers: signedHeaders,
      request_headers: requestHeadersBeforeSend,
      cookie_header: cookieInfo.cookie_header,
      cookies: cookieInfo.cookies,
      response_status: status,
      response_headers: responseHeaders,
      sign_error: signError || undefined,
    };

    return {
      status,
      headers: responseHeaders,
      body,
      url: String(url),
      signed_headers: signedHeaders,
      request_headers: requestHeadersBeforeSend,
      cookie_header: cookieInfo.cookie_header,
      wire: lastWireSnapshot,
    };
  });
}

// ---------------------------------------------------------------------------
// RPC exports
// ---------------------------------------------------------------------------

rpc.exports = {
  ping() {
    return { pid: Process.id, arch: Process.arch };
  },

  async status() {
    return withJava(() => {
      try {
        const NetworkParams = Java.use(NETWORK_PARAMS);
        const provider = getProvider(NetworkParams);
        return {
          ok: true,
          javaAvailable: Java.available,
          networkParamsLoaded: true,
          providerInstalled: provider !== null,
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });
  },

  /**
   * Make a signed HTTP request from within the app process.
   *
   * @param {string} url - Full URL including query params
   * @param {string} postBody - URL-encoded POST body (or empty string for GET)
   * @param {object} extraHeaders - Additional headers to include
   * @returns {{status: number, headers: object, body: string, url: string}}
   */
  async search(url, postBody, extraHeaders) {
    return httpRequest(
      String(url || ''),
      postBody ? 'POST' : 'GET',
      String(postBody || ''),
      extraHeaders || {},
    );
  },

  /**
   * Read MetaSec native handle from installed provider (ms.bd.c.y4 -> z4.LIZ).
   */
  async getMetaSecHandle() {
    return withJava(() => {
      try {
        const NetworkParams = Java.use(NETWORK_PARAMS);
        const provider = getProvider(NetworkParams);
        if (!provider) return { ok: false, error: 'provider not installed' };
        const providerClass = String(provider.getClass().getName());
        let handle = null;
        try {
          // y4.LIZ is z4; z4.LIZ is long handle
          const y4 = Java.cast(provider, Java.use('ms.bd.c.y4'));
          const z4 = y4.LIZ.value;
          handle = String(z4.LIZ.value);
        } catch (e) {
          return { ok: false, providerClass, error: safeString(e) };
        }
        return { ok: true, providerClass, handle };
      } catch (e) {
        return { ok: false, error: safeString(e) };
      }
    });
  },

  /**
   * Sign a URL only (no HTTP request). Returns the signed headers.
   * Optionally captures f3.a I/O when MetaSec is hooked for this call.
   */
  async signOnly(url, headers) {
    return withJava(() => {
      const f3Io = [];
      let f3Hooked = false;
      let originalF3 = null;
      try {
        const F3 = Java.use('ms.bd.c.f3');
        originalF3 = F3.a.overload('int', 'int', 'long', 'java.lang.String', 'java.lang.Object');
        originalF3.implementation = function (op, arg, handle, text, payload) {
          const result = originalF3.call(F3, op, arg, handle, text, payload);
          if (op === 50331649 || op === 100663297 || op === 0x03000001) {
            const values = [];
            const inputPairs = [];
            try {
              if (payload !== null) {
                const ReflectArray = Java.use('java.lang.reflect.Array');
                // payload may be String[]
                try {
                  const len = ReflectArray.getLength(payload);
                  for (let i = 0; i < len; i++) {
                    inputPairs.push(String(ReflectArray.get(payload, i)));
                  }
                } catch (_) {
                  // ArrayList?
                  try {
                    const list = Java.cast(payload, Java.use('java.util.List'));
                    for (let i = 0; i < list.size(); i++) inputPairs.push(String(list.get(i)));
                  } catch (__) {}
                }
              }
            } catch (_) {}
            if (result !== null) {
              try {
                const ReflectArray = Java.use('java.lang.reflect.Array');
                const length = ReflectArray.getLength(result);
                for (let i = 0; i < length; i++) values.push(String(ReflectArray.get(result, i)));
              } catch (error) {
                values.push('_decodeError=' + safeString(error));
              }
            }
            f3Io.push({
              op,
              arg,
              handle: String(handle),
              text: text === null ? null : String(text),
              input_pairs: inputPairs,
              output_pairs: values,
            });
          }
          return result;
        };
        f3Hooked = true;
      } catch (_) {}

      let signed = {};
      let signError = '';
      try {
        signed = signUrlHeaders(url, headers || {});
      } catch (e) {
        signError = safeString(e);
      }

      if (f3Hooked && originalF3) {
        try { originalF3.implementation = null; } catch (_) {}
      }

      const cookieInfo = collectCookiesForUrl(url);
      let handleInfo = null;
      try {
        const NetworkParams = Java.use(NETWORK_PARAMS);
        const provider = getProvider(NetworkParams);
        if (provider) {
          const y4 = Java.cast(provider, Java.use('ms.bd.c.y4'));
          handleInfo = {
            providerClass: String(provider.getClass().getName()),
            handle: String(y4.LIZ.value.LIZ.value),
          };
        }
      } catch (_) {}

      lastWireSnapshot = {
        captured_at: Date.now(),
        url: String(url || ''),
        method: 'SIGN_ONLY',
        body: '',
        base_headers: headers || {},
        signed_headers: signed,
        request_headers: { ...(headers || {}), ...signed },
        cookie_header: cookieInfo.cookie_header,
        cookies: cookieInfo.cookies,
        f3_io: f3Io,
        metasec_handle: handleInfo,
        sign_error: signError || undefined,
      };
      return {
        url: String(url || ''),
        headers: signed,
        cookie_header: cookieInfo.cookie_header,
        cookies: cookieInfo.cookies,
        f3_io: f3Io,
        metasec_handle: handleInfo,
        sign_error: signError || undefined,
        wire: lastWireSnapshot,
      };
    });
  },

  /** Return last captured wire/sign snapshot (for classification dumps). */
  async getLastWire() {
    return lastWireSnapshot;
  },

  /**
   * Export session material for Node-side pure/L2 HTTP.
   * Best-effort: cookies + any readable device prefs.
   */
  async exportSession() {
    return withJava(() => {
      const cookieInfo = collectCookiesForUrl('https://ecom.ecombdapi.com/');
      const cookieInfoSnssdk = collectCookiesForUrl('https://aweme.snssdk.com/');
      const cookieInfoHaohuo = collectCookiesForUrl('https://haohuo.jinritemai.com/');

      const mergedCookies = {
        ...cookieInfo.cookies,
        ...cookieInfoSnssdk.cookies,
        ...cookieInfoHaohuo.cookies,
      };
      const cookieHeader = [
        cookieInfo.cookie_header,
        cookieInfoSnssdk.cookie_header,
        cookieInfoHaohuo.cookie_header,
      ].filter(Boolean).join('; ');

      const device = {};
      const prefsTried = [];

      const prefNames = [
        'applog_stats',
        'ttnet_prefs',
        'device_register',
        'ss_app_config',
        'push_multi_process_config',
        'aweme_user',
      ];

      try {
        const ActivityThread = Java.use('android.app.ActivityThread');
        const ctx = ActivityThread.currentApplication().getApplicationContext();
        for (const name of prefNames) {
          try {
            const prefs = ctx.getSharedPreferences(name, 0);
            const all = prefs.getAll();
            if (!all) continue;
            const map = mapToObject(all);
            prefsTried.push({ name, keys: Object.keys(map || {}) });
            for (const [k, v] of Object.entries(map || {})) {
              const key = String(k).toLowerCase();
              if (
                key.includes('device_id') || key === 'deviceid'
                || key.includes('install_id') || key === 'iid'
                || key.includes('cdid') || key.includes('clientudid')
                || key.includes('openudid') || key.includes('klink')
                || key.includes('ms_token') || key.includes('mstoken')
                || key.includes('verify') || key.includes('session')
                || key.includes('x-tt-token') || key.includes('store-region')
              ) {
                device[k] = String(v);
              }
            }
          } catch (_) {}
        }
      } catch (e) {
        prefsTried.push({ error: safeString(e) });
      }

      return {
        exported_at: Date.now(),
        package: PACKAGE_NAME,
        cookie_header: cookieHeader,
        cookies: mergedCookies,
        device_candidates: device,
        prefs_tried: prefsTried,
        last_wire: lastWireSnapshot,
      };
    });
  },

  /**
   * Enumerate all loaded classes matching verification-related keywords.
   * Returns grouped list: captcha, face, identity, risk, verify, auth, fingerprint, other.
   */
  async enumerateVerifyClasses() {
    return withJava(() => {
      const KEYWORDS = [
        'turing', 'captcha', 'verify', 'face', 'identity',
        'liveness', 'risk', 'security', 'challenge', 'antibot',
        'realname', 'real_name', 'auth', 'check', 'guard',
        'fingerprint', 'devicecheck', 'safetynet', 'bdturing',
        'metasec', 'antifraud', 'spam', 'abuse',
      ];

      const classes = [];
      Java.enumerateLoadedClasses({
        onMatch: (c) => { classes.push(String(c)); },
        onComplete: () => {},
      });

      // Wait briefly for enumeration (synchronous enumerateLoadedClasses in Frida)
      // Then classify
      const groups = {
        captcha: [],
        face: [],
        identity: [],
        risk: [],
        verify: [],
        auth: [],
        fingerprint: [],
        other: [],
      };

      for (const cls of classes.sort()) {
        const lower = cls.toLowerCase();
        if (lower.includes('turing') || lower.includes('captcha')) groups.captcha.push(cls);
        else if (lower.includes('face') || lower.includes('liveness') || lower.includes('biometric')) groups.face.push(cls);
        else if (lower.includes('identity') || lower.includes('realname')) groups.identity.push(cls);
        else if (lower.includes('risk') || lower.includes('security') || lower.includes('spam') || lower.includes('abuse') || lower.includes('antifraud')) groups.risk.push(cls);
        else if (lower.includes('verify') || lower.includes('check')) groups.verify.push(cls);
        else if (lower.includes('auth') || lower.includes('login') || lower.includes('credential')) groups.auth.push(cls);
        else if (lower.includes('fingerprint') || lower.includes('devicecheck') || lower.includes('safetynet')) groups.fingerprint.push(cls);
        else groups.other.push(cls);
      }

      return {
        total: classes.length,
        groups,
        all: classes,
      };
    });
  },
};
