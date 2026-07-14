# Native Chain — 原生 `/pack/` 端点逆向与 Hook

## 背景

抖音商城 (com.ss.android.ugc.livelite 39.5.0) 的原生 `ProductDetailActivity` 使用不同于 H5 的 API 链：

```text
H5  (网页分享页):  POST https://haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/h5/
原生 (App 详情页):  POST https://aweme.snssdk.com/aweme/v2/shop/promotion/pack/
```

H5 链已通过无头浏览器执行 bdms VM 实现签名（见 SIGNING.md）。原生链需要完全不同的方案。

## 原生网络架构

### 调用链

```
ProductDetailActivity
  → Retrofit2 Service Interface
    → com.bytedance.retrofit2.client.Request.Builder.build()
      → BaseSsCall.enqueue() / .execute()
        → TTNet / Cronet (ByteDance 自研网络引擎)
          → NetworkParams.LJIILLIIL
            → libmetasec_ml.so / f3.a(0x03000001)
              → 返回 X-Neptune security factor
```

### 关键类 (来自 jadx 反编译)

| 类 | 包 | 作用 |
|---|---|---|
| `Request$Builder` | `com.bytedance.retrofit2.client` | 构造 API 请求 |
| `BaseSsCall` | `com.bytedance.frameworks.baselib.network.http.impl` | 执行 HTTP 调用 |
| `NetworkParams` | `com.bytedance.frameworks.baselib.network.http` | 网络参数（含签名） |
| `BaseHttpRequestInfo` | `com.bytedance.frameworks.baselib.network.http` | 请求元数据 |
| `NetworkLibLayerMetrics` | `com.bytedance.retrofit2` | 网络性能指标（含 bdTuringDuration） |
| `BdTuringVerifyActivity` | `com.bytedance.android.turingverify` | 二次人机验证 |

### 与 OkHttp 的关系

Retrofit2 底层使用 OkHttp 作为 HTTP 引擎，因此 OkHttp 层的 Hook 仍能捕获部分请求。但：

- **TTNet 旁路**：`x-ttnet-bypass-cookie` 和 `x-metasec-bypass-ttnet-features` 头表明 TTNet 可以绕过 OkHttp cookie/header 管理
- **Cronet 传输**：部分请求可能使用 Cronet（Chromium 网络栈）进行 QUIC/HTTP3 传输，完全绕过 OkHttp
- **MetaSec security factor**：39.5.0 已实测 `f3.a(0x03000001)` 返回
  `X-Neptune`；H5 `a_bogus` 属于另一条 bdms/JS 路径

## 解决方案：多层 Hook 架构

### 架构图

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: Java — Retrofit2 Request.Builder.build()   │
│   捕获所有 API 请求的 URL、method、headers             │
├─────────────────────────────────────────────────────┤
│ Layer 2: Java — OkHttp Request.Builder.build()       │
│   作为 Retrofit 的 fallback，捕获底层 OkHttp 请求       │
├─────────────────────────────────────────────────────┤
│ Layer 3: Java — BaseSsCall.enqueue()                 │
│   捕获带签名后的实际请求                                │
├─────────────────────────────────────────────────────┤
│ Layer 4: Java — BdTuringVerifyActivity bypass        │
│   在 onCreate() 中立即 finish()，跳过人机验证           │
├─────────────────────────────────────────────────────┤
│ Layer 5: Native — RegisterNatives (libart.so)        │
│   捕获 libmetasec_ml.so 注册的 JNI 方法                │
├─────────────────────────────────────────────────────┤
│ Layer 6: Native — libmetasec_ml.so sign exports      │
│   Hook 所有签名/加密相关的导出函数                      │
├─────────────────────────────────────────────────────┤
│ Layer 7: Native — Cronet/TTNet boundary              │
│   Hook libcronet.so / libttnet.so 请求函数             │
└─────────────────────────────────────────────────────┘
```

### 文件

| 文件 | 说明 |
|---|---|
| `hook/native-chain.js` | Frida 脚本源码 (使用 frida-java-bridge) |
| `hook/native-chain.bundle.js` | frida-compile 编译产物 (484 KB) |
| `hook/run-native-chain.mjs` | Node.js 注入器，收集结构化事件 |
| `hook/native-probe.py` | Python 注入器，支持 dual-realm（native + emulated） |

### Frida 17 兼容性

Frida 17 不再内置 `Java` 全局对象。旧脚本 `shop-api.js` 使用 `Java.use()` 会报 `Java is not defined`。

解决方式：
```javascript
// 旧写法 (Frida ≤16, 不再有效)
Java.perform(() => { Java.use('okhttp3.Request$Builder'); });

