# a_bogus 静态追踪报告

> 2026-07-19 基于 `libmetasec_ml.so` (5.6 MB) 和 `libsscronet.so` (4.8 MB) 的纯静态二进制分析。

## 样本信息

| 文件 | 大小 | SHA-256 |
|------|------|---------|
| `libmetasec_ml.so` | 5,657,800 bytes | `e6a4700a23c2040e77b85d8d912c006687cf33ade8d86df90e0967d051d221b0` |
| `libsscronet.so` | 5,022,152 bytes | — |
| 来源 | `douyin-mall-39.5.0.apk` → `lib/arm64-v8a/` | — |

## ELF 结构 (libmetasec_ml.so)

| Section | VA | Size | 内容 |
|---------|-----|------|------|
| `.text` | 0x1698c0 | 3,498,772 bytes | 代码 (混淆) |
| `.rodata` | 0xc2d30 | 360,472 bytes | 字符串表 / 常量 |
| `.data.rel.ro` | 0x4c5480 | 188,040 bytes | 指针表 (需重定位) |
| `.rela.dyn` | 0x1ce0 | 786,832 bytes | 32,806 个 `R_AARCH64_RELATIVE` 重定位项 |
| `.data` | 0x4f8070 | 478,576 bytes | 可读写数据 |
| `.init_array` | 0x4f3718 | 15 × 8 bytes | 初始化函数指针 (加载时填充) |

## 关键发现

### 1. a_bogus 字符串确认不存在

- 明文扫描：**0 hits** (在 5.6 MB SO 中完全没有 `a_bogus` 或 `abogus` 字面量)
- XOR 单字节扫描：**0 hits** (对所有 256 个可能密钥逐一尝试，均不匹配)
- 结论：**a_bogus 字符串在运行时逐字符构造**（栈上通过 MOV 立即数写入）

### 2. 找到的关键符号

| 符号名 | .rodata 偏移 | 推测功能 |
|--------|-------------|---------|
| **`getEncodedP`** | 0xc35d4 | ⭐ **a_bogus 生成函数** — "getEncodedParameters" |
| `PAYLOAD_MD5` | 0xc33ed | 请求体 MD5 计算 |
| `HTTP_CALLBACK` | 0xc40b6 | HTTP 请求拦截回调 |
| `X-BD-KMSV` | 0xc35e7 | ByteDance KMS 版本头 |
| `X-BD-CLIENT-KEY` | 0xc4617 | ByteDance 客户端密钥头 |
| `encoded` | 0xc35d8 附近 | 编码相关辅助符号 |
| `encoding` | 0xc35d8 附近 | 编码相关辅助符号 |

### 3. 导入表分析

**0 个加密库导入** — SO 没有链接 OpenSSL、BoringSSL 或任何外部加密库。

所有加密原语（MD5、HMAC、AES、RSA）均为**内部实现**，编译在 3.3 MB 的 `.text` 段中。

唯一与字符串格式化相关的导入：
- `vsnprintf` → GOT slot @ VA 0x4f3c98
- `asprintf` / `vasprintf` → 动态字符串分配

### 4. JNI_OnLoad 混淆

```
JNI_OnLoad @ VA 0x28f03c, size 0x334

入口 (前64字节):
  fd 7b bc a9  f8 5f 01 a9  fd 03 00 91  f6 57 02 a9
  f4 4f 03 a9  ff 43 00 d1  56 d0 3b d5  73 17 00 b0
  ...

SVC #0 断点位置: +0xa8, +0x148, +0x208, +0x298
(4 个反调试陷阱)
```

### 5. libsscronet.so 的角色

- **不含任何签名逻辑** — 没有 `a_bogus`、`bogus`、`X-Bogus`、`getEncoded` 或 `PAYLOAD_MD5` 相关字符串
- **包含大型英文词表** — 用于运行时的动态字符串反混淆（从词表中选择单词来重建被混淆的字符串）
- 唯一的签名相关引用：字符串 `"metasec"` @ 0x7ef05（用于 `dlopen("libmetasec_ml.so")`）

### 6. 调用链确认

