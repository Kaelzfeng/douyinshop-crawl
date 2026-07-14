/**
 * Frida SSL Pinning Bypass — hooks native SSL verification.
 * Works without Java bridge (pure native hooks).
 *
 * Usage: frida -H 127.0.0.1:27042 -n 抖音商城 -l ssl-bypass.js
 *   or:  python -m frida_tools.repl -H 127.0.0.1:27042 -n 抖音商城 -l ssl-bypass.js
 */

// Hook OpenSSL/BoringSSL SSL_set_custom_verify (native, works x86_64)
var sslLibs = ['libssl.so', 'libboringssl.so', 'libconscrypt_openjdk_jni.so',
               'libjavacrypto.so', 'libchrome.so'];

sslLibs.forEach(function(libName) {
  try {
    var lib = Process.getModuleByName(libName);
    console.log('[SSL Bypass] Found ' + libName + ' at ' + lib.base);

    // Try hooking common SSL verification functions
    var functions = [
      'SSL_set_custom_verify',
      'SSL_CTX_set_custom_verify',
      'SSL_set_verify',
      'SSL_CTX_set_verify',
      'SSL_get_verify_result',
      'SSL_set_hostflags',
    ];

    functions.forEach(function(funcName) {
      try {
        var funcAddr = Module.getExportByName(libName, funcName);
        if (funcAddr) {
          Interceptor.attach(funcAddr, {
            onEnter: function(args) {
              console.log('[SSL] ' + libName + '::' + funcName + ' called');
            },
            onLeave: function(retval) {
              // Force trust
              if (funcName.indexOf('verify') !== -1 && funcName.indexOf('result') !== -1) {
                retval.replace(0); // X509_V_OK
              }
            }
          });
          console.log('  Hooked: ' + funcName);
        }
      } catch(e) {}
    });
  } catch(e) {}
});

// Hook Java-level TrustManager via Native (Android's libjavacrypto)
try {
  var libjavacrypto = Process.getModuleByName('libjavacrypto.so');
  // This library contains the TrustManager implementation
  console.log('[SSL Bypass] Found libjavacrypto.so');

  // Try to find checkServerTrusted
  var exports = libjavacrypto.enumerateExports();
  exports.forEach(function(exp) {
    if (exp.name.indexOf('Trust') !== -1 || exp.name.indexOf('verify') !== -1 ||
        exp.name.indexOf('checkServer') !== -1 || exp.name.indexOf('Cert') !== -1) {
      console.log('  Found export: ' + exp.name + ' at ' + exp.address);
    }
  });
} catch(e) {}

// Hook common Android network security checks
try {
  var libandroid = Process.getModuleByName('libandroid_runtime.so');
  console.log('[SSL Bypass] Found libandroid_runtime.so');
} catch(e) {}

console.log('[SSL Bypass] Hooks installed. Proxy traffic should now flow.');
