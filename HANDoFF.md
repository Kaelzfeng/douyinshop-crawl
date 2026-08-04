# Handoff — 抖音商城 GGDB / 小脏鞋 数据采集

> 最后更新: 2026-07-19

## 一分钟快速开始

```powershell
cd E:\douyin-golden-goose-crawler

# 1. 确保环境
adb -s emulator-5554 forward tcp:27042 tcp:27042   # Frida 端口
adb root                                              # Frida 需要 root
adb shell "pidof com.ss.android.ugc.livelite"         # 确认抖音在运行

# 2. 跑测试确认一切正常
npm test   # 16 tests, 必须全绿

# 3. 开始采集（推荐 semi 模式，不点分享按钮）
node run-semi-xiaozangxie-ggdb.mjs
```

## 环境速查

| 项目 | 值 |
|------|-----|
| 项目路径 | `E:\douyin-golden-goose-crawler` |
| 模拟器 | MuMu, serial `emulator-5554`, `127.0.0.1:16384` |
| 屏幕 | 900×1600 **竖屏**（横屏会破坏搜索） |
| 抖音版本 | **39.6.0** (`com.ss.android.ugc.livelite`) |
| Node | ≥20, ESM (`"type": "module"`) |
| Frida | `frida-server` 在 `/data/local/tmp/frida-server`, root 运行 |
| 浏览器 | MS Edge（Playwright enrichment 用） |
| Python | 3.x（可选，仅 `tools/` 脚本需要） |

## 采集模式总览

| 模式 | 启动命令 | Frida | 分享按钮 | 速度 | 推荐场景 |
|------|---------|-------|---------|------|---------|
| **semi** ⭐ | `node run-semi-xiaozangxie-ggdb.mjs` | ✅ | ❌ 不点 | 快 | 日常全量采集 |
| frida | `npm start -- --frida --all` | ✅ | ✅ 点击 | 中 | 需要短链时 |
| traditional | `npm start -- --all --fresh` | ❌ | ✅ 点击 | 慢 | Frida 不可用时 |
| shop-tab | `npm start -- --shop-tab --query 小脏鞋` | ❌ | ✅ | 慢 | 搜店铺→进店→扫货 |
| shop-seeds | `npm start -- --shop-seeds --seeds output/all-products-final.csv` | ❌ | ✅ | 慢 | 从已知商品进店 |
| shop | `npm start -- --shop "https://v.douyin.com/xxxxx/"` | ❌ | ✅ | 慢 | 单店全量爬取 |
| direct | `npm start -- --direct --input links.txt --limit 50` | ❌ | ❌ | 快 | 浏览器直刷链接 |

## 架构一览

```
┌─ 采集入口 ─────────────────────────────────────────────┐
│  run-semi-xiaozangxie-ggdb.mjs                         │
│  src/cli.mjs  (npm start)                              │
├────────────────────────────────────────────────────────┤
│  编排层: src/share-url-capture.mjs                      │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Frida 拦截   │  │ 剪切板轮询    │  │ 分享按钮点击   │  │
│  │ (15s 超时)   │  │ (10s 超时)    │  │ (12s 超时)    │  │
│  └──────┬──────┘  └──────┬───────┘  └──────┬────────┘  │
│         └────────────────┼─────────────────┘            │
│                          ↓ 评分竞速                      │
│               haohuo+goods_detail:10                    │
│               haohuo+product_id:8                       │
│               v.douyin.com:5                            │
│               product_id only:3                         │
├────────────────────────────────────────────────────────┤
│  富化层: src/enrich.mjs + src/direct-api-enrich.mjs     │
│  ① haohuo URL goods_detail 直接解析（零网络）             │
│  ② Frida response body 解析                             │
│  ③ 浏览器 resolve v.douyin.com                          │
│  ④ H5 pack API (a_bogus 签名)                           │
├────────────────────────────────────────────────────────┤
│  签名层                                                   │
│  a_bogus: src/a-bogus.mjs (bdms 浏览器 VM)              │
│  X-Gorgon/Argus/Khronos: Frida RPC (hook/sign-rpc.js)  │
├────────────────────────────────────────────────────────┤
│  输出: src/output.mjs                                    │
│  CSV (BOM + CRLF) + checkpoint JSON + summary JSON      │
└────────────────────────────────────────────────────────┘
```

## 关键文件地图

