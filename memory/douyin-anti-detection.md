---
name: douyin-anti-detection-fixes
description: Key fixes for Douyin Mall crawler anti-detection and reliability
metadata:
  type: project
---

## Critical Fixes (2026-07-17)

### 1. Search Input Clearing
- **Problem**: Old search text ("赛霸鱼油omega3") persisted because `input keyevent` clear wasn't reliable
- **Fix**: Tap the X clear button at (0.626*w, 0.045*h) — found via UI dump at x=676 y=50
- **File**: `src/android.mjs` → `clearSearchInput()`

### 2. Search Input Resource ID
- **Finding**: The search input uses `com.ss.android.ugc.livelite:id/or_` (ends with `:id/or_`)
- **Finding**: On search RESULTS page, this input is NOT visible. Must tap search bar text first.
- **File**: `src/android.mjs` → `SEARCH_INPUT_SUFFIX = ':id/or_'`

### 3. Force-Stop Triggers Crash Detection
- **Problem**: Repeated `am force-stop` causes app to show "检测到抖音商城多次闪退" recovery dialog
- **Fix**: Don't force-stop on normal startup. Only use for access-denied recovery.
- **File**: `src/android.mjs` → `bringDouyinMallToFront()`

### 4. Network Error = Rate Limiting
- **Symptom**: App shows "网络错误"/"当前无网络" but device can ping 8.8.8.8
- **Cause**: Douyin server-side rate limiting (IP or account level)
- **Solution**: Switch Douyin account, wait 2-12 hours

### 5. Frida Cannot Attach
- **Finding**: MuMu emulator runs Android `user` build (ro.debuggable=0)
- **Result**: Frida ptrace blocked. Cannot use native-signer-agent for API signing
- **Workaround**: Use `bdms-signer-service.mjs` (browser-based signing) or switch to userdebug emulator

### 6. Human-like Anti-Detection
- **humanTap()**: ±6px jitter, 40-120ms variable press duration
- **humanSwipe()**: variable 300-800ms duration with ±8px jitter
- **microPause()**: 300-900ms + 15% chance of extra 0.8-1.6s
- **readingBehavior()**: micro-scroll + pause before interact
- **typeText()**: always char-by-char (50-150ms per char) — bulk `input text` drops chars on some Android versions

### 7. Browser Stealth
- **WEBGL_SPOOF_SCRIPT**: 8 GPU models (Adreno 750/740/730, Mali G710/G715/G78, PowerVR)
- **UA pool**: 22 devices (2025-2026 flagships)
- **STEALTH_LITE**: Only hides webdriver (full script trips Douyin detection)

### 8. Rate Limit Parameters
- **Gentle** (safe): 8 shares/15min, 15min cooldown, 3 retries
- **Aggressive** (default): 20 shares/10min, 3min cooldown, 6 retries

### 9. Shorten API Endpoint
- **URL**: `https://lf.snssdk.com/shorten/`
- **Captured in**: `output/shorten-request-captured.txt`
- **Signing**: Requires X-Argus/X-Gorgon headers (via bdms browser signer or Frida native signer)
- **Frida signer RPC**: `native-signer-agent.js` → `sign(url, headers)` → returns signed headers

### 10. App Crash Prevention (2026-07-19)

#### Health Monitoring
- **Module**: `src/app-health.mjs` — centralized app health + soft recovery
- **Functions**: `isAppAlive(device)`, `ensureAppAlive(device, screen)`, `softRestart(device, screen)`, `interProductCooldown()`
- All crawl modes now check `pidof` during crawl loops (not just at startup)
- If app process is dead, `softRestart` performs an `am start` (NEVER `am force-stop`)

#### Soft Restart vs Force-Stop
- `softRestart` uses `am start -n <pkg>/MainActivity` which is **idempotent and safe**
- `am force-stop` triggers "检测到抖音商城多次闪退" — **NEVER use in normal operation**
- The only force-stop in crawl code (`crawler.mjs:196`) has been replaced with `softRestart`
- `ensureAppAlive` returns `{ ok, restarted }` — callers re-attach Frida when `restarted=true`

#### Interaction Pacing
- **Inter-product cooldown**: 3-7 seconds randomized between each product card
- **openCandidate wait**: 1.2s (was 800ms) — gives detail page time to stabilize
- **Swipe nudge wait**: 1.2s (was 800ms) — reduces jarring transitions
- **Grid fallback y0**: 0.35 (was 0.30) — avoids banner/live-stream zone
- 15% chance of extra 2-5s pause for human-like variability

#### dumpUi Crash Awareness
- `dumpUi` now checks `pidof` on retry attempts ≥ 3 (every 3rd attempt)
- Returns `{ appDead: true }` when the process is gone — callers can exit early
- Saves ~16 seconds of futile retries per crash event
- Controlled by `abortIfDead` option (default: true)

#### Shop Crawler
- `ensureMallRunning` cold start wait increased from 4.5s → 6s
- Health check added before each product card in processing loop
- Logs `[shop] App process dead — cold starting...` when detected
