# 抖音商城安卓纯逆向可行性方案

> 2026-07-19 基于项目完整资产盘点

## 一、现状：我们有什么

### 1.1 已有的逆向资产

| 层次 | 资产 | 状态 |
|------|------|------|
| **静态分析** | `libmetasec_ml.so` 完整 ELF 结构分析 | ✅ 已完成 |
| **静态分析** | `NetworkParams.java` / `f3.java` 等 Java 层完整反编译 | ✅ 已完成 |
| **静态分析** | 签名调用链完整追踪 (Retrofit → Cronet → metasec) | ✅ 已完成 |
| **动态分析** | Frida hook: OkHttp/Retrofit/Gson/WebView/Clipboard | ✅ 完整 |
| **动态分析** | Frida RPC: `NetworkParams.LJIILLIIL(url, headers)` → 签名 headers | ✅ 可用 |
| **动态分析** | SSL pinning bypass | ✅ 可用 |
| **签名算法** | bdms JS bundle → `a_bogus` (44字符) | ✅ 纯 Node.js |
| **API 映射** | H5 pack 商品详情: `POST aweme/v2/shop/promotion/pack/h5/` | ✅ 已调通 |
| **API 映射** | 店铺商品列表: `POST aweme/v1/store/product/bff/` | ✅ 已调通 (需 Frida) |
| **API 映射** | 短链生成: `POST /shorten/` | ⚠️ 模板依赖 |
| **网络抓包** | Playwright 浏览器端 capture-sign-tuple | ✅ 可用 |

### 1.2 当前架构（混合模式）

```
┌─────────────────────────────────────────────────────┐
│ UI 自动化 (Playwright Android Driver)                │
│ tap 搜索 → tap 商品 → tap 分享 → 读剪贴板             │
├─────────────────────────────────────────────────────┤
│ Frida Hook (capture-semi.js)                        │
│ 拦截 OkHttp/Retrofit/Gson/WebView/Clipboard         │
├─────────────────────────────────────────────────────┤
│ 数据富化 (多路)                                      │
│   → haohuo URL goods_detail 直接解析 (零网络)        │
│   → Frida response body 解析                        │
│   → 浏览器 resolve v.douyin.com                     │
│   → H5 pack API (a_bogus 签名)                      │
├─────────────────────────────────────────────────────┤
│ 签名层                                               │
│   → bdms 浏览器 VM (a_bogus)                        │
│   → Frida RPC NetworkParams (X-Gorgon/X-Argus 等)   │
└─────────────────────────────────────────────────────┘
```

---

## 二、纯逆向目标架构

```
┌─────────────────────────────────────────────────────┐
│ API 调用层 (纯 HTTP)                                 │
│   → 搜索商品 → 获取列表 → 获取详情 → 生成短链         │
├─────────────────────────────────────────────────────┤
│ 签名层 (纯代码，无浏览器/无 Frida/无 Android)          │
│   → a_bogus (已有)                                  │
│   → X-Gorgon / X-Argus / X-Khronos (缺失)           │
│   → verifyFp (缺失)                                 │
├─────────────────────────────────────────────────────┤
│ 会话管理 (纯代码)                                     │
│   → cookie/token 获取与刷新 (需逆向)                  │
│   → 设备指纹模拟 (需逆向)                             │
└─────────────────────────────────────────────────────┘
```

---

## 三、差距分析：还差什么

### 🔴 Blocker 1: X-Gorgon / X-Argus / X-Khronos 纯实现

**当前状态：**
- `a_bogus`：✅ 已通过 bdms JS bundle 纯代码实现
- `X-Gorgon` / `X-Argus` / `X-Khronos`：❌ 只能在 app 内通过 Frida RPC 调用 `NetworkParams.LJIILLIIL()` 获取

**技术背景：**
- 这三个 header 由 `libmetasec_ml.so` 中的 `getEncodedP` 函数生成
- `getEncodedP` 位于 `.rodata` 偏移 `0xc35d4`，函数体在 3.3MB 混淆的 `.text` 段中
- 所有加密原语（MD5/HMAC/AES/RSA）均为 SO 内部实现，无外部库依赖
- 调用链：`Retrofit → SsHttpCall → ICronetClient.openConnection → libsscronet.so → dlopen("libmetasec_ml.so") → getEncodedP(query, body)`

