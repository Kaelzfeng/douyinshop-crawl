/**
 * Capture /pack/ API responses — extract product data directly.
 * Bypasses the share-link step entirely.
 */
import Java from 'frida-java-bridge';

function extractVal(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  const s = String(raw);
  if (s.startsWith('Java.Field{')) {
    const m = s.match(/value:\s*(.+?)(?:,\s*\w+:|\})/);
    return m ? m[1] : null;
  }
  return s;
}

function install() {
  if (!Java.available) { setTimeout(install, 500); return; }

  Java.perform(() => {
    // Hook OkHttp RealCall.execute to capture responses
    try {
      const RealCall = Java.use('okhttp3.RealCall');
      const origExecute = RealCall.execute;
      RealCall.execute.implementation = function () {
        const response = origExecute.call(this);
        try {
          const request = this.request();
          const url = String(request.url());
          if (url.includes('/promotion/pack') || url.includes('/shop/promotion/')) {
            const body = response.peekBody(999999);
            const bodyStr = body.string();
            const code = response.code();

            send({
              type: 'pack-response',
              url: url,
              code: code,
              bodyLength: bodyStr.length,
              body: bodyStr.slice(0, 10000),
              timestamp: Date.now(),
            });
          }
        } catch(e) {}
        return response;
      };
      send({ type: 'hooked', target: 'OkHttp RealCall.execute' });
    } catch(e) { send({ type: 'hook-fail', target: 'RealCall', error: String(e) }); }

    // Also hook async execute via Callback
    try {
      const RealCall2 = Java.use('okhttp3.RealCall');
      RealCall2.enqueue.implementation = function (callback) {
        const origCallback = callback;
        const self = this;
        const ProxyCallback = Java.registerClass({
          name: 'com.frida.ProxyCallback',
          implements: [Java.use('okhttp3.Callback')],
          methods: {
            onResponse(call, response) {
              try {
                const url = String(call.request().url());
                if (url.includes('/promotion/pack') || url.includes('/shop/promotion/')) {
                  const body = response.peekBody(999999);
                  const bodyStr = body.string();
                  send({
                    type: 'pack-response-async',
                    url: url,
                    code: response.code(),
                    bodyLength: bodyStr.length,
                    body: bodyStr.slice(0, 10000),
                    timestamp: Date.now(),
                  });
                }
              } catch(e) {}
              origCallback.onResponse(call, response);
            },
            onFailure(call, e) {
              origCallback.onFailure(call, e);
            }
          }
        });
        return this.enqueue(ProxyCallback.$new());
      };
      send({ type: 'hooked', target: 'OkHttp RealCall.enqueue' });
    } catch(e) { /* async override may fail */ }
  });
}

setTimeout(install, 2000);
send({ type: 'ready' });
