# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Reverse-engineering crawler for Douyin Mall (抖音商城) Android app version 39.6.0. Extracts Golden Goose (GGDB / 小脏鞋) product data — title, shop name, price, sales, share links — from the `com.ss.android.ugc.livelite` package running in MuMu emulator. Outputs CSV with BOM + CRLF line endings.

ESM-only (`"type": "module"`), Node ≥20. Requires a running MuMu emulator with Douyin Mall logged in, and optionally Frida for faster non-share-click capture.

## Commands

```bash
# Install
npm install
npx playwright install android

# Probe environment
npm run probe

# Build Frida bundles (after editing hook/*.js source)
npx frida-compile hook/capture-semi.js -o hook/capture-semi.bundle.js -B iife -S

# Build all Frida bundles
for f in hook/capture-semi.js hook/sign-rpc.js hook/native-signer-agent.js; do
  npx frida-compile "$f" -o "${f%.js}.bundle.js" -B iife -S
done

# Build specific bundles via npm
npm run build:webview-agent      # WebView debug hook
npm run build:native-chain       # native call-chain hook
npm run build:native-signer      # native signer agent

# Run tests
npm test                          # all tests (Node + Python signer)
node --test test/*.test.mjs       # Node tests only
npm run test:signer               # Python signer tests only

# Primary crawl (semi mode — recommended, no share button)
node run-semi-xiaozangxie-ggdb.mjs

# CLI crawl modes
npm start -- --semi --all --fresh                         # semi (Frida intercept, fastest)
npm start -- --frida --all                                # Frida + share click
npm start -- --all --fresh                                # traditional share-click
npm start -- --shop-tab --query 小脏鞋                     # search → shop tab → each shop
npm start -- --shop-seeds --seeds output/all-products-final.csv  # enter shops from known product CSV
npm start -- --shop "https://v.douyin.com/xxxxx/"         # crawl entire shop from one link
npm start -- --direct --input links.txt --limit 50        # scrape links from file

# Signing & verification
npm run sign:service             # bdms JSONL signer (stdin/stdout)
npm run sign:native              # native signing via Python
npm run verify:h5                # end-to-end H5 API verification with a_bogus

# Native probing
npm run probe:native             # Python dual-realm Frida probe
npm run capture:native           # full native-chain JSON capture
npm run capture:webview          # WebView debug capture

# Diagnostics
for f in src/*.mjs; do node --check "$f" && echo "OK: $f"; done  # syntax-check all modules
adb -s emulator-5554 shell pidof com.ss.android.ugc.livelite       # check if app is alive
adb -s emulator-5554 exec-out screencap > output/screen.raw         # grab screenshot
node diag-frida-events.mjs                                          # diagnose Frida events
node test-frida-quick.mjs                                           # verify Frida connection
```

## Architecture

### Data-flow pipeline

```
┌─ Entry ─────────────────────────────────────────────────┐
│  run-semi-xiaozangxie-ggdb.mjs / src/cli.mjs (npm start)│
├──────────────────────────────────────────────────────────┤
│  Orchestrator: src/share-url-capture.mjs                 │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  │
│  │ Frida intercept│  │ Clipboard poll │  │ Share-click  │  │
│  │ (15s timeout)  │  │ (10s timeout)  │  │ (12s timeout) │  │
│  └───────┬───────┘  └───────┬───────┘  └──────┬───────┘  │
│          └──────────────────┼─────────────────┘           │
│                             ↓ score & race                │
│              haohuo+goods_detail:10                       │
│              haohuo+product_id:8                          │
│              v.douyin.com:5                               │
│              product_id only:3                            │
├──────────────────────────────────────────────────────────┤
│  Enrichment: src/enrich.mjs + src/direct-api-enrich.mjs   │
│  ① haohuo URL goods_detail direct parse (zero network)    │
│  ② Frida response body parse                             │
│  ③ Browser resolve v.douyin.com                          │
│  ④ H5 pack API (a_bogus signed)                          │
├──────────────────────────────────────────────────────────┤
│  Signing layer                                            │
│  a_bogus: src/a-bogus.mjs (bdms browser VM)              │
│  X-Gorgon/Argus/Khronos: Frida RPC (hook/sign-rpc.js)    │
├──────────────────────────────────────────────────────────┤
│  Output: src/output.mjs                                   │
│  CSV (BOM + CRLF) + checkpoint JSON + summary JSON        │
└──────────────────────────────────────────────────────────┘
```