```
src/
├── cli.mjs                  CLI 入口 + 参数解析
├── android.mjs              ADB 层：dumpUi、搜索、打开商品、返回结果
│    ├── dumpUi()            核心：UI dump + 自动重试 + crash-aware 早退
│    ├── bringDouyinMallToFront()  启动 APP + 关闭弹窗 + 导航到商城搜索
│    └──  re-export: isAppAlive, ensureAppAlive, softRestart, interProductCooldown
├── app-health.mjs ⭐ 新增   APP 健康监控 + 软重启 + 商品间冷却
├── ui.mjs                   解析 UI hierarchy XML → 查找商品卡片
├── crawler.mjs              传统分享点击采集
├── semi-crawl.mjs           Semi 模式（主力，无分享按钮）
├── frida-crawl.mjs          Frida + 分享按钮
├── shop-crawler.mjs         店铺采集
├── shop-tab-crawl.mjs       店铺 Tab 采集
├── direct-crawl.mjs         浏览器直接刮链接
├── share-url-capture.mjs    多源竞速编排器 + enrichFromAnySource
├── frida-capture.mjs        Frida 连接/事件处理/评分
├── enrich.mjs               浏览器富化（短链解析、页面提取）
├── direct-api-enrich.mjs    H5 pack API 直调（纯 Node、无需 Python）
├── h5-enrich.mjs            Python 子进程版 H5 富化（旧）
├── a-bogus.mjs              bdms 浏览器签名器 + 连接池
├── shorten.mjs              短链 API 直调（模板模式）
├── clipboard.mjs            剪切板多源读取（ADB + Windows + 轮询）
├── stealth.mjs              浏览器反检测
├── fingerprint.mjs          UA 指纹池
├── rate-limit.mjs           速率限制 + 人形抖动
├── output.mjs               CSV/checkpoint/summary 输出
└── frida-sign-rpc.mjs       Frida RPC 客户端（X-Neptune 签名）

hook/
├── capture-semi.js          主力 Hook 源码（clipboard/URL/OkHttp/Retrofit/Gson/WebView）
├── capture-semi.bundle.js   编译后的 IIFE bundle ← 运行时加载的是这个
├── sign-rpc.js              Frida RPC: sign(url, headers) + 模板捕获
├── native-signer-agent.js   深度 Hook: NetworkParams/f3.a/Cronet/OkHttp headers
└── *.bundle.js              其他编译 bundle

reverse/
├── A_BOGUS_STATIC_TRACE.md  libmetasec_ml.so 静态分析报告
├── PURE_REVERSE_PLAN.md ⭐  纯逆向路线图（新增）
├── web_sign/
│   └── bdms-1.0.0.38.js     bdms 签名 JS bundle (238 KB)
├── NetworkParams.full.java  MetaSec Java 层完整反编译
├── f3-callers.json          f3.a 调用者十字引用数据
└── samples/                 APK 样本 (39.5.0 / 39.6.0)

tools/
├── capture-sign-tuple.mjs   Playwright 抓取 API 签名模板
├── verify_h5_api.py         H5 pack API 端到端验证
├── bdms-signer-service.mjs  bdms 签名服务（JSONL stdin/stdout）
├── crawl_store_products_http.py   店铺商品 HTTP 爬虫（需 Frida 签名）
└── sign.py / native_sign.py       Python 签名客户端

memory/
└── douyin-anti-detection.md  反检测经验 + 闪退预防记录
```

## 39.6.0 适配状态

### ✅ 已适配
- Clipboard / Uri.parse / URL / Retrofit / OkHttp — 类名未变
- Retrofit POST body 解析（`promotion_ids` 在 body 中）
- `Gson.fromJson` hook（替代已删除的 `FastJsonConverter`）
- WebView URL 拦截
- Intent extras 提取
- 多参数识别（`iid`, `promotion_id`, `product_id`, `promotion_ids`）

### ❌ 不可用
- `okhttp3.RealCall` — Plugin classloader 隔离，Frida 无法 hook
- `FastJsonConverter` — 39.6.0 已从 APK 删除

### 🔄 API 端点变化
| 功能 | 39.5.0 | 39.6.0 |
|------|--------|--------|
| 商品详情 | `haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/h5/` | `ecom.ecombdapi.com/ecom/product/detail/pack/async` |
| 收藏 | — | `ecom.snssdk.com/aweme/v2/commerce/common/bff/favorite/feed` |
| Token 心跳 | — | `aweme.snssdk.com/passport/token/beat/v2/` |

## 近期改动 (2026-07-19)

### 1. APP 闪退预防 ⭐ 今天
- **新增 `src/app-health.mjs`**：`isAppAlive()` / `softRestart()` / `ensureAppAlive()` / `interProductCooldown()`
- **`crawler.mjs` line 196**：`am force-stop` → `softRestart()`（避免触发抖音「检测到多次闪退」）
- **所有 crawl 模式**：每个商品交互前检查 pidof，app 死了自动软重启
- **semi/frida 模式**：app 重启后自动重新 attach Frida
- **`dumpUi` crash-aware**：重试 ≥3 次时检查 pidof，app 已死则早退返回 `{ appDead: true }`
- **交互节奏放慢**：openCandidate 等待 800→1200ms，商品间冷却 3-7s 随机
- **Grid 盲点下移**：y0 0.30→0.35（避开 banner/直播区）

