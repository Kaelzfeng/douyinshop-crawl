package com.douyin.re.metasec;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * HTTP sidecar compatible with src/native-sign.mjs
 *
 *   GET  /health
 *   POST /sign {url, headers, body}
 *
 * Default: http://127.0.0.1:17890
 */
public final class SignHttpServer {

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("METASEC_SIGNER_PORT", "17890"));
        String soPath = System.getenv().getOrDefault(
                "METASEC_SO",
                new File("../reverse/apk_extracted/lib/arm64-v8a/libmetasec_ml.so").getAbsolutePath()
        );
        // allow CLI override: --so path --port 17890
        for (int i = 0; i < args.length; i++) {
            if ("--port".equals(args[i]) && i + 1 < args.length) {
                port = Integer.parseInt(args[++i]);
            } else if ("--so".equals(args[i]) && i + 1 < args.length) {
                soPath = args[++i];
            }
        }

        File soFile = new File(soPath);
        MetaSecEmulator emulator = MetaSecEmulator.create(soFile);
        System.out.println("[unidbg-metasec] " + JSON.toJSONString(emulator.status()));

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/health", exchange -> {
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                writeJson(exchange, 405, mapOf("ok", false, "error", "method not allowed"));
                return;
            }
            Map<String, Object> st = emulator.status();
            writeJson(exchange, Boolean.TRUE.equals(st.get("ok")) ? 200 : 503, st);
        });
        server.createContext("/sign", exchange -> {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                writeJson(exchange, 405, mapOf("ok", false, "error", "method not allowed"));
                return;
            }
            try {
                String raw = new String(readAll(exchange.getRequestBody()), StandardCharsets.UTF_8);
                JSONObject body = raw == null || raw.isEmpty() ? new JSONObject() : JSON.parseObject(raw);
                String url = body.getString("url");
                @SuppressWarnings("unchecked")
                Map<String, String> headers = body.getObject("headers", Map.class);
                String reqBody = body.getString("body");
                Map<String, Object> result = emulator.sign(url, headers, reqBody);
                int code = Boolean.TRUE.equals(result.get("ok")) ? 200 : 501;
                writeJson(exchange, code, result);
            } catch (Exception e) {
                writeJson(exchange, 500, mapOf("ok", false, "error", e.getMessage()));
            }
        });
        server.createContext("/", exchange -> writeJson(exchange, 200, mapOf(
                "service", "unidbg-metasec",
                "mode", "unidbg",
                "endpoints", new String[]{"GET /health", "POST /sign"}
        )));
        server.start();
        System.out.println("[unidbg-metasec] listening http://127.0.0.1:" + port);
        System.out.println("[unidbg-metasec] SO=" + soFile.getAbsolutePath());

        Runtime.getRuntime().addShutdownHook(new Thread(emulator::close));
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) >= 0) {
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    private static void writeJson(HttpExchange exchange, int code, Object payload) throws IOException {
        byte[] bytes = JSON.toJSONBytes(payload);
        exchange.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static Map<String, Object> mapOf(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }
}
