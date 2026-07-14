/**
 * Hook libmetasec_ml.so JNI_OnLoad to intercept native method registration.
 * Then hook the registered methods to capture signing input/output.
 *
 * Pure native hooks — no Java bridge needed. Works on x86_64.
 */
'use strict';

// Wait for the library to be loaded, then hook
var hooked = false;

function tryHook() {
  if (hooked) return;

  try {
    var mod = Process.getModuleByName('libmetasec_ml.so');
    if (!mod) {
      setTimeout(tryHook, 500);
      return;
    }

    console.log('[HOOK] libmetasec_ml.so loaded at ' + mod.base);
    console.log('[HOOK] Size: ' + mod.size);

    // Hook JNI_OnLoad
    var jniOnLoad = Module.findExportByName('libmetasec_ml.so', 'JNI_OnLoad');
    if (jniOnLoad) {
      console.log('[HOOK] JNI_OnLoad at ' + jniOnLoad);

      Interceptor.attach(jniOnLoad, {
        onEnter: function(args) {
          console.log('[JNI_OnLoad] Called with JavaVM=' + args[0] + ' reserved=' + args[1]);
          // args[0] is JavaVM*
          this.javaVm = args[0];
        },
        onLeave: function(retval) {
          console.log('[JNI_OnLoad] Returned JNI_VERSION=' + retval);
        }
      });
    }

    // Hook RegisterNatives (called by JNI_OnLoad to register methods)
    // RegisterNatives is accessed through the JNI function table
    // We hook the function pointer indirectly

    // Alternative: hook all functions in the .text section
    // More targeted: look for functions that take jstring args (sign functions)

    // Scan exports for JNI functions
    var exports = mod.enumerateExports();
    console.log('[HOOK] Total exports: ' + exports.length);

    // All useful exports
    exports.forEach(function(exp) {
      if (exp.type === 'function' && exp.name !== '__cxa_finalize' && exp.name !== '__cxa_atexit') {
        // Hook every exported function to trace calls
        try {
          Interceptor.attach(exp.address, {
            onEnter: function(args) {
              console.log('[CALL] ' + exp.name + '(' +
                'arg0=' + args[0] + ' arg1=' + args[1] + ' arg2=' + args[2] + ')');
              // Try to read string arguments
              try {
                if (args[0] && !args[0].isNull()) {
                  var str = Memory.readCString(args[0]);
                  if (str && str.length > 0 && str.length < 500) {
                    console.log('  arg0 string: ' + str);
                  }
                }
              } catch(e) {}
            }
          });
        } catch(e) {}
      }
    });

    hooked = true;
    console.log('[HOOK] All hooks installed on libmetasec_ml.so');

  } catch(e) {
    console.log('[HOOK] Error: ' + e);
    setTimeout(tryHook, 1000);
  }
}

// Poll for library load
console.log('[HOOK] Waiting for libmetasec_ml.so to load...');
setInterval(tryHook, 1000);