### 2. 纯逆向路线图 ⭐ 今天
- **新增 `reverse/PURE_REVERSE_PLAN.md`**：完整的去 UI/去 Android 路线图
- **核心结论**：搜索 API 如果只需要 a_bogus，立刻就能做到零 UI 采集
- **推荐第一步**：Frida Gadget 注入 APK → 全量抓包 → 发现搜索 API

## 重要约束

1. **绝不 force-stop** — `am force-stop` 会触发「检测到抖音商城多次闪退」，用 `softRestart()` 替代
2. **竖屏必须** — `adb shell wm size 900x1600`，横屏会破坏搜索 UI
3. **Frida bundle 要编译** — 改 `hook/*.js` 源码后必须 `npx frida-compile ... -B iife -S`
4. **中文用 Unicode escape** — 代码中 `小脏鞋` 写作 `小脏鞋`
5. **CSV 输出格式** — UTF-8 BOM (`﻿`) + CRLF 换行
6. **剪贴板不可靠** — MuMu 剪贴板同步经常失败，优先 `cmd clipboard get`
7. **Flash-crash 检测** — 抖音会统计闪退次数，所以连 `force-stop` 都别用
8. **MuMu user build** — `ro.debuggable=0`，Frida ptrace 被阻止，需 root 或 gadget 注入

## 常见问题

| 问题 | 处理 |
|------|------|
| 搜索框找不到 | 确认 APP 在商城搜索页，手动点一下搜索栏 |
| Frida 连不上 | `adb -s emulator-5554 forward tcp:27042 tcp:27042` |
| Frida spawned 模式报错 | MuMu user build 阻止 ptrace，用 `adb root` + attach 模式 |
| 全是 `[skip]` | 检查 `hook/capture-semi.bundle.js` 是否重新编译过了 |
| CSV 不增长 | 看 `output/diagnostics-semi/` 截图，确认 APP 状态 |
| ADB 断开 | `adb kill-server; adb start-server; adb connect 127.0.0.1:16384` |
| APP 频繁闪退 | cool down 15 分钟后再试，检查是否有人在 force-stop |
| `[health] App process dead` | 正常 — 系统会自动软重启。如果反复出现，检查模拟器内存 |
| `access-denied` | 账号被限流，换号或等 2-12 小时 |

## 诊断工具

```bash
# 跑测试（必须先绿）
npm test

# 语法检查所有模块
for f in src/*.mjs; do node --check "$f" && echo "OK: $f"; done

# 诊断 Frida 事件（打开一个商品看原始事件）
node diag-frida-events.mjs

# 验证 Frida 连接
node test-frida-quick.mjs

# 看当前 APP 截图
adb -s emulator-5554 exec-out screencap > output/screen.raw

# 看 APP 是否活着
adb -s emulator-5554 shell pidof com.ss.android.ugc.livelite

# 重编译 Frida bundle
npx frida-compile hook/capture-semi.js -o hook/capture-semi.bundle.js -B iife -S

# 重编译所有 Frida bundle
for f in hook/capture-semi.js hook/sign-rpc.js hook/native-signer-agent.js; do
  npx frida-compile "$f" -o "${f%.js}.bundle.js" -B iife -S
done
```

## 逆向进度追踪

### 已完成 ✅
- [x] bdms JS bundle → a_bogus 纯代码签名（`src/a-bogus.mjs`）
- [x] H5 pack API 调通（`POST aweme/v2/shop/promotion/pack/h5/`）
- [x] 短链 API 调通（模板模式，`src/shorten.mjs`）
- [x] `libmetasec_ml.so` 完整静态分析（`reverse/A_BOGUS_STATIC_TRACE.md`）
- [x] Java 层完整反编译（`NetworkParams` / `f3.a` / Cronet 适配器）
- [x] Frida RPC 签名（`NetworkParams.LJIILLIIL()` → X-Gorgon/Argus/Khronos）
- [x] SSL pinning bypass（`hook/ssl-bypass.js`）
- [x] 全量 HTTP 流量 Hook（OkHttp/Retrofit/Cronet/Gson）
- [x] 店铺商品列表 BFF API 调通（需 Frida 签名）

### 进行中 🔄
- [ ] 搜索 API 发现（等 Frida Gadget 注入后全量抓包）
- [ ] Unidbg 加载 `libmetasec_ml.so`（消除 Frida 依赖）

### 待做 📋
- [ ] Frida Gadget 注入 APK（解除 ptrace 限制）
- [ ] bdms 在 Node.js 直接运行（消除浏览器依赖）
- [ ] verifyFp 生成逻辑逆向
- [ ] X-Gorgon/Argus/Khronos 纯代码实现（Unidbg 或 Ghidra 算法提取）
- [ ] 会话/Token 自动化管理
- [ ] 搜索 API → `src/direct-search.mjs`（零 UI 采集的最后一块拼图）

详见 `reverse/PURE_REVERSE_PLAN.md`
