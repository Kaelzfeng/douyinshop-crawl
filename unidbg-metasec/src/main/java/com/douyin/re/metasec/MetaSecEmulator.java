package com.douyin.re.metasec;

import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Module;
import com.github.unidbg.Symbol;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.DalvikModule;
import com.github.unidbg.linux.android.dvm.DvmClass;
import com.github.unidbg.linux.android.dvm.StringObject;
import com.github.unidbg.linux.android.dvm.VM;
import com.github.unidbg.linux.android.dvm.array.ArrayObject;
import com.github.unidbg.memory.Memory;
import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Loads libmetasec_ml.so (optionally with APK context) under Unidbg.
 *
 * Progress ladder:
 *  1) SO load + symbol probe  ← implemented
 *  2) JNI_OnLoad              ← attempted
 *  3) f3.a(0x03000001, ...)   ← experimental when class resolves
 *  4) Match Frida signOnly fixtures from output/sign-pairs
 *
 * Production signing today: npm run sign:local-service (Frida bridge).
 */
public final class MetaSecEmulator implements AutoCloseable {

    public static final int OP_HTTP_SIGN = 0x03000001; // 50331649

    private final AndroidEmulator emulator;
    private final VM vm;
    private final Module module;
    private final DalvikModule dalvikModule;
    private final File soFile;
    private final File apkFile;
    private final String loadError;
    private final List<String> logs = new ArrayList<>();
    private Long jniOnLoadResult;
    private String jniOnLoadError;

    private MetaSecEmulator(
            AndroidEmulator emulator,
            VM vm,
            Module module,
            DalvikModule dalvikModule,
            File soFile,
            File apkFile,
            String loadError
    ) {
        this.emulator = emulator;
        this.vm = vm;
        this.module = module;
        this.dalvikModule = dalvikModule;
        this.soFile = soFile;
        this.apkFile = apkFile;
        this.loadError = loadError;
    }

    public static MetaSecEmulator create(File soFile, File apkFile) {
        AndroidEmulator emulator = null;
        try {
            emulator = AndroidEmulatorBuilder
                    .for64Bit()
                    .setProcessName("com.ss.android.ugc.livelite")
                    .build();
            Memory memory = emulator.getMemory();
            memory.setLibraryResolver(new AndroidResolver(23));

            VM vm;
            if (apkFile != null && apkFile.isFile()) {
                vm = emulator.createDalvikVM(apkFile);
                logStatic("using APK context: " + apkFile.getAbsolutePath());
            } else {
                vm = emulator.createDalvikVM();
                logStatic("no APK — empty DalvikVM");
            }
            vm.setVerbose(false);

            if (soFile == null || !soFile.isFile()) {
                return new MetaSecEmulator(emulator, vm, null, null, soFile, apkFile,
                        "SO not found: " + (soFile == null ? "null" : soFile.getAbsolutePath()));
            }

            try {
                // callInit=false first for stability; we invoke JNI_OnLoad explicitly below
                DalvikModule dm = vm.loadLibrary(soFile, false);
                Module mod = dm.getModule();
                MetaSecEmulator emu = new MetaSecEmulator(emulator, vm, mod, dm, soFile, apkFile, null);
                emu.tryJniOnLoad();
                return emu;
            } catch (Throwable loadLibErr) {
                return new MetaSecEmulator(emulator, vm, null, null, soFile, apkFile,
                        "loadLibrary failed: " + loadLibErr.getClass().getSimpleName()
                                + ": " + loadLibErr.getMessage());
            }
        } catch (Throwable t) {
            if (emulator != null) {
                try { emulator.close(); } catch (Exception ignored) {}
            }
            return new MetaSecEmulator(null, null, null, null, soFile, apkFile,
                    "emulator init failed: " + t.getMessage());
        }
    }

    private static void logStatic(String msg) {
        System.out.println("[unidbg-metasec] " + msg);
    }

    private void log(String msg) {
        logs.add(msg);
        System.out.println("[unidbg-metasec] " + msg);
    }

    private void tryJniOnLoad() {
        if (dalvikModule == null || emulator == null) return;
        try {
            dalvikModule.callJNI_OnLoad(emulator);
            jniOnLoadResult = 0L;
            log("JNI_OnLoad completed via DalvikModule.callJNI_OnLoad");
        } catch (Throwable t) {
            jniOnLoadError = t.getClass().getSimpleName() + ": " + t.getMessage();
            log("JNI_OnLoad failed: " + jniOnLoadError);
            // fallback: call exported JNI_OnLoad symbol if present
            try {
                if (module != null) {
                    Symbol sym = module.findSymbolByName("JNI_OnLoad", false);
                    if (sym != null) {
                        // JNI_OnLoad(JavaVM*, void*) — Unidbg typically needs proper args via callJNI_OnLoad
                        log("JNI_OnLoad symbol @0x" + Long.toHexString(sym.getAddress()));
                    } else {
                        log("JNI_OnLoad symbol not found in export table (may be stripped/hidden)");
                    }
                }
            } catch (Throwable t2) {
                log("JNI_OnLoad symbol probe failed: " + t2.getMessage());
            }
        }
    }

