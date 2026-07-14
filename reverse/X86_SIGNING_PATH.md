# x86_64 / MuMu 签名路径复核

样本：`reverse/samples/douyin-mall-39.5.0.apk`

## 结论

- APK 的 196 个 native 库全部位于 `lib/arm64-v8a/`；`libsscronet.so` 与
  `libmetasec_ml.so` 都没有 x86/x86_64 变体。它们在 MuMu x86_64 上成功运行时会经过
  native bridge；只观察 x86_64 module/JNI realm 会漏掉 ARM64 侧加载与注册。
- Java 层已经找到统一的安全因子入口：
  `NetworkParams.LJIILLIIL(url, headers)`。HTTP 分支明确调用
  `f3.a(0x03000001, 0, handle, url, headerPairs)`。
- `a_bogus`、`abogus`、`X-Bogus` 在全部 DEX、APK 文本资源和两个目标 SO 的明文中均为
  0 命中。当前 native App 路径把 `f3.a` 返回的键值数组转成 Map，再由 OkHttp 或 Cronet
  作为安全因子写入请求；Java 中没有 `StringBuilder + URL + a_bogus` 拼接点。
- `libsscronet.so` 有两条加载路径：启动期可选预加载，以及首次创建 Cronet engine 时的
  必经加载。它不是 ARM64 条件分支，但 APK 只打包 ARM64 库。
- MetaSec provider 由 native 回调操作码 `0x02000001` 安装；安装前
  `NetworkParams.LJIILLIIL` 直接返回 `null`。OkHttp 随后放行原请求。

## 关键位置

`reverse/NetworkParams.full.java:327` — `NetworkParams.LJIILLIIL` — Java 安全因子统一入口。

`reverse/NetworkParams.full.java:369` — `NetworkParams.LJIILLIIL` — HTTP 分支调用 `f3.a(0x03000001, ..., url, headerPairs)`。

`reverse/NetworkParams.full.java:374` — `NetworkParams.LJIILLIIL` — WebSocket 分支调用 `f3.a(0x06000001, ...)`。

`reverse/security_src/sources/ms/bd/c/f3.java:5` — `ms.bd.c.f3.a(IIJLjava/lang/String;Ljava/lang/Object;)` — MetaSec native 边界。

`reverse/security_src/sources/ms/bd/c/x2.java:169` — `ms.bd.c.x2.LIZJ` — native 回调 `0x02000001`，把 handle 交给 `z4`。

`reverse/security_src/sources/ms/bd/c/z4.java:17` — `ms.bd.c.z4.LIZ` — 保存 native handle 并安装 `NetworkParams.LJIILLIIL` provider。

`reverse/classes20_src/sources/com/bytedance/frameworks/baselib/network/http/ok3/impl/OkHttp3SecurityFactorInterceptor.java:20` — `OkHttp3SecurityFactorInterceptor.intercept` — OkHttp 调用安全因子入口。

`reverse/classes20_src/sources/com/bytedance/frameworks/baselib/network/http/ok3/impl/OkHttp3SecurityFactorInterceptor.java:25` — `OkHttp3SecurityFactorInterceptor.intercept` — provider 结果为 null 时放行原请求。

`reverse/classes20_src/sources/com/bytedance/frameworks/baselib/network/http/ok3/impl/OkHttp3SecurityFactorInterceptor.java:33` — `OkHttp3SecurityFactorInterceptor.intercept` — 将 native 返回 Map 逐项加入 headers。

`reverse/partial_src/sources/com/bytedance/ttnet/cronet/AbsCronetDependAdapter.java:836` — `AbsCronetDependAdapter.onCallToAddSecurityFactor` — Cronet 安全因子回调。

`reverse/partial_src/sources/com/bytedance/ttnet/cronet/AbsCronetDependAdapter.java:843` — `AbsCronetDependAdapter.onCallToAddSecurityFactor` — Cronet 转发到 `NetworkParams.LJIILLIIL`。

`reverse/X_0ujw_methods.txt:280` — `X.0ujw.newSsCall` — 请求入口；完整 DEX 指令 dump。

