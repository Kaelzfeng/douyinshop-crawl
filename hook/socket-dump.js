/**
 * Bottom-up dump — hook the raw socket/stream write to capture the
 * FINAL signed HTTP request bytes, regardless of where signing happens.
 *
 * Strategy: hook java.io.OutputStream.write(byte[]) on the HTTP connection.
 * This catches the request AFTER all interceptors, Cronet, and signing.
 */
import Java from 'frida-java-bridge';

function install() {
  if (!Java.available) { setTimeout(install, 500); return; }

  Java.perform(() => {
    // Hook BufferedOutputStream / DataOutputStream — the final write before socket
    const targets = [
      'java.io.BufferedOutputStream',
      'java.io.DataOutputStream',
      'okio.RealBufferedSink',
      'okio.Buffer',
    ];

    for (const clsName of targets) {
      try {
        const C = Java.use(clsName);
        // Hook write(byte[], int, int)
        C.write.overload('[B', 'int', 'int').implementation = function (b, off, len) {
          try {
            const str = Java.use('java.lang.String').$new(b, off, len, 'UTF-8');
            const s = String(str);
            // Only log HTTP requests to our targets
            if (s.startsWith('POST') || s.startsWith('GET')) {
              const lines = s.split('\r\n');
              const firstLine = lines[0] || '';
              if (/ecombdapi|snssdk|jinritemai|douyin/i.test(firstLine) &&
                  /\/aweme\/|\/ecom\/|\/shop\/|\/promotion/i.test(firstLine)) {
                send({
                  type: 'raw-request',
                  requestLine: firstLine,
                  headerCount: lines.filter(l => l.includes(':')).length,
                  fullLength: s.length,
                  headers: lines.filter(l => /bogus|sign|token|fp|verify|metasec|ttnet|gorgan|argus|khronos|ladon|ss-stub|cookie|content-type|host|user-agent/i.test(l.toLowerCase())),
                  bodyStart: s.indexOf('\r\n\r\n'),
                });
                // Print signing headers specifically
                const signLines = lines.filter(l => /bogus|sign|token|fp|verify|metasec|gorgan|argus|khronos|ladon|ss-stub/i.test(l));
                if (signLines.length > 0) {
                  send({ type: 'sign-headers', headers: signLines });
                }
              }
            }
          } catch(e) {}
          return this.write(b, off, len);
        };
        // Catch write(byte[])
        try {
          C.write.overload('[B').implementation = function (b) {
            return this.write(b, 0, b.length);
          };
        } catch(e) {}
        send({ type: 'hooked-output', class: clsName });
        break; // Only hook the first available
      } catch(e) {}
    }

    // Also hook Cronet's BidirectionalStream / UrlRequest if available
    try {
      const CronetEngine = Java.use('org.chromium.net.impl.CronetUrlRequest');
      const origStart = CronetEngine.start;
      CronetEngine.start.implementation = function () {
        try {
          // Try to read URL from the request
          const url = this.getCurrentUrl?.() || '?';
          send({ type: 'cronet-start', url: String(url) });
        } catch(e) {}
        return origStart.call(this);
      };
      send({ type: 'hooked-output', class: 'CronetUrlRequest' });
    } catch(e) {}

    // Hook OkHttp's sink write (final bytes before socket)
    try {
      const Sink = Java.use('okhttp3.internal.http1.Http1ExchangeCodec');
      Sink.writeRequestHeaders.implementation = function (headers, requestLine) {
        send({
          type: 'okhttp-final',
          requestLine: String(requestLine),
          headerCount: headers.size(),
        });
        // Log signing headers
        for (let i = 0; i < headers.size(); i++) {
          const n = String(headers.name(i));
          const v = String(headers.value(i));
          if (/bogus|sign|token|fp|verify|metasec|gorgan|argus|khronos|ladon|ss-stub/i.test(n)) {
            send({ type: 'sign-header', name: n, valueLen: v.length, url: String(requestLine) });
          }
        }
        return this.writeRequestHeaders(headers, requestLine);
      };
      send({ type: 'hooked-output', class: 'Http1ExchangeCodec' });
    } catch(e) {}
  });
}

setTimeout(install, 2000);
send({ type: 'ready' });