**为什么需要这三个 header：**
- 部分 API（店铺商品列表 `/aweme/v1/store/product/bff/`）严格要求 X-Gorgon/X-Argus/X-Khronos
- 没有它们，这些 API 会返回签名验证失败
- 当前 H5 pack API (`aweme/v2/shop/promotion/pack/h5/`) 只需要 `a_bogus`，所以能工作

**解决路径：**

| 路径 | 难度 | 时间 | 可行性 |
|------|------|------|--------|
| A. Ghidra/IDA 反编译 `getEncodedP` → 纯代码实现 | 高 | 2-4 周 | 需要 ARM64 逆向专家 |
| B. 提取 bdms 的完整签名逻辑（不只 a_bogus） | 中 | 1-2 周 | bdms 可能包含更多签名函数 |
| C. Unidbg 模拟执行 libmetasec_ml.so | 中 | 1-2 周 | 已有社区参考案例 |
| D. Frida Gadget 常驻注入 (无 root) | 低 | 1-3 天 | 绕过 ptrace 限制 |

**推荐路径：C 或 D 先行，A 作为终极方案**

- **Unidbg (路径 C)**：Java 实现的 ARM 模拟器，可直接加载 `libmetasec_ml.so` 并调用 `getEncodedP`，无需 Android 设备。已有社区成功案例（Oacia/Kanxue 2026 对同款 SO 的分析）。
- **Frida Gadget (路径 D)**：将 frida-gadget.so 注入 APK，不需要 root 权限。可以跑在普通 MuMu 模拟器上，RPC 调用 `NetworkParams.LJIILLIIL`。
- **纯算法提取 (路径 A)**：需要 Ghidra/IDA Pro，先 dump getEncodedP 的输入输出对（通过 Frida），再用已知明文-密文对辅助反编译。

### 🔴 Blocker 2: verifyFp 缺失

**当前状态：**
- bdms bundle **不生成** verifyFp
- 当前靠从真实 app 会话中捕获 verifyFp 值（环境变量 `DOUYIN_VERIFY_FP`）
- verifyFp 有时效性，过期需要重新捕获

**解决路径：**
- 继续用 bdms 深入分析 — verifyFp 可能在 bdms 的其他闭包中
- 或者从 app 抓取 verifyFp 生成调用栈，逆向其生成逻辑
- 短期方案：定期从 app 捕获并缓存 verifyFp

### 🟡 Blocker 3: API 端点发现不完整

**已映射：**

| API | 用途 | 签名需求 |
|-----|------|---------|
| `POST /aweme/v2/shop/promotion/pack/h5/` | 商品详情 | a_bogus |
| `POST /aweme/v1/store/product/bff/` | 店铺商品列表 | X-Gorgon/Argus/Khronos |
| `POST /shorten/` | 短链生成 | a_bogus |

**缺失：**

| API | 用途 | 重要性 |
|-----|------|--------|
| 搜索 API | 按关键词搜索商品 | ⭐⭐⭐ 替代搜索 UI |
| 商品推荐/Feed API | 获取首页推荐商品列表 | ⭐⭐ 替代滚动 |
| 店铺列表 API | 按关键词搜索店铺 | ⭐⭐ |
| 店铺内搜索 API | 在店铺内按关键词搜商品 | ⭐⭐ |

**发现方法：**
1. 在 Frida hook 中开启全量 HTTP 日志（已 hook OkHttp/Retrofit/Cronet）
2. 手动操作 app（搜索关键词 → 浏览结果），收集所有请求
3. 用 MITM 代理（mitmproxy + SSL bypass）全量抓包
4. 从抓包结果中识别搜索/推荐相关 API，反编译其响应结构

**已有线索：**
- `hook/capture-semi.js` 已经在 hook OkHttp、Retrofit、Gson 的全部流量
- `hook/native-signer-agent.js` 可以 dump 所有带 `x-*` header 的请求
- `tools/capture-sign-tuple.mjs` 在浏览器端拦截 XHR/fetch

### 🟡 Blocker 4: 会话/Cookie 管理

**当前状态：**
- 依赖 app 内登录态（cookie/session token 由 app 自动管理）
- 在 API 调用中，token 从 capture 模板中提取并复用

**问题：**
- token 有时效性，过期后纯 API 方案就失效
- 不知道 token 如何刷新