`reverse/X_0ujw_methods.txt:352` — `X.0ujw.newSsCall` — 以 `Request.getPath()` 触发 `lazyInitCronetEngine`。

`reverse/X_0ujw_methods.txt:524` — `X.0ujw.newSsCall` — 正常路径构造 `X.0ulG(Request, ICronetClient)`。

`reverse/partial_src/sources/X/AbstractC265010ulA.java:317` — `X.0ulA.LJJIJL` — 实际 `ICronetClient.openConnection` 点。

`reverse/partial_src/sources/com/ttnet/org/chromium/net/impl/CronetUrlRequestContext.java:1069` — `CronetUrlRequestContext.<init>` — 创建 Cronet engine 时调用 loader。

`reverse/partial_src/sources/com/ttnet/org/chromium/net/impl/CronetLibraryLoader.java:85` — `CronetLibraryLoader.loadCronetLibrary` — 自定义路径、provider、Librarian 三路加载选择。

`reverse/partial_src/sources/com/ttnet/org/chromium/net/impl/CronetLibraryLoader.java:97` — `CronetLibraryLoader.loadCronetLibrary` — provider 加载 `sscronet`。

`reverse/partial_src/sources/com/ttnet/org/chromium/net/impl/CronetLibraryLoader.java:99` — `CronetLibraryLoader.loadCronetLibrary` — 默认加载 `sscronet`。

`reverse/partial_src/sources/com/ttnet/org/chromium/net/impl/CronetLibraryLoader.java:121` — `CronetLibraryLoader.ensureInitialized` — `sLibraryLoaded == false` 时执行加载并校验版本。

`reverse/TTnetSoPreloadTask.java:93` — `TTnetSoPreloadTask.LIZ` — 启动期 Librarian 预加载封装。

`reverse/TTnetSoPreloadTask.java:109` — `TTnetSoPreloadTask.run` — 预加载开关通过后在 IO executor 执行。

`reverse/security_src/sources/Y/ARunnableS122S0000000_16.java:107` — `ARunnableS122S0000000_16.run$6` — 先预加载 `sscronet`，再加载 `metasec_ml`。

`reverse/InitPreloadCronet_preload.dump.txt:51` — `InitPreloadCronet$preloadCronetSo$1.run` — 插件安装时走 Cronet plugin，否则走 `TTnetSoPreloadTask.LIZ`。

`reverse/X_0hro.java:8` — `X.0hro.LIZ` — 冷启动预加载条件。

## `X.0ujw` 方法表

DEX 共 13 个 encoded methods；去掉 `<clinit>`、`<init>` 后正好 11 个：

1. `LIZ(String[], byte[], byte[], long, long, boolean): void`
2. `LIZIZ(): void`
3. `LIZJ(): ICronetClient`
4. `LIZLLL(int, String): int`
5. `LJ(Context): X.0ujw`
6. `LJFF(ICronetAppProvider, X.0uWw): void`
7. `LJI(): void`
8. `LJII(JSONObject, SharedPreferences): void`
9. `LJIIIIZZ(JSONObject): void`
10. `LJIIIZ(JSONObject): void`
11. `newSsCall(Request): SsCall`

其中只有 `newSsCall(Request)` 接触 URL/path；本类没有 `openConnection`。连接创建下沉到
`X.0ulA.LJJIJL`。

## 下一轮动态锚点

1. Hook `NetworkParams.LJIILLIIL`，记录 URL、provider 是否为 null、返回 Map。
2. Hook `z4.LIZ(long)`，确认 MetaSec provider 安装时间和 native handle。
3. Hook `f3.a`，只记录 `op == 0x03000001` 的入参与返回 `String[]`。
4. Hook `CronetLibraryLoader.ensureInitialized/loadCronetLibrary` 与
   `Librarian.loadLibrary`，区分预加载、首次请求加载和加载异常。
5. 同时读取 `/proc/self/maps`，并在 native-bridge/ARM64 realm 枚举 module；对照 Java hook
   是否命中即可判断是“路径未执行”还是“观察 realm 不同”。
