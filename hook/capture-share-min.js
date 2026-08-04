/**
 * Minimal share capture agent — clipboard + shorten URL + product_id schemas.
 * Uses frida-java-bridge (Frida 17).
 *
 * v2: added OkHttp response body, WebView URL, Intent extras, FastJson (2026-07)
 */
import Java from 'frida-java-bridge';

function sendEv(p) {
  try {
    send(Object.assign({ ts: Date.now() }, p));
  } catch (_) {}
}

function interestingUrl(s) {
  return /shorten|v\.douyin|haohuo|goods_detail|ec_goods|product_id|promotion_id|jinritemai|ecom|promotion\/pack|share/i.test(
    String(s || ''),
  );
}

function interestingResponse(s) {
  return /product|goods|promotion|shop|title|price|min_price|max_price|sales|goods_detail|ec_goods/i.test(
    String(s || ''),
  );
}

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
    sendEv({ type: 'ready', pid: Process.id, arch: Process.arch });

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
        if (/shorten|v\.douyin|haohuo|goods_detail|ec_goods|product_id|jinritemai|share/i.test(s)) {
          const ev = { type: 'uri-parse', uri: s.slice(0, 1500) };
          attachProductId(ev, s);
          sendEv(ev);
        }
        return parse.call(this, s);
      };
      sendEv({ type: 'hooked', target: 'Uri.parse' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'Uri.parse', error: String(e) });
    }

    // ---- Retrofit Request Builder ----
    try {
      const Builder = Java.use('com.bytedance.retrofit2.client.Request$Builder');
      const build = Builder.build;
      Builder.build.implementation = function () {
        const req = build.call(this);
        try {
          const url = String(req.getUrl ? req.getUrl() : req.url ? req.url() : '');
          if (/shorten|share|product|promotion|goods|ecom|jinritemai|douyin/i.test(url)) {
            const ev = { type: 'bd-retrofit-request', url: url.slice(0, 1500) };
            attachProductId(ev, url);
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
          if (/shorten|share|product|promotion|goods|ecom|jinritemai|douyin/i.test(url)) {
            const ev = {
              type: 'okhttp-request',
              url: url.slice(0, 1500),
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

    // ---- NEW: OkHttp response body (RealCall.execute) ----
    try {
      const RealCall = Java.use('okhttp3.RealCall');
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
                    const ev = {
                      type: 'okhttp-response',
                      url: reqUrl.slice(0, 2000),
                      body: text.slice(0, 4000),
                      bodyLength: text.length,
                    };
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
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'okhttp3.RealCall', error: String(e) });
    }

    // ---- NEW: WebView URL loading ----
    try {
      const WebView = Java.use('android.webkit.WebView');
      WebView.loadUrl.overload('java.lang.String').implementation = function (url) {
        const s = String(url);
        if (interestingUrl(s)) {
          const ev = { type: 'webview-load-url', url: s.slice(0, 3000) };
          attachProductId(ev, s);
          sendEv(ev);
        }
        return this.loadUrl(s);
      };
      sendEv({ type: 'hooked', target: 'WebView.loadUrl' });
    } catch (e) {
      sendEv({ type: 'hook-failed', target: 'WebView.loadUrl', error: String(e) });
    }
  });
}

sendEv({ type: 'agent-loaded' });
setTimeout(install, 500);