**解决路径：**
1. 逆向登录流程 API（手机号/验证码登录或扫码登录）
2. 实现自动化登录 → 获取 token → 刷新 token
3. 或者长期方案：保持一个 headless 设备常驻登录，定期导出 cookie

### 🟢 Blocker 5: Frida 在 MuMu user build 上的限制

**问题：**
- MuMu 运行 Android user build (`ro.debuggable=0`)
- Frida 的 ptrace attach 被内核阻止
- 当前只能 spawn 模式（`frida -f`）或使用 frida-gadget 注入

**解决路径 (四选一)：**

| 方案 | 难度 | 说明 |
|------|------|------|
| **Frida Gadget 注入 APK** | 低 | 解包 APK → 注入 gadget.so → 重打包 → 安装。无需 root。 |
| **使用 userdebug/eng 系统镜像** | 低 | 换一个可调试的模拟器镜像（如 AOSP userdebug） |
| **使用 rooted 模拟器 + frida-server** | 低 | Magisk root + frida-server 常量 |
| **放弃 Frida，纯 MITM 代理** | 中 | 用 mitmproxy + SSL bypass hook 抓取所有 API 流量 |

**推荐：Frida Gadget 注入** — 一次性注入后，所有 API 签名都走 RPC，不需要反复操作。

---

## 四、推荐推进路线

### 第一阶段：消除 UI 自动化（2-4 天）

**目标：搜索+商品发现不再依赖 tap/swipe/dumpUi**

1. **Frida Gadget 注入 APK**
   - 解包 `douyin-mall-39.6.0.apk`
   - 将 `frida-gadget-16.x.x-android-arm64.so` 注入 `lib/arm64-v8a/`
   - 修改 smali 加载 gadget
   - 重打包安装

2. **全量 API 抓包**
   - 运行 gadget 模式 Frida hook（`hook/native-signer-agent.js`）
   - 手动完成：搜索 "小脏鞋" → 浏览结果 → 打开商品 → 查看详情
   - 收集所有 HTTP 请求

3. **API 端点识别**
   - 搜索 API：找返回商品列表的请求
   - 推荐/Feed API：找首页商品推荐的请求
   - 确认每个 API 需要的签名 header

4. **实现 `src/direct-search.mjs`**
   - 调用搜索 API（a_bogus 签名）
   - 解析搜索结果 JSON → 商品列表
   - 调用 H5 pack API 获取详情
   - 生成短链（已有模板）
   - **这一步成功后，整个采集流程零 UI 交互**

### 第二阶段：消除浏览器依赖（1-2 周）

**目标：bdms 签名不再依赖 headless browser**

1. **探索 bdms 直接在 Node.js 运行**
   - 尝试 `vm2` / `isolated-vm` 加载 bdms bundle
   - bdms 是 duktape 修改版，可能依赖浏览器 API（`window`, `navigator` 等）
   - 需要 mock 这些 API

2. **如果 Node.js 不行 → Unidbg**
   - 用 Unidbg 加载 `libmetasec_ml.so`
   - 调用 `getEncodedP` 获取 a_bogus
   - 打包成 HTTP 服务供 Node.js 调用
   - 参考社区已有 Unidbg 加载同款 SO 的案例

3. **备选：Ghidra 纯算法提取**
   - 用 Frida dump `getEncodedP(已知query, 已知body)` 的 100+ 组输入输出对
   - 在 Ghidra 中从 `0xc35d4` 的 XREF 开始反编译
   - 用已知明文-密文对辅助验证反编译结果
   - 纯代码实现（Python/Node.js/Go）

### 第三阶段：完全去 Frida 化（1-2 周）

**目标：不再依赖任何 Android 运行时**

1. **实现 X-Gorgon/X-Argus/X-Khronos 纯签名**
   - 基于第二阶段的 Unidbg 或纯算法成果
   - 或者：确定哪些 API 只需要 a_bogus，绕过需要完整签名的 API

2. **verifyFp 生成**
   - 深入分析 bdms bundle 的完整 API surface
   - 或从 app 逆出 verifyFp 生成逻辑

3. **Session 管理**
   - 实现自动化登录/刷新
   - 或长期维护一个登录态

### 终极状态

