# Unidbg MetaSec signer (Phase C)

Offline path toward pure reverse: load `libmetasec_ml.so` and expose the same HTTP API as
`src/native-sign.mjs` expects so Node can use `--sign-mode local`.

## Two backends (same HTTP contract)

| Backend | Command | Frida? | Offline? | Status |
|---------|---------|--------|----------|--------|
| **Frida bridge (可用)** | `npm run sign:local-service` | 是（侧车进程） | 否 | 生产过渡方案 |
| **Unidbg (脚手架)** | `cd unidbg-metasec && mvn -q package && java -jar target/...` | 否 | 目标是 | SO 加载/HTTP 有，**签名算法未接完** |

Node 客户端不区分后端：

```text
POST http://127.0.0.1:17890/sign
{ "url": "...", "headers": {}, "body": "..." }
→ { "ok": true, "headers": { "X-Gorgon": "...", ... } }
```

## 立即可用：Frida 桥接侧车

```powershell
# 终端 1：App 已登录 + frida-server
npm run build:direct-search
npm run sign:local-service

# 终端 2：Node 只走 HTTP 签名
npm start -- --query 运动鞋 --single-page --sign-mode local
```

这把 Frida 从采集进程里拆出去：采集侧只依赖 `native-sign.mjs`，签名进程可替换为 Unidbg。

## Unidbg 工程

### 依赖

- JDK 17+（本机已有 21）
- Maven 3.9+
- SO：`../reverse/apk_extracted/lib/arm64-v8a/libmetasec_ml.so`

### 构建 / 运行

```powershell
cd unidbg-metasec
mvn -q -DskipTests package
$env:METASEC_SO = (Resolve-Path ..\reverse\apk_extracted\lib\arm64-v8a\libmetasec_ml.so)
java -jar target\unidbg-metasec-0.1.0-SNAPSHOT.jar --so $env:METASEC_SO --port 17890
```

### 调用约定（逆向目标）

App 内：

```text
NetworkParams.LJIILLIIL(url, Map<String,List<String>>)
  → f3.a(0x03000001 /*50331649*/, 0, handle, url, String[]{k1,v1,k2,v2,...})
  → String[] 交替键值 → Map 安全头
```

参考：`reverse/NetworkParams.full.java`、`NATIVE_SIGNER.md`、`output/sign-pairs/`。

采集对照样本：

```powershell
npm run sign:dump-pairs -- --query 运动鞋 --count 20
```

### 当前进度

| 步骤 | 状态 |
|------|------|
| SO load | ✅ `module_base` 可见 |
| 可选 APK context | ✅ `--apk` / `METASEC_APK` |
| `JNI_OnLoad` | ⚠️ 已尝试，结果看 `/health` |
| 符号探测 | ✅ `GET /symbols`（`getEncodedP` 多半无导出，仅有 rodata 字符串 @0xc35d4） |
| `f3.a(0x03000001,…)` | ⚠️ 实验调用；无真实 handle 时通常失败 |
| 与 Frida 对齐 | 用 `npm run sign:dump-pairs` 采 `f3_io` + `metasec_handle` |

### 当前缺口

1. MetaSec **handle / provider 初始化**（离线无 App 时 handle=0）
2. `getEncodedP` 函数体偏移（字符串在 0xc35d4，需 Ghidra XREF）
3. 用 Frida 样本反推 Unidbg 可复现路径

## 验收

| 级别 | 标准 |
|------|------|
| Bridge | `sign:local-service` + `--sign-mode local` 搜到商品 |
| Unidbg load | `/health` 报告 module_base，无 load_error |
| Unidbg sign | 固定 fixture 与 Frida 关键 X 头一致，或搜索 HTTP 200 |
