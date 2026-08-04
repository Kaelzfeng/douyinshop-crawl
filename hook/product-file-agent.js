import Java from 'frida-java-bridge';

/*
 * Frida Gadget script-mode agent.
 *
 * Writes product navigation and shorten request events to a file so the Node
 * crawler can read them through adb without using ptrace/attach/RPC.
 */

const EVENT_PATHS = [
  '/data/local/tmp/douyin-frida-events.jsonl',
  '/sdcard/Download/douyin-frida-events.jsonl',
];

function safeString(value) {
  try {
    if (value === null || value === undefined) return '';
    return String(value);
  } catch (_) {
    return '';
  }
}

function isInteresting(text) {
  return /ec_goods_detail|goods_detail|haohuo\.jinritemai\.com|lf\.snssdk\.com\/shorten|product_id=|promotion_id=/i.test(String(text || ''));
}

function appendEvent(payload) {
  const line = JSON.stringify(Object.assign({ ts: Date.now(), pid: Process.id }, payload));
  for (const eventPath of EVENT_PATHS) {
    try {
      const FileWriter = Java.use('java.io.FileWriter');
      const BufferedWriter = Java.use('java.io.BufferedWriter');
      const writer = BufferedWriter.$new(FileWriter.$new(eventPath, true));
      writer.write(line);
      writer.newLine();
      writer.close();
    } catch (_) {}
  }
}

function dumpBody(Java, body) {
  try {
    if (!body) return '';
    const BAOS = Java.use('java.io.ByteArrayOutputStream');
    const baos = BAOS.$new();
    body.writeTo(baos);
    return safeString(baos.toString('UTF-8'));
  } catch (error) {
    return `[body dump error] ${String(error)}`;
  }
}

function install() {
  if (typeof Java === 'undefined' || !Java.available) {
    setTimeout(install, 500);
    return;
  }

  Java.perform(() => {
    appendEvent({ type: 'ready', eventPaths: EVENT_PATHS });

    try {
      const Uri = Java.use('android.net.Uri');
      const parse = Uri.parse.overload('java.lang.String');
      parse.implementation = function (uri) {
        const text = safeString(uri);
        if (isInteresting(text)) appendEvent({ type: 'uri-parse', uri: text });
        return parse.call(this, uri);
      };
      appendEvent({ type: 'hooked', target: 'android.net.Uri.parse' });
    } catch (error) {
      appendEvent({ type: 'hook-failed', target: 'android.net.Uri.parse', error: String(error) });
    }

    try {
      const URL = Java.use('java.net.URL');
      const init = URL.$init.overload('java.lang.String');
      init.implementation = function (spec) {
        const text = safeString(spec);
        if (isInteresting(text)) appendEvent({ type: 'url-init', url: text });
        return init.call(this, spec);
      };
      appendEvent({ type: 'hooked', target: 'java.net.URL(String)' });
    } catch (error) {
      appendEvent({ type: 'hook-failed', target: 'java.net.URL(String)', error: String(error) });
    }

    try {
      const Builder = Java.use('com.bytedance.retrofit2.client.Request$Builder');
      const build = Builder.build;
      Builder.build.implementation = function () {
        const req = build.call(this);
        try {
          let url = '';
          let method = '';
          try { url = safeString(req.getUrl ? req.getUrl() : req.url); } catch (_) {}
          try { if (!url) url = safeString(req.url()); } catch (_) {}
          try { method = safeString(req.getMethod ? req.getMethod() : req.method); } catch (_) {}
          try { if (!method) method = safeString(req.method()); } catch (_) {}
          if (isInteresting(url)) {
            let body = '';
            try { body = dumpBody(Java, req.getBody ? req.getBody() : req.body); } catch (_) {}
            appendEvent({ type: 'bd-retrofit-request', method, url, body: body.slice(0, 16000) });
          }
        } catch (error) {
          appendEvent({ type: 'bd-retrofit-request-error', error: String(error) });
        }
        return req;
      };
      appendEvent({ type: 'hooked', target: 'com.bytedance.retrofit2.client.Request$Builder.build' });
    } catch (error) {
      appendEvent({ type: 'hook-failed', target: 'BD Retrofit Request.Builder', error: String(error) });
    }
  });
}

setImmediate(install);