```
┌─────────────────────────────────────────┐
│ 纯 Node.js 进程                          │
│                                          │
│  src/direct-search.mjs    ← 搜索 API     │
│  src/direct-api-enrich.mjs ← 详情 API    │
│  src/shorten.mjs          ← 短链 API     │
│  src/a-bogus.mjs          ← 纯 Node 签名 │
│  (new) src/session.mjs    ← 会话管理     │
│  (new) src/native-sign.mjs ← X头签名     │
│                                          │
│  零 Android、零 Frida、零浏览器           │
│  只需 HTTP + 签名算法                     │
└─────────────────────────────────────────┘
```

---

## 五、关键决策点

1. **Frida Gadget vs MITM 代理 → 推荐 Gadget**：功能更强（可调 RPC），API 发现更完整（能拦截所有 Java 层网络调用，包括那些不走系统代理的）

2. **Unidbg vs Ghidra 纯算法 → 推荐 Unidbg 先行**：社区已有案例，投入产出比高。纯算法是终极目标但时间不可控。

3. **bdms 浏览器 vs Node.js → 优先尝试 Node.js 直接加载**：238KB 的 JS，可能有少量浏览器 API 依赖需要 mock

4. **搜索 API vs BFF API → 优先搜索 API**：搜索 API 最可能只需要 a_bogus（跟 pack H5 API 同源），是去 UI 化的最短路径

---

## 六、行动清单

### 立即可做（低成本）

- [x] 搜索 API 识别 + `src/direct-search-client.mjs`（app_proxy 已生产验证）
- [x] 官方短链纯 HTTP（`src/official-shortener.mjs`）
- [x] 会话/设备导出骨架（`tools/export-app-session.mjs`, `src/session.mjs`, `src/device-params.mjs`）
- [x] L2 模式入口（`--sign-mode frida_rpc`）+ 对照工具 `tools/compare-search-modes.mjs`
- [x] wire header 分类文档骨架 `output/direct-search/header-classification.md`
- [x] Node vm 加载 bdms 尝试（`src/a-bogus-vm.mjs`，失败则回退浏览器）
- [ ] Frida Gadget 注入 APK → 解除 ptrace 限制（运维向）
- [ ] 用 compare 工具在真机上钉死 L2 最小 header 集

### 短期（1-2 周）

- [x] direct-search CLI + 翻页 + 短链
- [ ] `frida_rpc` 多页稳定（Cookie + 完整 signOnly 头）
- [x] Unidbg 工程可编译；**SO 已成功 load**（`module_base` 可见，`/health` ok）
- [x] 锁定 `JNI_OnLoad` 导出偏移 `SO+0x28f03c`（**唯一** dynsym 定义符号）；`getEncodedP` 无导出
- [x] 澄清：`getEncodedP` 字符串 XREF 多为 **unwind 误报**，非算法函数体
- [x] Frida `signOnly` 采集 `f3_io` + `metasec_handle`（供离线对照）
- [x] Frida native 追踪骨架：`npm run trace:metasec`（dlsym/dlopen/RegisterNatives/f3.a/ArtMethod 探针）
- [ ] 在真机跑通 `trace:metasec --sign`，拿到 **f3.a native entry 偏移**
- [ ] 绕过/模拟 MetaSec `JNI_OnLoad` 环境校验（当前 `Illegal JNI version: 0xffffffff`）
- [ ] Unidbg 内按 native entry 调用 / 对齐 Frida X 头
- [ ] 确认 verifyFp 生成路径（bdms 深处或 app 逻辑）
- [x] 搜索缺字段 H5 enrich 接入 CLI `--enrich`
- [x] Frida 桥接签名侧车 `npm run sign:local-service`（与 Unidbg 同 HTTP 契约）

### 中期（2-4 周）

- [x] HTTP sidecar 契约（`src/native-sign.mjs` + Frida bridge / Unidbg jar）
- [ ] `--sign-mode local` **纯 Unidbg、无 Frida** 跑通 ≥1 页
- [ ] Session 过期检测与重新导出自动化
- [ ] 完整 API 端点文档化

### 长期

- [ ] Ghidra/IDA 完全还原 `getEncodedP` 算法
- [ ] 默认入口切到 local（仅当 M3 验收通过）
- [ ] 纯代码 X-Gorgon/X-Argus/X-Khronos + verifyFp
- [ ] 零依赖纯 HTTP 采集系统
