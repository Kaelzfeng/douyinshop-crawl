"""
Hook libmetasec_ml.so at native level — intercept signing calls.
Does NOT need Java bridge. Works on x86_64 Frida.
"""
import frida
import sys
import time

SCRIPT = r"""
'use strict';

// Approach: hook RegisterNatives to see what Java methods are registered
// Then hook those methods' native implementations

var hookedFunctions = {};

function findGlobalExport(name) {
    if (typeof Module.findGlobalExportByName === 'function') {
        return Module.findGlobalExportByName(name);
    }
    return Module.findExportByName(null, name);
}

function findRegisterNatives() {
    var direct = findGlobalExport('RegisterNatives');
    if (direct) {
        return direct;
    }

    try {
        var symbols = Process.getModuleByName('libart.so').enumerateSymbols();
        for (var i = 0; i < symbols.length; i++) {
            var symbol = symbols[i];
            if (symbol.name.indexOf('RegisterNatives') !== -1 &&
                symbol.name.indexOf('CheckJNI') === -1) {
                return symbol.address;
            }
        }
    } catch (e) {
        console.log('[HOOK] Unable to inspect libart.so: ' + e);
    }
    return null;
}

// Intercept the ART runtime's RegisterNatives function
var RegisterNatives = findRegisterNatives();
if (RegisterNatives) {
    console.log('[HOOK] RegisterNatives at ' + RegisterNatives);

    Interceptor.attach(RegisterNatives, {
        onEnter: function(args) {
            // args[0] = JNIEnv*, args[1] = jclass, args[2] = methods array, args[3] = count
            var count = args[3].toInt32();
            var methods = args[2];
            console.log('[RegisterNatives] Registering ' + count + ' methods');

            // Walk the JNINativeMethod array
            for (var i = 0; i < count && i < 50; i++) {
                var entry = methods.add(i * Process.pointerSize * 3);
                var namePtr = entry.readPointer();
                var sigPtr = entry.add(Process.pointerSize).readPointer();
                var fnPtr = entry.add(Process.pointerSize * 2).readPointer();

                if (namePtr && !namePtr.isNull()) {
                    var name = namePtr.readCString();
                    var sig = !sigPtr.isNull() ? sigPtr.readCString() : '(null)';
                    var owner = Process.findModuleByAddress(fnPtr);
                    var ownerName = owner ? owner.name : '(unknown)';
                    console.log('  [' + i + '] ' + name + ' :: ' + sig + ' -> ' + ownerName + '!' + fnPtr);

                    // Hook methods with signing-related names and every JNI method
                    // implemented by libmetasec_ml.so, whose Java names may be obfuscated.
                    var looksLikeSigning = name && (
                        name.indexOf('sign') !== -1 || name.indexOf('Sign') !== -1 ||
                        name.indexOf('bogus') !== -1 || name.indexOf('Bogus') !== -1 ||
                        name.indexOf('encrypt') !== -1 || name.indexOf('Encrypt') !== -1 ||
                        name.indexOf('sec') !== -1 || name.indexOf('Sec') !== -1 ||
                        name.indexOf('metasec') !== -1 || name.indexOf('MetaSec') !== -1
                    );
                    var belongsToMetasec = ownerName.indexOf('libmetasec_ml.so') !== -1;
                    var hookKey = fnPtr.toString();
                    if ((looksLikeSigning || belongsToMetasec) && !hookedFunctions[hookKey]) {
                        hookedFunctions[hookKey] = true;
                        console.log('  *** HOOKING SIGNING FUNCTION: ' + name + ' at ' + fnPtr);
                        hookSignFunction(fnPtr, name);
                    }
                }
            }
        }
    });

    function hookSignFunction(addr, name) {
        Interceptor.attach(addr, {
            onEnter: function(args) {
                console.log('\n[SIGN CALL] ' + name);
                console.log('  args: ' + args[0] + ' ' + args[1] + ' ' + args[2] + ' ' + args[3]);
                // Try to read string args
                for (var i = 0; i < 4; i++) {
                    try {
                        if (args[i] && !args[i].isNull()) {
                            var str = args[i].readCString();
                            if (str && str.length > 0 && str.length < 2000) {
                                console.log('  arg[' + i + ']: ' + str);
                            }
                        }
                    } catch(e) {}
                }
                this.startTime = Date.now();
            },
            onLeave: function(retval) {
                var elapsed = Date.now() - this.startTime;
                console.log('  elapsed: ' + elapsed + 'ms');
                try {
                    if (retval && !retval.isNull()) {
                        var result = retval.readCString();
                        if (result && result.length > 0) {
                            console.log('  RESULT: ' + result.slice(0, 500));
                        }
                    }
                } catch(e) {}
            }
        });
    }
} else {
    console.log('[HOOK] RegisterNatives not found');
}

// Also: hook System.loadLibrary to see when metasec_ml loads
var android_dlopen_ext = findGlobalExport('android_dlopen_ext');
if (android_dlopen_ext) {
    Interceptor.attach(android_dlopen_ext, {
        onEnter: function(args) {
            var path = !args[0].isNull() ? args[0].readCString() : null;
            if (path && path.indexOf('metasec') !== -1) {
                console.log('[DLOPEN] Loading: ' + path);
            }
        }
    });
}

console.log('[HOOK] Native hooks ready. Trigger a signed API call.\n');
"""

# Connect through Frida's ADB device instead of relying on a manual tcp:27042 forward.
app_id = 'com.ss.android.ugc.livelite'
spawn_mode = '--spawn' in sys.argv
device = frida.get_device('127.0.0.1:16384', timeout=10)

if spawn_mode:
    pid = device.spawn(app_id)
    print(f'Spawned {app_id} in suspended state (PID: {pid})...')
else:
    applications = device.enumerate_applications()
    target = next(
        (app for app in applications if app.identifier == app_id and app.pid),
        None,
    )
    if target is None:
        print('Douyin not running. Start it first, or use --spawn.')
        sys.exit(1)
    pid = target.pid
    print(f'Attaching to {target.name} (PID: {pid})...')

session = device.attach(pid)
script = session.create_script(SCRIPT)
script.on('message', lambda msg, data: print(msg['payload'] if msg['type'] == 'send' else str(msg)))
script.load()

if spawn_mode:
    device.resume(pid)
    print(f'Resumed {app_id} (PID: {pid}).')

print('Hooks injected. Go trigger API calls in the app. Ctrl+C to stop.')
print()
try:
    sys.stdin.read()
except KeyboardInterrupt:
    print('\nDone.')
