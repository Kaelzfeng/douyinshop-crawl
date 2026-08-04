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

    // Apply base headers
    for (const [name, value] of Object.entries(headers || {})) {
      if (name && value) conn.setRequestProperty(String(name), String(value));
    }

    // Sign the URL + current headers via NetworkParams
    try {
      const NetworkParams = Java.use(NETWORK_PARAMS);
      const provider = getProvider(NetworkParams);
      if (provider) {
        const currentHeaders = conn.getRequestProperties();
        const headerMap = buildHeaderMap(mapToListOfStrings(currentHeaders));
        const signMethod = NetworkParams.LJIILLIIL.overload('java.lang.String', 'java.util.Map');
        const signed = signMethod.call(NetworkParams, String(url), headerMap);
        const signedObj = mapToObject(signed);
        if (signedObj) {
          for (const [k, v] of Object.entries(signedObj)) {
            try { conn.setRequestProperty(k, String(v)); } catch (_) {}
          }
        }
      }
    } catch (_) {}

    // Write body
    if (postBody && (method === 'POST' || method === 'PUT')) {
      conn.setDoOutput(true);
      const bodyBytes = Java.array('byte', String(postBody).split('').map(c => c.charCodeAt(0)));
      conn.setRequestProperty('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
      const os = conn.getOutputStream();
      os.write(bodyBytes);
      os.close();
    }

    // Read response
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
      // Try error stream
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

    return {
      status,
      headers: responseHeaders,
      body,
      url: String(url),
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
   * Sign a URL only (no HTTP request). Returns the signed headers.
   * Useful for Node-side HTTP with Frida-signed headers.
   */
  async signOnly(url, headers) {
    return withJava(() => {
      const NetworkParams = Java.use(NETWORK_PARAMS);
      const provider = getProvider(NetworkParams);
      if (!provider) throw new Error('MetaSec provider not installed yet');
      const method = NetworkParams.LJIILLIIL.overload('java.lang.String', 'java.util.Map');
      const result = method.call(NetworkParams, String(url || ''), buildHeaderMap(headers || {}));
      return {
        url: String(url || ''),
        headers: mapToObject(result),
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
