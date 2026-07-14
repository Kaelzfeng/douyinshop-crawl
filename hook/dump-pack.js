// Full packet dump — captures EVERY detail of /promotion/pack/ requests
import Java from 'frida-java-bridge';

const TARGET = '/promotion/pack';

function extractVal(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  const s = String(raw);
  if (s.startsWith('Java.Field{')) {
    const m = s.match(/value:\s*(.+?)(?:,\s*\w+:|\})/);
    return m ? m[1] : null;
  }
  return s;
}

function installHooks() {
  if (!Java.available) { setTimeout(installHooks, 500); return; }

  Java.perform(() => {
    // ── Retrofit2 Request.Builder ──
    try {
      const B = Java.use('com.bytedance.retrofit2.client.Request$Builder');
      const orig = B.build;
      B.build.implementation = function () {
        const r = orig.call(this);
        try {
          const url = extractVal(r.url);
          if (url && url.includes(TARGET)) {
            send({ type: 'pack-build', url: url });

            // Dump ALL headers (names only)
            const hdrs = [];
            try {
              const h = r.headers;
              if (h && h.size) for (let i = 0; i < h.size(); i++) {
                hdrs.push(String(h.get(i).name));
              }
            } catch(e) {}

            // Dump body
            let body = null;
            try {
              const b = r.body; // TypedOutput
              if (b) {
                body = String(b);
                if (body.startsWith('Java.')) {
                  // Try to read body content via reflection
                  try {
                    const mimeType = String(b.mimeType?.() || '');
                    const len = Number(b.length?.() || 0);
                    body = { mimeType, length: len };
                  } catch(e2) { body = { raw: body.slice(0,200) }; }
                }
              }
            } catch(e) {}

            // Dump requestBody (OkHttp)
            let reqBody = null;
            try {
              const rb = r.requestBody;
              if (rb) {
                const ct = rb.contentType?.();
                reqBody = { contentType: ct ? String(ct) : null };
              }
            } catch(e) {}

            send({
              type: 'pack-detail',
              url: url,
              method: extractVal(r.method),
              headers: hdrs,
              body: body,
              requestBody: reqBody,
              queryEncrypted: r.isQueryEncryptEnabled || false,
              bodyEncrypted: r.isBodyEncryptEnabled || false,
            });
          }
        } catch(e) {}
        return r;
      };
      send({ type: 'hook', name: 'retrofit2' });
    } catch(e) { send({ type: 'hook-fail', name: 'retrofit2', err: String(e) }); }

    // ── OkHttp Request.Builder (catches the actual HTTP request) ──
    try {
      const OB = Java.use('okhttp3.Request$Builder');
      const oOrig = OB.build;
      OB.build.implementation = function () {
        const r = oOrig.call(this);
        try {
          const urlObj = r.url();
          const url = urlObj ? String(urlObj) : '';
          if (url.includes(TARGET)) {
            // Full headers
            const hdrs = {};
            const h = r.headers();
            for (let i = 0; i < h.size(); i++) {
              hdrs[String(h.name(i))] = String(h.value(i));
            }
            // Method & body
            let bodyStr = null;
            try {
              const rb = r.body();
              if (rb) {
                const buf = Java.use('okio.Buffer').$new();
                rb.writeTo(buf);
                bodyStr = buf.readUtf8();
              }
            } catch(e) {}

            send({
              type: 'pack-okhttp',
              url: url,
              method: String(r.method()),
              headers: hdrs,
              body: bodyStr,
            });
          }
        } catch(e) {}
        return r;
      };
      send({ type: 'hook', name: 'okhttp' });
    } catch(e) { send({ type: 'hook-fail', name: 'okhttp', err: String(e) }); }

    // ── Uri.Builder (a_bogus etc.) ──
    try {
      const UB = Java.use('android.net.Uri$Builder');
      const uOrig = UB.appendQueryParameter;
      UB.appendQueryParameter.implementation = function (n, v) {
        if (n && /bogus|sign|verify|token|fp|gorgan|argus|khronos|ladon/i.test(String(n))) {
          send({ type: 'query-param', name: String(n), valueLen: String(v||'').length });
        }
        return uOrig.call(this, n, v);
      };
    } catch(e) {}
  });
}

setTimeout(installHooks, 2000);
send({ type: 'ready' });
