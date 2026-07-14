import Java from 'frida-java-bridge';

/**
 * Capture the official Douyin Mall share-link generation flow.
 *
 * This deliberately logs broad request/clipboard/URI events around a single
 * "share -> copy link" action. It avoids hardcoded endpoint assumptions so we
 * can discover the official short-link API.
 */

function safeString(v) {
  try {
    if (v === null || v === undefined) return '';
    return String(v);
  } catch (_) {
    return '';
  }
}

function shouldLogText(s) {
  // Keep this narrowly focused: the previous broad douyin/ecom matcher made
  // the app crawl because every image/gecko/common-param URI was emitted.
  return /before_share|fancy\/qrcode|v\.douyin|shareProductPoster|ecom_share_product|copy|clipboard|short|schema_type|schema_id|share|social|口令|抖音|商城|复制|链接/i.test(s);
}

function sendEvent(payload) {
  try {
    send(Object.assign({ ts: Date.now() }, payload));
  } catch (_) {}
}

function stackTrace(Java, max = 18) {
  try {
    var Throwable = Java.use('java.lang.Throwable');
    var st = Throwable.$new().getStackTrace();
    var out = [];
    for (var i = 0; i < st.length && i < max; i++) out.push(String(st[i]));
    return out;
  } catch (_) {
    return [];
  }
}

function dumpTypedOutput(Java, body) {
  var ret = { text: '', className: '', mimeType: '', length: -1, error: '' };
  try {
    if (!body) return ret;
    try { ret.className = safeString(body.getClass().getName()); } catch (_) {}
    try { ret.mimeType = safeString(body.mimeType()); } catch (_) {}
    try { ret.length = Number(body.length()); } catch (_) {}

    var BAOS = Java.use('java.io.ByteArrayOutputStream');
    var baos = BAOS.$new();
    body.writeTo(baos);
    try {
      ret.text = safeString(baos.toString('UTF-8'));
    } catch (_) {
      ret.text = safeString(baos.toString());
    }
  } catch (e) {
    ret.error = String(e);
  }
  return ret;
}

