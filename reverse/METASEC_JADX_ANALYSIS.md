# MetaSec / `pigeon_sign` / `a_bogus` 静态分析

> 2026-07-14 更正：全 DEX 精确调用扫描已找到
> `NetworkParams.LJIILLIIL -> f3.a(0x03000001, 0, handle, url, headerPairs)`。
> 当前版本的更新结论与行号见 `reverse/X86_SIGNING_PATH.md`；下文“Java 中没有
> `0x03000001` 调用点”的旧结论已被该扫描结果取代。

样本：`reverse/samples/douyin-mall-39.5.0.apk`

- 包内 `lib/arm64-v8a/libmetasec_ml.so`：5,657,800 bytes
- SHA-256：`e6a4700a23c2040e77b85d8d912c006687cf33ade8d86df90e0967d051d221b0`
- 提取位置：`reverse/apk_extracted/lib/arm64-v8a/libmetasec_ml.so`

## 结论摘要

1. `pigeon_sign` 不是本地 MetaSec 生成值。它来自 Pigeon 的
   `GET /chat/api/get_link_info` 响应，Java 只负责解析、缓存，并将其写入
   Frontier header。
2. 全部 DEX 中没有 `a_bogus` / `abogus` 明文（存在少量与目标参数无关的通用
   `bogus` 文本）。Java 请求链可追到
   `ICronetClient.openConnection(...)`；参数实际追加点已经落入
   `libsscronet.so -> libmetasec_ml.so` 的 native 边界。
3. `libmetasec_ml.so` 已去除 `.symtab`，`.dynsym` 只有一个本库函数：
   `JNI_OnLoad @ 0x28f03c`（size `0x334`）。不存在带 `sign` 名称的导出。
4. 当前 DEX 中 MetaSec 唯一 native 声明是：
   `ms.bd.c.f3.a(int,int,long,String,Object): Object`。这就是
   `RegisterNatives` 的首要目标；旧版本公开分析中的类名可能是
   `ms/bd/c/y2` 或其他短名，不能直接套到 39.5.0。

## 1. `pigeon_sign` 数据流

### 生成位置

本地没有生成算法，值由服务端响应返回：

```text
C0rL4.LJ(bizType, callback)
  -> path.LJFF() == "/get_link_info"
  -> C0rKR.LIZIZ(...)
  -> GET {base}/chat/api/get_link_info?PIGEON_BIZ_TYPE=...
  -> X.0rLC.onSuccess(C0rKS)
  -> JSONObject.optString("pigeon_sign")
  -> new LinkInfo(..., pigeonSign, ...)
  -> ConvDomainService.LJII(LinkInfo)
  -> onFrontierHeaderChanged({"pigeon_sign": value, "token": token})
```

JADX 锚点：

- `reverse/security_src/sources/X/C0rL4.java:27,53`
- `reverse/security_src/sources/X/C0rKR.java:70-77`
- `reverse/security_src/sources/com/ss/android/ecom/pigeon/conv/dto/LinkInfo.java:81`
- `reverse/security_src/sources/com/ss/android/ecom/pigeon/conv/ConvDomainService.java:88`

`X.0rKH` 因大小写文件名冲突未被 JADX 单独落盘；DEX 指令确认其构造器常量
为 `/chat/api/`，`LJFF()` 返回 `/get_link_info`。

## 2. `a_bogus` 的 Java 调用栈与 native 边界

### Java 主链

```text
Retrofit.create(service)
  -> Retrofit.loadServiceMethod(method)
  -> ServiceMethod / RequestFactory.parseAnnotations(...)
  -> HttpServiceMethod.invoke(args)
  -> new SsHttpCall(requestFactory, args)
  -> SsHttpCall.ensureOriginalRequestCreated()
       -> RequestFactory.toRequest(...)
  -> SsHttpCall.getResponseWithInterceptorChain()
  -> CallServerInterceptor.intercept(chain)
  -> clientProvider.get().newSsCall(request)
  -> SsRetrofitClient.newSsCall(request)
  -> HttpClient 的 Cronet IHttpClient
  -> X.0ujw.newSsCall(request)
  -> X.0ulG / BaseSsCall
  -> AbstractC265010ulA.LJJIJL(...)
  -> ICronetClient.openConnection(...)
  -> libsscronet.so
  -> libmetasec_ml.so
```

JADX 锚点：

- `reverse/partial_src/sources/com/bytedance/retrofit2/Retrofit.java:269,286-290`
- `reverse/partial_src/sources/com/bytedance/retrofit2/HttpServiceMethod.java:25`
- `reverse/classes20_src/sources/com/bytedance/retrofit2/SsHttpCall.java:293,307,341`
- `reverse/classes20_src/sources/com/bytedance/retrofit2/CallServerInterceptor.java:104,149,164`
- `reverse/partial_src/sources/com/bytedance/ttnet/retrofit/SsRetrofitClient.java:13-28`
- `reverse/partial_src/sources/X/C264250ujw.java:122`（JADX 对此大函数反编译失败；DEX
  指令显示成功路径构造 `X.0ulG(Request, ICronetClient)`）
- `reverse/partial_src/sources/X/AbstractC265010ulA.java:31,317`

### 为什么搜不到 `a_bogus`