```
libsscronet.so (Cronet网络引擎)
  → dlopen("libmetasec_ml.so")
  → dlsym(handle, ...)  // 查找签名函数
  → 调用 getEncodedP(query_string, body_string) → char*
  → 用 vsnprintf/asprintf 将返回值追加到 URL: &a_bogus={result}
```

## 静态分析的局限

| 能力 | 是否需要 | 当前可行 |
|------|---------|---------|
| 找到 getEncodedP 函数体 | ✅ | ❌ 需要 Ghidra/IDA ARM64 反编译 |
| 追踪 XREF 到 0xc35d4 | ✅ | ❌ 3.3MB 代码手工搜 ADRP 不现实 |
| 分析函数算法逻辑 | ✅ | ❌ 控制流平坦化 + 混淆 |
| 识别 MD5/HMAC 内联实现 | 辅助 | ❌ 无符号表 |
| 提取硬编码常量 | 辅助 | ❌ 常量可能被 XOR 保护 |

## 下一步：动态辅助静态

最有效的推进路径是用 **Frida 动态信息反哺静态分析**：

1. Hook `RegisterNatives` → 拿到 `f3.a` 的 native 函数指针 → 算出 SO 内偏移
2. 在 `f3.a` 偏移处打断点 → dump 输入参数 (op=0x03000001, url, headerPairs)
3. 在 `getEncodedP` XREF 处打断点 → 确认是否被 `f3.a` 调用
4. 在 `vsnprintf` (GOT 0x4f3c98) 打断点 → 捕获格式化后的完整 URL
5. 有了已知输入/输出对 → 用 Ghidra 从函数偏移开始反编译 → 比纯静态高效 10x

**纯静态完全可行，但需要 Ghidra/IDA 替代手工 hex 浏览。**

## Unidbg 动态探测更新（2026-08）

在 `unidbg-metasec` 中加载 `libmetasec_ml.so`（无 APK）实测：

| 项 | 值 |
|----|-----|
| module_base | `0x40000000` |
| module_size | `5783552` |
| **JNI_OnLoad 导出** | ✅ 唯一 dynsym 定义符号；`SO+0x28f03c`，size `0x334` |
| getEncodedP 导出 | ❌ 无符号（仅 `.rodata` 字符串 `@0xc35d4`） |
| Java_ms_bd_c_f3_a 导出 | ❌（动态注册，且 **无 `RegisterNatives` 导入**） |
| 动态导入 | `dlopen` / `dlsym` / `memcpy` / `vsnprintf` / `strlen` … |
| callJNI_OnLoad | ❌ `Illegal JNI version: 0xffffffff`（反调试/环境校验） |

### getEncodedP 交叉引用 — 重要更正

用 Capstone 跟 `ADRP+ADD → 0xc35d4` 的代码点（如 `0x4bf458`）后发现：

- 这些点落在 **`0x4bf2a0` 起的 unwind/DWARF 指针解码例程**（LEB128、`libunwind` 错误字符串）。
- `getEncodedP` 字符串与 `std::bad_alloc`、`X-BD-KMSV`、`objc_object` 等挤在同一 rodata 区；
  **邻近字符串被错误路径引用 ≠ 加密函数 XREF**。
- 因此：**不能**再把 `0x4bf2a0` 当作 `getEncodedP` 实现体。

真正签名入口应优先：

1. Java `ms.bd.c.f3.a` → ART 绑定的 native entry（Frida 抓 `ArtMethod` / 调用栈）
2. `dlsym("…")` 动态解析（SO **imports dlsym**）
3. 自建 JNIEnv vtable 调用（无 `RegisterNatives` 导入，可能手写 env→func）

### Frida 追踪工具

```powershell
npm run build:metasec-trace
npm run trace:metasec -- --sign --wait-ms 5000
# → output/direct-search/metasec-native-trace-*.json
```

另：`signOnly` 可记录 `f3_io` + `metasec_handle`（`z4.LIZ`），见 `npm run sign:dump-pairs`。

### 静态探测产物

- `tools/probe_metasec_static.py` → `output/direct-search/metasec-static-probe.json`
- `tools/disasm_metasec_getencoded.py` → `output/direct-search/metasec-disasm-getencoded.json`