function install() {
  if (typeof Java === 'undefined' || !Java.available) {
    setTimeout(install, 500);
    return;
  }

  Java.perform(function () {
    sendEvent({ type: 'ready', pid: Process.id });

    // Clipboard is the ground truth: it contains the final official full text.
    try {
      var ClipboardManager = Java.use('android.content.ClipboardManager');
      ClipboardManager.setPrimaryClip.implementation = function (clip) {
        try {
          var item = clip.getItemAt(0);
          var text = item ? item.getText() : null;
          var s = text ? String(text) : '';
          if (s) {
            sendEvent({
              type: 'clipboard',
              text: s,
              stack: stackTrace(Java, 24),
            });
          }
        } catch (e) {
          sendEvent({ type: 'clipboard-error', error: String(e) });
        }
        return this.setPrimaryClip(clip);
      };
      sendEvent({ type: 'hooked', target: 'ClipboardManager.setPrimaryClip' });
    } catch (e) {
      sendEvent({ type: 'hook-failed', target: 'ClipboardManager.setPrimaryClip', error: String(e) });
    }

    // Share text often travels through Intent extras first.
    try {
      var Intent = Java.use('android.content.Intent');
      var putExtraString = Intent.putExtra.overload('java.lang.String', 'java.lang.String');
      putExtraString.implementation = function (name, value) {
        try {
          var n = String(name);
          var v = String(value);
          if (shouldLogText(n) || shouldLogText(v)) {
            sendEvent({
              type: 'intent-putExtra',
              name: n,
              value: v,
              stack: stackTrace(Java, 14),
            });
          }
        } catch (_) {}
        return putExtraString.call(this, name, value);
      };
      sendEvent({ type: 'hooked', target: 'Intent.putExtra(String,String)' });
    } catch (e) {
      sendEvent({ type: 'hook-failed', target: 'Intent.putExtra', error: String(e) });
    }

    // URI parsing catches short links and endpoint URLs even if networking is
    // hidden behind Cronet/native layers.
    try {
      var Uri = Java.use('android.net.Uri');
      var parse = Uri.parse.overload('java.lang.String');
      parse.implementation = function (uri) {
        try {
          var s = String(uri);
          if (shouldLogText(s)) {
            sendEvent({ type: 'uri-parse', uri: s, stack: stackTrace(Java, 12) });
          }
        } catch (_) {}
        return parse.call(this, uri);
      };
      sendEvent({ type: 'hooked', target: 'android.net.Uri.parse' });
    } catch (e) {
      sendEvent({ type: 'hook-failed', target: 'Uri.parse', error: String(e) });
    }

    // java.net.URL constructors catch many non-Retrofit requests.
    try {
      var URL = Java.use('java.net.URL');
      URL.$init.overload('java.lang.String').implementation = function (spec) {
        try {
          var s = String(spec);
          if (shouldLogText(s)) sendEvent({ type: 'url-init', url: s, stack: stackTrace(Java, 10) });
        } catch (_) {}
        return this.$init(spec);
      };
      sendEvent({ type: 'hooked', target: 'java.net.URL(String)' });
    } catch (e) {
      sendEvent({ type: 'hook-failed', target: 'URL(String)', error: String(e) });
    }

    // OkHttp request build with body dump.
    try {
      var OkBuilder = Java.use('okhttp3.Request$Builder');
      var okBuild = OkBuilder.build;
      OkBuilder.build.implementation = function () {
        var req = okBuild.call(this);
        try {
          var url = safeString(req.url());
          if (shouldLogText(url)) {
            var method = safeString(req.method());
            var headers = {};
            try {
              var h = req.headers();
              for (var i = 0; i < h.size() && i < 80; i++) headers[String(h.name(i))] = String(h.value(i));
            } catch (_) {}
            var bodyText = '';
            try {
              var body = req.body();
              if (body) {
                var Buffer = Java.use('okio.Buffer');
                var buffer = Buffer.$new();
                body.writeTo(buffer);
                bodyText = String(buffer.readUtf8());
              }
            } catch (be) {
              bodyText = '[body dump error] ' + String(be);
            }
            sendEvent({
              type: 'okhttp-request',
              method: method,
              url: url,
              headers: headers,
              body: bodyText.slice(0, 12000),
              stack: stackTrace(Java, 12),
            });
          }
        } catch (e) {
          sendEvent({ type: 'okhttp-request-error', error: String(e) });
        }
        return req;
      };
      sendEvent({ type: 'hooked', target: 'okhttp3.Request$Builder.build' });
    } catch (e) {
      sendEvent({ type: 'hook-failed', target: 'OkHttp Request.Builder', error: String(e) });
    }

    // ByteDance Retrofit request build. Most e-commerce APIs use this stack.
    try {
      var BdBuilder = Java.use('com.bytedance.retrofit2.client.Request$Builder');
      var bdBuild = BdBuilder.build;
      BdBuilder.build.implementation = function () {
        var req = bdBuild.call(this);
        try {
          var url = '';
          var method = '';
          var bodyText = '';
          var bodyClassName = '';
          var bodyMimeType = '';
          var bodyLength = -1;
          var bodyError = '';
          try { url = safeString(req.getUrl ? req.getUrl() : req.url); } catch (_) {}
          try { if (!url) url = safeString(req.url()); } catch (_) {}
          try { method = safeString(req.getMethod ? req.getMethod() : req.method); } catch (_) {}
          try { if (!method) method = safeString(req.method()); } catch (_) {}
          if (shouldLogText(url)) {
            var headerNames = [];
            try {
              var hs = req.getHeaders ? req.getHeaders() : req.headers;
              if (hs && hs.size) {
                for (var i = 0; i < hs.size() && i < 80; i++) {
                  try { headerNames.push(safeString(hs.get(i))); } catch (_) {}
                }
              }
            } catch (_) {}
            try {
              var body = req.getBody ? req.getBody() : req.body;
              var bodyDump = dumpTypedOutput(Java, body);
              bodyText = bodyDump.text || '';
              bodyClassName = bodyDump.className || '';
              bodyMimeType = bodyDump.mimeType || '';
              bodyLength = bodyDump.length;
              bodyError = bodyDump.error || '';
            } catch (be) {
              bodyText = '[body dump error] ' + String(be);
              bodyError = String(be);
            }
            sendEvent({
              type: 'bd-retrofit-request',
              method: method,
              url: url,
              headers: headerNames,
              bodyClassName: bodyClassName,
              bodyMimeType: bodyMimeType,
              bodyLength: bodyLength,
              bodyError: bodyError,
              body: bodyText.slice(0, 12000),
              stack: stackTrace(Java, 12),
            });
          }
        } catch (e) {
          sendEvent({ type: 'bd-retrofit-request-error', error: String(e) });
        }
        return req;
      };
      sendEvent({ type: 'hooked', target: 'com.bytedance.retrofit2.client.Request$Builder.build' });
    } catch (e) {
      sendEvent({ type: 'hook-failed', target: 'BD Retrofit Request.Builder', error: String(e) });
    }

    // Capture form fields as they are added. This is a safety net in case a
    // body object gets transformed later in the interceptor chain.
    try {
      var Form = Java.use('com.bytedance.retrofit2.mime.FormUrlEncodedTypedOutput');
      var addField2 = Form.addField.overload('java.lang.String', 'java.lang.String');
      addField2.implementation = function (name, value) {
        try {
          var n = safeString(name);
          var v = safeString(value);
          if (shouldLogText(n) || shouldLogText(v)) {
            sendEvent({ type: 'bd-form-field', name: n, value: v, stack: stackTrace(Java, 10) });
          }
        } catch (_) {}
        return addField2.call(this, name, value);
      };
      var addField4 = Form.addField.overload('java.lang.String', 'boolean', 'java.lang.String', 'boolean');
      addField4.implementation = function (name, encName, value, encValue) {
        try {
          var n = safeString(name);
          var v = safeString(value);
          if (shouldLogText(n) || shouldLogText(v)) {
            sendEvent({ type: 'bd-form-field', name: n, value: v, stack: stackTrace(Java, 10) });
          }
        } catch (_) {}
        return addField4.call(this, name, encName, value, encValue);
      };
      sendEvent({ type: 'hooked', target: 'FormUrlEncodedTypedOutput.addField' });
    } catch (e) {
      sendEvent({ type: 'hook-failed', target: 'FormUrlEncodedTypedOutput.addField', error: String(e) });
    }

    // Some services create URLs through WebView/loadUrl.
    try {
      var WebView = Java.use('android.webkit.WebView');
      WebView.loadUrl.overload('java.lang.String').implementation = function (url) {
        try {
          var s = String(url);
          if (shouldLogText(s)) sendEvent({ type: 'webview-loadUrl', url: s, stack: stackTrace(Java, 10) });
        } catch (_) {}
        return this.loadUrl(url);
      };
      sendEvent({ type: 'hooked', target: 'WebView.loadUrl(String)' });
    } catch (e) {
      sendEvent({ type: 'hook-failed', target: 'WebView.loadUrl', error: String(e) });
    }
  });
}

setTimeout(install, 1200);
sendEvent({ type: 'agent-loaded' });
