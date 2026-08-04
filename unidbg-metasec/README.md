# Unidbg MetaSec signer (Phase C)

Goal: load `libmetasec_ml.so` offline and produce the same security headers as in-app
`NetworkParams.LJIILLIIL(url, headers)` so Node can use `--sign-mode local` without Frida.

## Inputs

| Asset | Path |
|-------|------|
| SO | `../reverse/apk_extracted/lib/arm64-v8a/libmetasec_ml.so` |
| Java entry | `NetworkParams.LJIILLIIL` → `ms.bd.c.f3.a(0x03000001, ...)` |
| Fixtures | `../output/sign-pairs/pairs-*.json` from `tools/dump-sign-pairs.mjs` |

## Target HTTP API (consumed by `src/native-sign.mjs`)

```text
GET  /health → { "ok": true }
POST /sign
  body: { "url": "...", "headers": { ... }, "body": "..." }
  → { "ok": true, "headers": { "X-Gorgon": "...", "X-Argus": "...", ... } }
```

Default bind: `http://127.0.0.1:17890` (`METASEC_SIGNER_URL`).

## Scaffold status

This directory is a **placeholder** for the Java/Unidbg project:

1. Create a Maven/Gradle Unidbg app
2. Map JNI / `f3.a` the same way the app does (see `NATIVE_SIGNER.md`, `NetworkParams.full.java`)
3. Diff outputs against Frida `signOnly` fixtures
4. Only then flip production crawls to `--sign-mode local`

Until the sidecar returns real headers, keep:

```powershell
npm start -- --query <kw> --sign-mode app_proxy --all
```

## Acceptance

- Fixture (url, headers) → Unidbg headers match Frida keys for X-Gorgon/X-Argus/X-Khronos (or enough for search HTTP 200)
- `npm start -- --query test --sign-mode local --single-page` succeeds with Frida stopped
