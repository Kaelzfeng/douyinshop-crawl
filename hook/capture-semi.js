/**
 * Semi-reverse capture agent:
 * - product detail URIs (product_id / goods_detail / haohuo)
 * - clipboard short links (if any)
 * - shorten request URLs
 * - OkHttp / Retrofit ecom traffic
 * - OkHttp response body interception (goods_detail JSON)
 * - WebView URL loading
 * - Intent product data
 * - Retrofit FastJson response converter
 *
 * v2: added response body capture, WebView hooks, Intent extras (2026-07)
 */
import Java from 'frida-java-bridge';

function sendEv(p) {
  try {
    send(Object.assign({ ts: Date.now() }, p));
  } catch (_) {}
}

function interestingUrl(s) {
  return /shorten|v\.douyin|haohuo|goods_detail|ec_goods|product_id|promotion_id|jinritemai|ecom|promotion\/pack|share|sslocal|ecombdapi/i.test(
    String(s || ''),
  );
}

function interestingResponse(s) {
  return /product|goods|promotion|shop|title|price|min_price|max_price|sales|goods_detail|ec_goods|promotion_h5/i.test(
    String(s || ''),
  );
}

/**
 * Extract 15-22 digit product_id from any string and attach to event.
 */
function attachProductId(ev, raw) {
  const s = String(raw || '');
  const m = s.match(/\b\d{16,22}\b/);
  if (m) ev.extractedProductId = m[0];
}

