/**
 * Frida Hook — Douyin Mall API Interceptor
 *
 * Hooks OkHttp requests/responses, crypto operations, and URL signing.
 * Waits for Java runtime before installing hooks.
 */

// Wait for Java VM to be ready, then install hooks
function installHooks() {
  // -------------------------------------------------------------------------
  // 1. Hook OkHttp — intercept all HTTP requests
  // -------------------------------------------------------------------------
  try {
    var RequestBuilder = Java.use('okhttp3.Request$Builder');
    var originalBuild = RequestBuilder.build;
    RequestBuilder.build.implementation = function () {
      var request = originalBuild.call(this);
      var url = request.url().toString();
      var method = request.method();

      if (url.indexOf('jinritemai.com') > -1 || url.indexOf('douyin.com') > -1) {
        if (url.indexOf('/aweme/') > -1 || url.indexOf('/ecom/') > -1 ||
            url.indexOf('/shop/') > -1 || url.indexOf('/product/') > -1 ||
            url.indexOf('/goods/') > -1 || url.indexOf('/search/') > -1) {

          console.log('\n[REQ] ' + method + ' ' + url);

          // Log signing headers
          var headers = request.headers();
          for (var i = 0; i < headers.size(); i++) {
            var name = headers.name(i);
            var value = headers.value(i);
            if (name.indexOf('bogus') > -1 || name.indexOf('sign') > -1 ||
                name.indexOf('token') > -1 || name.indexOf('fp') > -1 ||
                name.indexOf('verify') > -1 || name.indexOf('auth') > -1) {
              console.log('  Hdr: ' + name + ' = ' + value);
            }
          }

          // Log POST body
          if (method === 'POST') {
            try {
              var body = request.body();
              if (body) {
                var Buffer = Java.use('okio.Buffer');
                var buffer = Buffer.$new();
                body.writeTo(buffer);
                var bodyStr = buffer.readUtf8();
                if (bodyStr.length < 3000) {
                  console.log('  Body: ' + bodyStr);
                } else {
                  console.log('  Body: ' + bodyStr.substring(0, 1500) + '...');
                }
              }
            } catch (e) {}
          }
        }
      }
      return request;
    };
    console.log('[FRIDA] OkHttp Request hooked');
  } catch (e) { console.log('[FRIDA] Request hook failed: ' + e); }

  // -------------------------------------------------------------------------
  // 2. Hook Response via RealCall.execute (synchronous HTTP calls)
  // -------------------------------------------------------------------------
  try {
    var RealCall = Java.use('okhttp3.RealCall');
    var origExecute = RealCall.execute;
    RealCall.execute.implementation = function () {
      var response = origExecute.call(this);
      try {
        var url = this.request().url().toString();
        if (url.indexOf('jinritemai.com') > -1 &&
            (url.indexOf('/aweme/') > -1 || url.indexOf('/ecom/') > -1 ||
             url.indexOf('/shop/') > -1 || url.indexOf('/product/') > -1)) {

          var respBody = response.peekBody(999999);
          var bodyStr = respBody.string();
          var code = response.code();
          console.log('\n[RESP] ' + code + ' ' + url);

          if (bodyStr.length > 0 && bodyStr.length < 10000 && bodyStr.charAt(0) === '{') {
            console.log('  ' + bodyStr);
          } else if (bodyStr.length > 0) {
            console.log('  ' + bodyStr.substring(0, 2000));
          }
        }
      } catch (e) {}
      return response;
    };
    console.log('[FRIDA] OkHttp Response hooked');
  } catch (e) { console.log('[FRIDA] Response hook failed: ' + e); }

  // -------------------------------------------------------------------------
  // 3. Hook URL building — capture a_bogus generation
  // -------------------------------------------------------------------------
  try {
    var HttpUrlBuilder = Java.use('okhttp3.HttpUrl$Builder');
    var origAddQp = HttpUrlBuilder.addQueryParameter;

    HttpUrlBuilder.addQueryParameter.implementation = function (name, value) {
      if (name === 'a_bogus' || name === 'verifyFp' || name.indexOf('sign') > -1) {
        console.log('\n[SIGN] ' + name + ' = ' + value);
        // Print stack to find signing function
        var stack = Java.use('java.lang.Throwable').$new().getStackTrace();
        for (var i = 0; i < Math.min(stack.length, 8); i++) {
          console.log('  ' + stack[i].toString());
        }
      }
      return origAddQp.call(this, name, value);
    };
    console.log('[FRIDA] URL signing hooked');
  } catch (e) { console.log('[FRIDA] URL hook failed: ' + e); }

  // -------------------------------------------------------------------------
  // 4. Hook crypto — capture MD5/SHA signing inputs
  // -------------------------------------------------------------------------
  try {
    var MessageDigest = Java.use('java.security.MessageDigest');
    var origDigestBytes = MessageDigest.digest.overload('[B');
    MessageDigest.digest.overload('[B').implementation = function (input) {
      var hash = origDigestBytes.call(this, input);
      if (input.length > 16 && input.length < 5000) {
        var alg = this.getAlgorithm();
        try {
          var inputStr = Java.use('java.lang.String').$new(input, 'UTF-8');
          if (inputStr.length > 10 && inputStr.length < 500 && inputStr.indexOf('http') !== 0) {
            var hex = '';
            for (var i = 0; i < Math.min(hash.length, 32); i++) {
              hex += ('0' + (hash[i] & 0xFF).toString(16)).slice(-2);
            }
            console.log('[CRYPTO] ' + alg + ' input="' + inputStr.substring(0, 100) + '" hash=' + hex);
          }
        } catch (e) {}
      }
      return hash;
    };
    console.log('[FRIDA] Crypto hooked');
  } catch (e) { console.log('[FRIDA] Crypto hook failed: ' + e); }

  console.log('[FRIDA] All hooks installed. Watching...\n');
}

// Wait for Java VM, then install hooks (poll for up to 30 seconds)
var attempts = 0;
var maxAttempts = 60;
(function pollForJava() {
  if (Java.available) {
    Java.perform(installHooks);
  } else if (attempts < maxAttempts) {
    attempts++;
    if (attempts === 1) console.log('[FRIDA] Waiting for Java VM...');
    setTimeout(pollForJava, 500);
  } else {
    console.log('[FRIDA] Java VM not available after 30s. Is this an Android Java process?');
  }
})();