### Crawl modes (dispatched from `src/cli.mjs`)

| Mode | File | How it gets product data |
|------|------|--------------------------|
| **semi** ⭐ | `src/semi-crawl.mjs` | Frida intercepts network/URL/clipboard; no share button tapped |
| **frida** | `src/frida-crawl.mjs` | Frida hooks + still taps share button for short link |
| **traditional** | `src/crawler.mjs` | Share button → clipboard → browser enrichment; no Frida |
| **shop-tab** | `src/shop-tab-crawl.mjs` | Search → 店铺 tab → enter each shop → filter products |
| **shop** | `src/shop-crawler.mjs` | Enter a shop from a product link, scroll all products |
| **shop-seeds** | `src/shop-from-seeds.mjs` | Enter shops via known product links in a CSV (path B) |
| **direct** | `src/direct-crawl.mjs` | Scrape v.douyin.com links directly in browser, no Android |

All on-device modes share the same Android UI layer (`src/android.mjs`, `src/ui.mjs`), clipboard reading (`src/clipboard.mjs`), app health monitoring (`src/app-health.mjs`), and output/checkpoint persistence (`src/output.mjs`).

### Key modules

| Module | Role |
|--------|------|
| `src/android.mjs` | ADB layer: `dumpUi()`, search, open product, navigate. Re-exports from `app-health.mjs`. |
| `src/app-health.mjs` ⭐ | App health: `isAppAlive()`, `softRestart()`, `ensureAppAlive()`, `interProductCooldown()`. **All crawl modes depend on this.** |
| `src/ui.mjs` | Parse UI hierarchy XML → find product cards, buttons, text |
| `src/share-url-capture.mjs` | Multi-source race orchestrator + `enrichFromAnySource()` |
| `src/enrich.mjs` | Browser enrichment (short link resolution, page extraction) + `enrichFromHaohuoUrl()` |
| `src/direct-api-enrich.mjs` | H5 pack API direct call (pure Node.js, a_bogus signed, no Python) |
| `src/a-bogus.mjs` | bdms browser signer + connection pool |
| `src/shorten.mjs` | Short-link API direct call (a_bogus signed, no share button) |
| `src/clipboard.mjs` | Multi-source clipboard (ADB + Windows + polling) |
| `src/stealth.mjs` | Browser anti-detection (suppress webdriver, remove Playwright traces) |
| `src/fingerprint.mjs` | Android Chrome UA pool, rotated per context |
| `src/rate-limit.mjs` | Rolling-window rate limiter with Gaussian-ish jitter |
| `src/output.mjs` | CSV/checkpoint/summary persistence, dedup by product_id |
| `src/h5-enrich.mjs` | Python subprocess H5 enrichment (legacy) |

### Multi-source capture pipeline (`src/share-url-capture.mjs`)

This is the central orchestrator. `captureProductUrl()` races three sources in parallel:

1. **Frida** (15s) — network interception, WebView URLs, clipboard hooks inside the app
2. **Clipboard polling** (10s) — ADB `cmd clipboard get` + Windows PowerShell clipboard
3. **Share-click** (12s) — traditional: tap share button → wait for clipboard

Results are scored (haohuo+goods_detail=10, haohuo+product_id=8, v.douyin=5, product_id only=3) and the best wins.

`enrichFromAnySource()` then fills product fields from, in order: haohuo URL goods_detail JSON (zero network) → Frida response body data → browser enrichment → H5 pack API (last resort).

### Frida hooks (`hook/`)

| File | Purpose |
|------|---------|
| `capture-semi.js` | Main hook: clipboard, URL loading, OkHttp/Retrofit/Gson traffic, product_id extraction. No share click needed. |
| `capture-semi.bundle.js` | Compiled IIFE bundle loaded at runtime |
| `capture-share-min.js` | Lighter variant for share-click mode |
| `sign-rpc.js` | Exposes `rpc.exports` for in-app signing (X-Neptune headers) |
| `native-signer-agent.js` | Native-layer signing via Frida RPC (X-Gorgon, X-Khronos, X-Argus) |
| Other `*.js`/`*.bundle.js` | Various capture/debug scripts for different attack surfaces |

**Important**: always recompile bundles after editing source: `npx frida-compile hook/capture-semi.js -o hook/capture-semi.bundle.js -B iife -S`

### Enrichment pipeline