// 新写法 (Frida 17+)
import Java from 'frida-java-bridge';
Java.perform(() => { Java.use('okhttp3.Request$Builder'); });
```

使用 `frida-compile` 将脚本与 `frida-java-bridge` 打包为独立 bundle：
```powershell
npx frida-compile hook/native-chain.js -o hook/native-chain.bundle.js -B iife -S
```

### Emulated Realm (ARM64 → x86_64)

MuMu 模拟器使用 libhoudini/ndk_translation 将 ARM64 指令翻译为 x86_64。ARM64 原生库运行在 **emulated realm** 中，需要单独 attach：

```python
# Native realm (x86_64 代码)
session_native = device.attach(pid, realm='native')

# Emulated realm (ARM64 → x86_64 翻译层，libmetasec_ml.so 在此运行)
session_emulated = device.attach(pid, realm='emulated')
```

`hook/native-probe.py --dual-realm` 同时附加两个 realm。

### BdTuringVerifyActivity 绕过

分享操作会触发二次验证。绕过策略：

1. **直接 Hook**：Hook `BdTuringVerifyActivity.onCreate()` → 立即 `finish()`
2. **Instrumentation 拦截**：Hook `android.app.Instrumentation.newActivity()` → 检测 turing/verify 类名 → finish
3. **备选模式**：尝试多个可能的类名：
   - `com.bytedance.android.turingverify.BdTuringVerifyActivity`
   - `com.bytedance.turingverify.TuringVerifyActivity`
   - `com.bytedance.turing.TuringVerifyActivity`

## 使用方法

### Node.js (推荐 — 完整 JSON 输出)

```powershell
# 编译 + 注入
npm run capture:native

# 或手动分步
npm run build:native-chain
node hook/run-native-chain.mjs

# 带选项
node hook/run-native-chain.mjs --spawn --output output/my-capture.json
```

### Python (轻量 — 支持 dual-realm)

```powershell
# 附加到运行中的 App（仅 native realm）
python hook/native-probe.py

# 附加 native + emulated realm
python hook/native-probe.py --dual-realm

# 启动新进程
python hook/native-probe.py --spawn --dual-realm
```

### 操作步骤

1. 确保 frida-server 在 MuMu 中运行
2. 启动抖音商城 App
3. 运行 `npm run capture:native`
4. 在 App 中打开一个商品详情页（Golden Goose 或其他）
5. 观察控制台输出：retrofit2 层的请求 URL、headers、签名参数
6. 按 Ctrl+C 保存 capture JSON

## 输出

`run-native-chain.mjs` 产生结构化 JSON：

```json
{
  "capturedAt": "2026-07-14T...",
  "summary": {
    "totalEvents": 150,
    "packRequests": 3,
    "signCalls": 2,
    "bypasses": 0
  },
  "packRequests": [
    {
      "layer": "retrofit2",
      "method": "POST",
      "url": "https://aweme.snssdk.com/aweme/v2/shop/promotion/pack/?a_bogus=...",
      "headers": ["x-metasec-bypass-ttnet-features: ...", ...],
      "bodyEncrypted": false,
      "queryEncrypted": false
    }
  ],
  "signCalls": [
    {
      "source": "native",
      "fnName": "sign",
      "module": "libmetasec_ml.so",
      "result": "aBogusValue...",
      "elapsedMs": 12
    }
  ]
}
```

## 待完成 (下一轮)

1. **从 capture 提取完整签名输入** — 理解 query + body → a_bogus 的映射
2. **纯 Python 签名复现** — 逆向 `libmetasec_ml.so` 的 sign 函数逻辑
3. **店铺商品列表 API 发现** — 找到 `/aweme/v2/shop/product/list/` 等价端点
4. **Cronet 原生 Hook 验证** — 确认 TTNet/Cronet 路径是否实际被使用
5. **BdTuring 完整绕过** — 验证所有触发路径（分享、高频请求等）