    public Map<String, Object> symbols() {
        Map<String, Object> out = new LinkedHashMap<>();
        List<Map<String, Object>> found = new ArrayList<>();
        String[] names = {
                "JNI_OnLoad", "JNI_OnUnload", "getEncodedP", "getEncoded",
                "Java_ms_bd_c_f3_a", "ms_bd_c_f3_a"
        };
        if (module != null) {
            for (String name : names) {
                try {
                    Symbol sym = module.findSymbolByName(name, false);
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("name", name);
                    row.put("found", sym != null);
                    if (sym != null) {
                        row.put("address", Long.toHexString(sym.getAddress()));
                    }
                    found.add(row);
                } catch (Throwable t) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("name", name);
                    row.put("found", false);
                    row.put("error", t.getMessage());
                    found.add(row);
                }
            }
            out.put("module_base", Long.toHexString(module.base));
            out.put("module_size", module.size);
        }
        // known string offset from static analysis
        out.put("rodata_getEncodedP_string_offset", "0xc35d4");
        out.put("symbols", found);
        return out;
    }

    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", module != null);
        out.put("mode", "unidbg");
        out.put("so", soFile == null ? null : soFile.getAbsolutePath());
        out.put("so_exists", soFile != null && soFile.isFile());
        out.put("apk", apkFile == null ? null : apkFile.getAbsolutePath());
        out.put("apk_exists", apkFile != null && apkFile.isFile());
        out.put("module_base", module == null ? null : Long.toHexString(module.base));
        out.put("module_size", module == null ? null : module.size);
        out.put("load_error", loadError);
        out.put("jni_on_load_result", jniOnLoadResult);
        out.put("jni_on_load_error", jniOnLoadError);
        out.put("op_http_sign", OP_HTTP_SIGN);
        out.put("op_http_sign_dec", 50331649);
        out.put("note", "Sign path experimental; Frida bridge remains production default");
        out.put("logs", logs);
        return out;
    }

    /**
     * Experimental sign using Java native ms.bd.c.f3.a if resolvable.
     * Requires APK classes + successful MetaSec init (usually still fails offline).
     */
    public Map<String, Object> sign(String url, Map<String, String> headers, String body) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("mode", "unidbg");
        out.put("url", url);
        out.put("headers", new LinkedHashMap<String, String>());

        if (module == null) {
            out.put("ok", false);
            out.put("error", loadError == null ? "module not loaded" : loadError);
            return out;
        }

        // Build alternating key/value list like NetworkParams.LJIILLIIL
        List<String> pairs = new ArrayList<>();
        if (headers != null) {
            for (Map.Entry<String, String> e : headers.entrySet()) {
                if (e.getKey() != null && e.getValue() != null) {
                    pairs.add(e.getKey());
                    pairs.add(e.getValue());
                }
            }
        }

        // Attempt 1: resolve DvmClass ms.bd.c.f3 and call native a()
        try {
            DvmClass f3 = vm.resolveClass("ms/bd/c/f3");
            // native Object a(int,int,long,String,Object)
            // Without a real MetaSec handle, pass 0 — expect failure/null
            long handle = 0L;
            StringObject urlObj = url == null ? null : new StringObject(vm, url);
            ArrayObject arr = null;
            if (!pairs.isEmpty()) {
                StringObject[] objs = new StringObject[pairs.size()];
                for (int i = 0; i < pairs.size(); i++) {
                    objs[i] = new StringObject(vm, pairs.get(i));
                }
                arr = new ArrayObject(objs);
            }

            Object result = f3.callStaticJniMethodObject(
                    emulator,
                    "a(IIJLjava/lang/String;Ljava/lang/Object;)Ljava/lang/Object;",
                    OP_HTTP_SIGN,
                    0,
                    handle,
                    urlObj,
                    arr
            );

            Map<String, String> signed = new LinkedHashMap<>();
            if (result instanceof ArrayObject) {
                ArrayObject ao = (ArrayObject) result;
                // ArrayObject value access varies by unidbg version — best effort
                out.put("raw_result_type", "ArrayObject");
            } else if (result != null) {
                out.put("raw_result_type", result.getClass().getName());
                out.put("raw_result", String.valueOf(result));
            }

            if (!signed.isEmpty()) {
                out.put("ok", true);
                out.put("headers", signed);
                return out;
            }

            out.put("ok", false);
            out.put("error", "f3.a returned no header map (handle=0 offline init incomplete). "
                    + "Capture Frida handle+I/O via npm run sign:dump-pairs and implement getEncodedP path.");
            out.put("input_pair_count", pairs.size());
            out.put("f3_resolved", true);
            out.put("symbols", symbols());
            return out;
        } catch (Throwable t) {
            out.put("ok", false);
            out.put("f3_resolved", false);
            out.put("error", "f3.a call failed: " + t.getClass().getSimpleName() + ": " + t.getMessage());
            out.put("input_pair_count", pairs.size());
            out.put("symbols", symbols());
            out.put("hint", "Need APK on classpath + MetaSec provider init, or pure getEncodedP after reverse");
            return out;
        }
    }

    @Override
    public void close() {
        if (emulator != null) {
            try {
                emulator.close();
            } catch (Exception ignored) {
            }
        }
    }
}