1. `enrichFromHaohuoUrl()` — parse `goods_detail` JSON from haohuo URL directly, zero network (`src/enrich.mjs`)
2. Browser enricher (`createSharePageEnricher` in `src/enrich.mjs`) — Playwright stealth browser resolves v.douyin.com short links, extracts product data from the redirected page. Uses fingerprint rotation (`src/fingerprint.mjs`) and anti-detection (`src/stealth.mjs`)
3. H5 pack enrichment — two variants:
   - `src/h5-enrich.mjs` — spawns Python `tools/enrich_csv_h5.py` as subprocess (legacy)
   - `src/direct-api-enrich.mjs` — pure Node.js, calls H5 API directly with a_bogus signing, bypassing Python entirely
4. `src/a-bogus.mjs` — wraps the bdms browser-based signer as a reusable module. Keeps a headless browser alive with the bdms VM loaded, signs query + body pairs on demand. Supports connection pooling via `createABogusSignerPool`
5. `src/shorten.mjs` — generates v.douyin.com short links by calling the shorten API directly with a_bogus signing (no share button needed)

### App health & crash prevention (`src/app-health.mjs`)

All crawl modes import these via `src/android.mjs` re-exports:

- **`isAppAlive(device)`** — fast pidof check (~50ms) before every product interaction
- **`softRestart(device, screen)`** — restart via `am start` WITHOUT `am force-stop`. Dismisses permission dialogs. Idempotent (works whether app is alive or dead).
- **`ensureAppAlive(device, screen)`** — check + auto-recover. Semi/frida modes re-attach Frida after restart.
- **`interProductCooldown()`** — 3-7s random pause between products (15% chance of extra 2-5s). Human-like pacing to avoid anti-bot heuristics.

`dumpUi()` in `android.mjs` is crash-aware: after ≥3 retries it checks pidof and returns `{ appDead: true }` early instead of spinning.

### Output (`src/output.mjs`)

CSV fields: `搜索关键词, 商品id, 商品品名, 店铺名, 价格, 销量, 分享的链接`

Writes three files on each persist: CSV output, checkpoint JSON (for resume), run summary JSON. Deduplication by product_id > share link > title+shop.

## App version compatibility

- Target: Douyin Mall 39.6.0 (`com.ss.android.ugc.livelite`)
- Key API change 39.5→39.6: `haohuo.jinritemai.com` → `ecom.ecombdapi.com` for product detail
- `FastJsonConverter` removed in 39.6.0; use `Gson.fromJson` hook instead
- `okhttp3.RealCall` not accessible via Frida in 39.6 due to Plugin classloader isolation

### API endpoint changes (39.5 → 39.6)

| Function | 39.5.0 | 39.6.0 |
|----------|--------|--------|
| Product detail | `haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/h5/` | `ecom.ecombdapi.com/ecom/product/detail/pack/async` |
| Favorites | — | `ecom.snssdk.com/aweme/v2/commerce/common/bff/favorite/feed` |
| Token heartbeat | — | `aweme.snssdk.com/passport/token/beat/v2/` |

### Known API endpoints

| API | Purpose | Signing required |
|-----|---------|-----------------|
| `POST /aweme/v2/shop/promotion/pack/h5/` | Product detail (H5) | a_bogus |
| `POST /aweme/v1/store/product/bff/` | Store product list | X-Gorgon/Argus/Khronos |
| `POST /shorten/` | Short link generation | a_bogus |

## Reverse engineering roadmap

See `reverse/PURE_REVERSE_PLAN.md` for the full plan. Summary:

### Current state (hybrid)

- a_bogus: ✅ pure Node.js via bdms browser VM
- X-Gorgon/Argus/Khronos: ❌ Frida RPC only (calls `NetworkParams.LJIILLIIL()` in-app)
- verifyFp: ❌ captured from real sessions, not generated
- Search API: ❌ endpoint not yet discovered

### Target state (pure HTTP)

Three phases to eliminate dependencies:

1. **Phase 1 (2-4 days): Eliminate UI automation** — Frida Gadget inject into APK → full traffic capture → discover search API → `src/direct-search.mjs`. If search API only needs a_bogus, achieves zero-UI crawling immediately.

2. **Phase 2 (1-2 weeks): Eliminate browser** — Run bdms in Node.js directly (`vm`/`isolated-vm`) or Unidbg to load `libmetasec_ml.so` and call `getEncodedP` without a browser.

