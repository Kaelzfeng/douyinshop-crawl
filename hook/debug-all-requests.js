/**
 * Minimal debug hook — catches ALL network requests to discover actual URLs.
 */
import Java from 'frida-java-bridge';

send({ type: 'agent-loaded', pid: Process.id, arch: Process.arch });

function installJavaHooks() {
  if (!Java.available) { setTimeout(installJavaHooks, 500); return; }

  Java.perform(() => {
    // Hook all OkHttp requests (catches everything)
    try {
      const OkHttpRequestBuilder = Java.use('okhttp3.Request$Builder');
      const origBuild = OkHttpRequestBuilder.build;
      OkHttpRequestBuilder.build.implementation = function () {
        const request = origBuild.call(this);
        try {
          const urlObj = request.url();
          const url = urlObj ? String(urlObj) : null;
          const method = request.method();
          const methodStr = method ? String(method) : '?';

          if (url) {
            send({ type: 'all-request', layer: 'okhttp', method: methodStr, url: url });
            console.log('[OKHTTP] ' + methodStr + ' ' + url);

            // Log header names
            const headers = request.headers();
            const names = [];
            for (let i = 0; i < headers.size() && i < 30; i++) {
              try { names.push(String(headers.name(i))); } catch(e) {}
            }
            send({ type: 'request-headers', url: url, headerNames: names });
          }
        } catch(e) {}
        return request;
      };
      send({ type: 'hook-ready', target: 'OkHttp Request.Builder.build()' });
      console.log('[DEBUG] OkHttp hooked');
    } catch(e) {
      send({ type: 'hook-failed', target: 'OkHttp', error: String(e) });
    }

    // Hook Retrofit2 Request (ByteDance fork)
    try {
      const BdRequest = Java.use('com.bytedance.retrofit2.client.Request$Builder');
      const origBd = BdRequest.build;
      BdRequest.build.implementation = function () {
        const req = origBd.call(this);
        try {
          const url = String(req.url || '');
          const method = String(req.method || 'GET');
          if (url) {
            send({ type: 'all-request', layer: 'retrofit2', method: method, url: url });
            console.log('[RETROFIT] ' + method + ' ' + url);
          }
        } catch(e) {}
        return req;
      };
      send({ type: 'hook-ready', target: 'Retrofit2 Request.Builder.build()' });
      console.log('[DEBUG] Retrofit2 hooked');
    } catch(e) {
      send({ type: 'hook-failed', target: 'Retrofit2', error: String(e) });
    }
  });
}

// Wait for VM
setTimeout(installJavaHooks, 3000);
console.log('[DEBUG] Waiting for Java VM...');