function install() {
  if (!Java.available) {
    setTimeout(install, 400);
    return;
  }

  Java.perform(() => {
    sendEv({ type: 'ready', pid: Process.id, arch: Process.arch, mode: 'semi' });

    // ---- Clipboard ----
    try {
      const CM = Java.use('android.content.ClipboardManager');
      CM.setPrimaryClip.implementation = function (clip) {
        try {
          const item = clip.getItemAt(0);
          const text = item ? item.getText() : null;
          const s = text ? String(text) : '';
          if (s) {
            const ev = { type: 'clipboard', text: s.slice(0, 2000) };
            attachProductId(ev, s);
            sendEv(ev);
          }
        } catch (e) {
          sendEv({ type: 'clipboard-error', error: String(e) });
        }
        return this.setPrimaryClip(clip);
      };
      sendEv({ type: 'hooked', target: 'ClipboardManager.setPrimaryClip' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'ClipboardManager', error: String(e) });
    }

    // ---- Uri.parse ----
    try {
      const Uri = Java.use('android.net.Uri');
      const parse = Uri.parse.overload('java.lang.String');
      parse.implementation = function (uri) {
        const s = String(uri);
        if (interestingUrl(s)) {
          const ev = { type: 'uri-parse', uri: s.slice(0, 4000) };
          attachProductId(ev, s);
          sendEv(ev);
        }
        return parse.call(this, s);
      };
      sendEv({ type: 'hooked', target: 'Uri.parse' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'Uri.parse', error: String(e) });
    }

    // ---- java.net.URL ----
    try {
      const URL = Java.use('java.net.URL');
      URL.$init.overload('java.lang.String').implementation = function (spec) {
        const s = String(spec);
        if (interestingUrl(s)) {
          const ev = { type: 'url-init', url: s.slice(0, 4000) };
          attachProductId(ev, s);
          sendEv(ev);
        }
        return this.$init(spec);
      };
      sendEv({ type: 'hooked', target: 'URL(String)' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'URL', error: String(e) });
    }

    // ---- Retrofit Request Builder (with body capture for 39.6.0) ----
    try {
      const Builder = Java.use('com.bytedance.retrofit2.client.Request$Builder');
      const build = Builder.build;
      Builder.build.implementation = function () {
        const req = build.call(this);
        try {
          let url = '';
          try { url = String(req.getUrl()); } catch (_) {
            try { url = String(req.url()); } catch (__) {}
          }
          if (interestingUrl(url)) {
            const ev = { type: 'bd-retrofit-request', url: url.slice(0, 4000) };
            attachProductId(ev, url);
            // Capture request body (contains product_id / promotion_ids in POST body)
            try {
              const body = req.getBody ? req.getBody() : (req.body ? req.body() : null);
              if (body) {
                try { ev.mimeType = String(body.mimeType()); } catch (_) {}
                try { ev.bodyLength = Number(body.length()); } catch (_) {}
                try {
                  const BAOS = Java.use('java.io.ByteArrayOutputStream');
                  const baos = BAOS.$new();
                  body.writeTo(baos);
                  ev.body = String(baos.toString('UTF-8')).slice(0, 4000);
                } catch (_) {}
              }
            } catch (_) {}
            sendEv(ev);
          }
        } catch (_) {}
        return req;
      };
      sendEv({ type: 'hooked', target: 'bd-retrofit Request.Builder' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'bd-retrofit', error: String(e) });
    }

    // ---- OkHttp Request Builder ----
    try {
      const OkBuilder = Java.use('okhttp3.Request$Builder');
      const okBuild = OkBuilder.build;
      OkBuilder.build.implementation = function () {
        const req = okBuild.call(this);
        try {
          const url = String(req.url());
          if (interestingUrl(url)) {
            const ev = {
              type: 'okhttp-request',
              url: url.slice(0, 4000),
              method: String(req.method()),
            };
            attachProductId(ev, url);
            sendEv(ev);
          }
        } catch (_) {}
        return req;
      };
      sendEv({ type: 'hooked', target: 'okhttp Request.Builder' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'okhttp', error: String(e) });
    }

    // ---- Form fields (shorten targets=...) ----
    try {
      const Form = Java.use('com.bytedance.retrofit2.mime.FormUrlEncodedTypedOutput');
      Form.addField.overload('java.lang.String', 'java.lang.String').implementation = function (name, value) {
        try {
          const n = String(name);
          const v = String(value);
          if (interestingUrl(n) || interestingUrl(v) || n === 'targets') {
            const ev = { type: 'form-field', name: n, value: v.slice(0, 4000) };
            attachProductId(ev, v);
            sendEv(ev);
          }
        } catch (_) {}
        return this.addField(name, value);
      };
      sendEv({ type: 'hooked', target: 'FormUrlEncodedTypedOutput.addField' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'FormUrlEncoded', error: String(e) });
    }

    // =====================================================================
    // OkHttp response body interception (39.6.0 compatible)
    // RealCall may be in platform classloader; try multiple fallbacks
    // =====================================================================

    function tryHookRealCall() {
      let RealCall = null;
      // Try 1: direct Java.use
      try { RealCall = Java.use('okhttp3.RealCall'); } catch (_) {}
      // Try 2: enumerate classloaders (39.6.0 plugin isolation)
      if (!RealCall) {
        try {
          const loaders = Java.enumerateClassLoadersSync();
          for (const cl of loaders) {
            try { RealCall = cl.use('okhttp3.RealCall'); if (RealCall) break; } catch (_) {}
          }
        } catch (_) {}
      }
      // Try 3: OkHttp 4.x internal path
      if (!RealCall) {
        try { RealCall = Java.use('okhttp3.internal.connection.RealCall'); } catch (_) {}
      }

      if (!RealCall) {
        sendEv({ type: 'hook-failed', target: 'okhttp3.RealCall', error: 'Class not found in any classloader' });
        return;
      }

      // ---- execute() ----
      RealCall.execute.implementation = function () {
        const response = this.execute();
        try {
          const reqUrl = String(this.request().url());
          if (/promotion.*pack|goods.*detail|product.*detail|ec_goods|ecom.*detail|promotion_id/i.test(reqUrl)) {
            try {
              const body = response.body();
              if (body) {
                const source = body.source();
                if (source) {
                  const Buffer = Java.use('okio.Buffer');
                  const buffer = Buffer.$new();
                  source.readAll(buffer);
                  const text = buffer.readUtf8();
                  const MAX_BODY = 50000;
                  if (text && text.length > 50 && text.length < MAX_BODY) {
                    const ev = { type: 'okhttp-response', url: reqUrl.slice(0, 2000), body: text.slice(0, 4000), bodyLength: text.length };
                    attachProductId(ev, text);
                    sendEv(ev);
                  }
                }
              }
            } catch (_) {}
          }
        } catch (_) {}
        return response;
      };
      sendEv({ type: 'hooked', target: 'okhttp3.RealCall.execute' });
    }
    tryHookRealCall();

    // ---- OkHttpClient.newCall — broader hook for 39.6.0 ----
    try {
      const OkHttpClient = Java.use('okhttp3.OkHttpClient');
      OkHttpClient.newCall.implementation = function (request) {
        const call = this.newCall(request);
        try {
          const url = String(request.url());
          if (interestingUrl(url)) {
            sendEv({ type: 'okhttp-newcall', url: url.slice(0, 2000), method: String(request.method()) });
          }
        } catch (_) {}
        return call;
      };
      sendEv({ type: 'hooked', target: 'okhttp3.OkHttpClient.newCall' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'OkHttpClient.newCall', error: String(e) });
    }

    // ---- WebView URL loading ----
    try {
      const WebView = Java.use('android.webkit.WebView');
      WebView.loadUrl.overload('java.lang.String').implementation = function (url) {
        const s = String(url);
        if (interestingUrl(s)) {
          const ev = { type: 'webview-load-url', url: s.slice(0, 4000) };
          attachProductId(ev, s);
          sendEv(ev);
        }
        return this.loadUrl(s);
      };
      sendEv({ type: 'hooked', target: 'WebView.loadUrl' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'WebView.loadUrl', error: String(e) });
    }

    // ---- WebViewClient shouldOverrideUrlLoading (39.6.0: use 'android.webkit.WebResourceRequest' overload) ----
    try {
      const WebViewClient = Java.use('android.webkit.WebViewClient');
      try {
        // Try the WebResourceRequest overload first (newer API)
        WebViewClient.shouldOverrideUrlLoading.overload('android.webkit.WebView', 'android.webkit.WebResourceRequest').implementation = function (view, request) {
          try {
            const s = String(request.getUrl().toString());
            if (interestingUrl(s)) {
              sendEv({ type: 'webview-override-url', url: s.slice(0, 4000) });
            }
          } catch (_) {}
          return this.shouldOverrideUrlLoading(view, request);
        };
      } catch (_) {
        // Fallback: String overload
        WebViewClient.shouldOverrideUrlLoading.overload('android.webkit.WebView', 'java.lang.String').implementation = function (view, url) {
          const s = String(url);
          if (interestingUrl(s)) {
            sendEv({ type: 'webview-override-url', url: s.slice(0, 4000) });
            attachProductId({}, s);
          }
          return this.shouldOverrideUrlLoading(view, url);
        };
      }
      sendEv({ type: 'hooked', target: 'WebViewClient.shouldOverrideUrlLoading' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'WebViewClient', error: String(e) });
    }

    // ---- Intent extras ----
    try {
      const Intent = Java.use('android.content.Intent');
      Intent.getStringExtra.overload('java.lang.String').implementation = function (name) {
        const result = this.getStringExtra(name);
        const s = String(result || '');
        if (s.length > 10 && /haohuo|goods_detail|product_id|jinritemai/.test(s)) {
          const ev = { type: 'intent-extra', name: String(name), value: s.slice(0, 4000) };
          attachProductId(ev, s);
          sendEv(ev);
        }
        return result;
      };
      sendEv({ type: 'hooked', target: 'Intent.getStringExtra' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'Intent', error: String(e) });
    }

    // ---- OkHttp Request.Builder.addHeader — capture signing headers ----
    try {
      const OkBuilder = Java.use('okhttp3.Request$Builder');
      const addHeader = OkBuilder.addHeader.overload('java.lang.String', 'java.lang.String');
      addHeader.implementation = function (name, value) {
        if (/^(x-|pigeon|a_bogus|bogus)/i.test(String(name))) {
          sendEv({ type: 'request-header', name: String(name), value: String(value) });
        }
        return addHeader.call(this, name, value);
      };
      sendEv({ type: 'hooked', target: 'okhttp3.Request$Builder.addHeader' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'okhttp3.Request$Builder.addHeader', error: String(e) });
    }

    // ---- Gson.fromJson — intercept ALL JSON responses (39.6.0 replacement for FastJson) ----
    try {
      const Gson = Java.use('com.google.gson.Gson');
      const fromJson = Gson.fromJson.overload('java.lang.String', 'java.lang.Class');
      fromJson.implementation = function (json, clazz) {
        const result = fromJson.call(this, json, clazz);
        try {
          const s = String(json);
          if (s.length > 100 && interestingResponse(s)) {
            const ev = { type: 'gson-response', body: s.slice(0, 4000), bodyLength: s.length, className: String(clazz.getName()) };
            attachProductId(ev, s);
            sendEv(ev);
          }
        } catch (_) {}
        return result;
      };
      sendEv({ type: 'hooked', target: 'Gson.fromJson' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'Gson.fromJson', error: String(e) });
    }

    // ---- Gson.fromJson (Type overload) ----
    try {
      const Gson = Java.use('com.google.gson.Gson');
      const fromJsonType = Gson.fromJson.overload('java.lang.String', 'java.lang.reflect.Type');
      fromJsonType.implementation = function (json, type) {
        const result = fromJsonType.call(this, json, type);
        try {
          const s = String(json);
          if (s.length > 100 && interestingResponse(s)) {
            const ev = { type: 'gson-response', body: s.slice(0, 4000), bodyLength: s.length, typeName: String(type.toString()) };
            attachProductId(ev, s);
            sendEv(ev);
          }
        } catch (_) {}
        return result;
      };
      sendEv({ type: 'hooked', target: 'Gson.fromJson(Type)' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'Gson.fromJson(Type)', error: String(e) });
    }
  });
}

sendEv({ type: 'agent-loaded' });
setTimeout(install, 400);