3. **Phase 3 (1-2 weeks): Eliminate Frida entirely** — Pure-code X-Gorgon/Argus/Khronos (Unidbg or Ghidra algorithm extraction) + verifyFp generation + session management.

### Key technical blockers

| Blocker | Severity | Path |
|---------|----------|------|
| X-Gorgon/Argus/Khronos pure implementation | 🔴 | Unidbg `libmetasec_ml.so` → extract `getEncodedP` algorithm |
| verifyFp generation | 🔴 | Deep bdms analysis or app-side reverse |
| Search API endpoint discovery | 🟡 | Frida Gadget → full traffic capture → identify search request |
| Session/cookie management | 🟡 | Reverse login flow or maintain long-lived session |
| Frida ptrace on MuMu user build | 🟢 | Frida Gadget inject into APK (no root needed) |

## Environment & prerequisites

- MuMu emulator on `127.0.0.1:16384` (or `emulator-5554` for ADB)
- Screen: 900×1600 portrait (mandatory — landscape breaks search)
- `adb root` + frida-server running as root at `/data/local/tmp/frida-server`
- ADB forward: `adb -s emulator-5554 forward tcp:27042 tcp:27042`
- Browser: Microsoft Edge for Playwright enrichment
- Python 3 (optional, for `tools/` enrichment and signing scripts)

## Anti-detection

`src/stealth.mjs`: minimal evasions — suppresses `navigator.webdriver`, removes Playwright traces. Deliberately avoids aggressive overrides (plugins, canvas, etc.) because Douyin's risk detection flags those.

`src/fingerprint.mjs`: pool of realistic Android Chrome user agents rotated per browser context.

`src/rate-limit.mjs`: rolling-window rate limiter with Gaussian-ish jitter for human-like timing. Two presets: aggressive (default: 20 shares/10min, 3min cooldown) and gentle (`--gentle`: 8 shares/15min, 15min cooldown).

## Reference docs

| Doc | Content |
|-----|---------|
| `HANDoFF.md` | Quick-start, environment cheatsheet, recent changes, troubleshooting |
| `SIGNING.md` | H5 a_bogus signing guide, JSONL service, verification workflow |
| `NATIVE_CHAIN.md` | Retrofit2/OkHttp/Cronet hook scheme for native `/pack/` endpoint |
| `NATIVE_SIGNER.md` | Native-layer signing details (X-Gorgon/Khronos/Argus) |
| `reverse/PURE_REVERSE_PLAN.md` | Full reverse-engineering roadmap and gap analysis |
| `reverse/A_BOGUS_STATIC_TRACE.md` | Static analysis of `libmetasec_ml.so` |
| `memory/douyin-anti-detection.md` | Anti-detection experience and crash prevention notes |

## Important constraints

1. **NEVER `am force-stop`** — Douyin counts crash events; even `force-stop` triggers "detected multiple crashes." Use `softRestart()` from `src/app-health.mjs` instead. This is the #1 rule.
2. **Portrait mandatory** — `adb shell wm size 900x1600`. Landscape breaks search UI.
3. **Chinese keywords use Unicode escapes** (`小脏鞋`) throughout to avoid encoding corruption.
4. **CSV output always starts with UTF-8 BOM** (`﻿`) and uses CRLF line endings.
5. **Clipboard seeding**: set Windows clipboard before app paste to avoid pasting Claude plan paths.
6. **MuMu clipboard sync is unreliable**; prefer ADB `cmd clipboard get` via `src/clipboard.mjs`.
7. **Frida `capture-semi.bundle.js` must be the compiled bundle**, not the raw source. Rebuild after every edit.
8. **MuMu user build** (`ro.debuggable=0`) blocks Frida ptrace; use `adb root` + attach mode, or Frida Gadget inject.
9. **Interaction pacing**: `openCandidate` waits 1200ms, inter-product cooldown 3-7s random. Don't tighten these — they prevent anti-bot triggers.

## Directory map

```
src/         Core modules (crawl modes, Android UI, enrichment, signing, output)
hook/        Frida JavaScript injection scripts + compiled bundles
tools/       Python utilities (H5 enrichment, data merge, API verification, signer service)
test/        Node test runner tests (*.test.mjs) + Python unit tests
reverse/     Reversing artifacts: APK samples, web_sign bdms bundle, JADX analysis, plans
data/        Checkpoint JSON files for resume
output/      CSV results, run summaries, diagnostic screenshots
memory/      Claude Code persistent memory files
tmp/         Temporary files
```