- APK 的全部 DEX 均无 `a_bogus` 或 `abogus` 字符串；泛化的 `bogus` 命中与
  目标查询参数无关。
- Java 层只把 URL、method、headers、body 送进 Cronet。
- `a_bogus` 的首次可见点应在 Cronet native 请求修改完成之后，而不是 Retrofit
  `RequestFactory.toRequest()` 阶段。
- MetaSec Java 桥 `f3.a(...)` 中，DEX 只出现 `0x03000002` 与
  `0x03000003` 的显式调用；公开分析中用于签名的 `0x03000001` 没有 Java
  调用点，符合 `libsscronet.so` 直接调用 MetaSec native 函数的结构。

### MetaSec Java 桥

```java
// reverse/security_src/sources/ms/bd/c/f3.java:5
public static native Object a(int op, int arg, long handle,
                              String text, Object payload);
```

初始化与加载锚点：

- `MSB.<clinit>` 设置 `n2.LIBNAME = "metasec_ml"`
- `d3.LIZIZ(context, "metasec_ml")`
- `X.C0Tpp.LLILIL("metasec_ml")`
- `Librarian.loadLibrary("metasec_ml")`

## 3. 安全相关 native 库加载

字节使用 `Librarian` / Cronet loader / Lynx loader 包装系统加载调用，因此只搜
`System.loadLibrary` 会漏掉关键库。

| 库 | Java 加载锚点 | 与当前签名链的关系 |
|---|---|---|
| `libmetasec_ml.so` | `X.C0Tpp:2045-2051`; `MSB`; `d3` | 核心 MetaSec native 桥 |
| `libsscronet.so` | `CronetLibraryLoader.java:97-99` | 网络 native 层；签名参数追加边界 |
| `libttcrypto.so` | `X.0kW8.LIZLLL()` / Crash SDK 初始化 | 通用 ByteDance crypto，非 `a_bogus` 唯一入口 |
| `liblynxsecurity.so` | `LynxSecurityService.doInitialize()` | Lynx payload / TASM 校验，旁路组件 |
| `libEncryptor.so` | `EncryptorUtil.ttEncrypt(...)` | 日志/上报体加密，旁路组件 |
| `libisecgm.so` | `CJSecServiceImpl` 初始化配置 | 财经安全组件，旁路组件 |

直接命中当前链的最小集合是 `sscronet + metasec_ml`。

## 4. `libmetasec_ml.so` 符号表

```text
ELF:       ELF64 / AArch64 / ET_DYN
SONAME:    libmetasec_ml.so
Build ID:  e9b8dc95ed5fe36fae17656b987d55d93e570249
NDK note:  r25c / 9519653
.symtab:   absent
.dynsym:   144 entries
defined:   JNI_OnLoad @ 0x28f03c, size 0x334
imports:   142
```

依赖：`liblog.so`, `libandroid.so`, `libm.so`, `libdl.so`, `libc.so`。

字符串中与请求处理最接近的只有 `PAYLOAD_MD5`、`HTTP_CALLBACK`；没有
`sign`、`a_bogus`、Java 类路径或 JNI 方法签名明文。

`.init_array` 通过 `R_AARCH64_RELATIVE` 指向 15 个初始化函数：

```text
0x17f248 0x18a33c 0x279c2c 0x284ebc 0x29b81c
0x2ba608 0x2be1fc 0x2bf854 0x2c0a08 0x2c28f4
0x2c432c 0x2c5a88 0x2c68a4 0x4111d0 0x4bba14
```

`JNI_OnLoad` 起始处很快进入 `svc #0` 与间接跳转混淆，静态反汇编不能把
`RegisterNatives` 表恢复为普通符号。最有效的运行时锚点是：

1. Hook `JNIEnv->RegisterNatives`，筛选类 `ms.bd.c.f3`、方法 `a`、签名
   `(IIJLjava/lang/String;Ljava/lang/Object;)Ljava/lang/Object;`。
2. 记录注册函数指针相对 `libmetasec_ml.so` base 的偏移。
3. 同时在 `libsscronet.so` 边界比较进入前 URL 与发出前 URL，确定
   `a_bogus` 首次出现位置。
4. 不直接复用其他版本公开文章的固定偏移。

## 5. 公开分析交叉验证

- [Oacia 的分析](https://oacia.dev/douyin-6shen-init/)定位到
  `libmetasec_ml.so`，并通过 Hook `RegisterNatives`
  枚举动态注册函数；同时指出库具有高强度控制流混淆。
- [2026 年看雪文章](https://bbs.kanxue.com/thread-289870.htm)确认另一版本同样只有
  `JNI_OnLoad` 静态导出，并观察到
  Cronet 的 `libsscronet.so` 调用 MetaSec 签名函数；其固定偏移属于其他版本。
- [Unidbg 案例](https://cn-sec.com/archives/5196348.html)强调 MetaSec 对 Java 类继承链和加载顺序有依赖，说明只加载 SO
  而不还原 Java 初始化环境会导致返回空值或分支错误。

复现符号报告：

```powershell
python reverse/analyze_metasec_symbols.py `
  reverse/apk_extracted/lib/arm64-v8a/libmetasec_ml.so `
  -o reverse/metasec-symbols.json
```
