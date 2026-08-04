package com.douyin.re.metasec;

import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Module;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.DalvikModule;
import com.github.unidbg.linux.android.dvm.VM;
import com.github.unidbg.memory.Memory;

import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Loads libmetasec_ml.so under Unidbg and exposes status / experimental sign hooks.
 *
 * Full NetworkParams.LJIILLIIL parity requires MetaSec runtime init (handle, JNI
 * callbacks, app context). This class focuses on:
 *  1) proving the SO loads
 *  2) resolving interesting symbols
 *  3) providing a stable place to plug f3.a / getEncodedP once reverse is deeper
 *
 * Until offline sign works, use the Node Frida bridge:
 *   npm run sign:local-service
 */
public final class MetaSecEmulator implements AutoCloseable {

    private final AndroidEmulator emulator;
    private final Module module;
    private final File soFile;
    private final String loadError;

    private MetaSecEmulator(AndroidEmulator emulator, Module module, File soFile, String loadError) {
        this.emulator = emulator;
        this.module = module;
        this.soFile = soFile;
        this.loadError = loadError;
    }

    public static MetaSecEmulator create(File soFile) {
        AndroidEmulator emulator = null;
        try {
            emulator = AndroidEmulatorBuilder
                    .for64Bit()
                    .setProcessName("com.ss.android.ugc.livelite")
                    .build();
            Memory memory = emulator.getMemory();
            memory.setLibraryResolver(new AndroidResolver(23));
            VM vm = emulator.createDalvikVM();
            vm.setVerbose(false);

            if (soFile == null || !soFile.isFile()) {
                return new MetaSecEmulator(emulator, null, soFile,
                        "SO not found: " + (soFile == null ? "null" : soFile.getAbsolutePath()));
            }

            try {
                DalvikModule dm = vm.loadLibrary(soFile, false);
                Module mod = dm.getModule();
                return new MetaSecEmulator(emulator, mod, soFile, null);
            } catch (Throwable loadLibErr) {
                return new MetaSecEmulator(emulator, null, soFile,
                        "loadLibrary failed: " + loadLibErr.getClass().getSimpleName()
                                + ": " + loadLibErr.getMessage());
            }
        } catch (Throwable t) {
            if (emulator != null) {
                try { emulator.close(); } catch (Exception ignored) {}
            }
            return new MetaSecEmulator(null, null, soFile, "emulator init failed: " + t.getMessage());
        }
    }

    public boolean isReady() {
        return module != null && loadError == null;
    }

    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", module != null);
        out.put("mode", "unidbg");
        out.put("so", soFile == null ? null : soFile.getAbsolutePath());
        out.put("so_exists", soFile != null && soFile.isFile());
        out.put("module_base", module == null ? null : Long.toHexString(module.base));
        out.put("module_size", module == null ? null : module.size);
        out.put("load_error", loadError);
        out.put("note", "Offline f3.a/getEncodedP not fully wired; use Frida bridge for production sign");
        return out;
    }

    /**
     * Experimental: attempt is not a full sign yet.
     * Returns empty headers with a clear error so Node fails closed.
     */
    public Map<String, Object> sign(String url, Map<String, String> headers, String body) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false);
        out.put("mode", "unidbg");
        out.put("url", url);
        out.put("headers", new LinkedHashMap<String, String>());
        if (module == null) {
            out.put("error", loadError == null ? "module not loaded" : loadError);
            return out;
        }
        // Placeholder for reverse work:
        // 1) capture Frida sign pairs (npm run sign:dump-pairs)
        // 2) map f3.a(0x03000001, 0, handle, url, kvStringArray)
        // 3) or call getEncodedP once symbol/offset is confirmed
        out.put("error", "unidbg sign not implemented yet — SO loaded"
                + (module != null ? " @0x" + Long.toHexString(module.base) : "")
                + "; implement f3.a/getEncodedP using output/sign-pairs fixtures");
        out.put("module_base", Long.toHexString(module.base));
        return out;
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
