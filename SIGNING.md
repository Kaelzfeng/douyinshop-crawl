# H5 `a_bogus` 签名与验证

## 适用范围

当前签名模块用于抖音商品分享 H5 的接口：

```text
POST https://haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/h5/
```

它不依赖 MuMu 或抖音 App，但并非纯 Python 算法实现。Node 服务会启动一个持久的无头 Edge 页面，只加载仓库内的 `reverse/web_sign/bdms-1.0.0.38.js`，然后直接调用已定位的 VM signer 闭包 `window.bdms.init._v[2][21]`。它不会访问商品网页。

原生“抖音商城”详情页使用的是另一条链：

```text
POST https://aweme.snssdk.com/aweme/v2/shop/promotion/pack/
```

该请求经过 ByteDance Retrofit2、TTNet/Cronet 和原生 MetaSec。本模块不能用来证明原生 `/pack/` 请求已签名成功。

## 环境

- Node.js 20+
- Microsoft Edge
- Python 3.10+
- 已执行 `npm install`

可用环境变量：

- `DOUYIN_SIGNER_BROWSER_CHANNEL`：Playwright 浏览器 channel，默认 `msedge`
- `DOUYIN_SIGNER_HEADFUL=1`：显示签名页面，默认无头
- `DOUYIN_SIGNER_USER_AGENT`：签名运行时及验证请求使用的 User-Agent

## Python 持久调用

```python
from sign import ABogusSigner

query = "is_h5=1&verifyFp=verify_from_the_same_h5_session"
body = "promotion_ids=3713354677006499920&item_id=0"

with ABogusSigner() as signer:
    first = signer.sign(query, body)
    second = signer.sign(query, body)
```

同一个 `ABogusSigner` 会复用同一 Node/Edge 进程。签名包含时间与随机量，所以相同输入的结果通常不同；当前 bundle 的结果长度为 44。

必须传入：

- URL 中 `?` 后、但不含 `a_bogus` 的原始 query
- 实际发送的、未经重新排序或重新编码的精确 body 字符串

`verifyFp` 不由 bdms 生成，必须来自对应的 H5 会话。不要伪造或跨会话复用它。

## JSONL 服务

启动：

```powershell
npm run sign:service
```

输入一行：

```json
{"id":1,"op":"sign","query":"is_h5=1&verifyFp=verify_example","body":"promotion_ids=123"}
```

成功响应只包含新签名；`close` 操作会干净退出：

```json
{"id":2,"op":"close"}
```

## 自动测试

```powershell
npm run test:signer
```

测试会启动一次持久 signer，连续签名 12 次，并验证：

- VM 入口元数据与已分析 bundle 一致
- 每个签名长度为 44，重复输入仍产生新值
- 已含 `a_bogus` 的 query 会被拒绝
- 错误请求不会破坏后续签名

完整项目测试：

```powershell
npm test
```

## H5 API 实际验证

验证最新 capture：

```powershell
npm run verify:h5
```

指定 capture：

```powershell
npm run verify:h5 -- output/playwright/sign-capture-2026-07-13T15-20-39-356Z.json
```

验证器只执行以下操作：

1. 从 capture 读取 `/pack/h5/` 的原始 query 和 form body。
2. 仅移除旧 `a_bogus`，不解析、重排或重新编码其他字段。
3. 用持久 signer 生成新签名。
4. 不带 Cookie 或 Authorization 发出 POST。
5. 要求 HTTP 200、JSON `status_code=0`，并确认响应商品 ID 与请求一致。

输出不会显示 `verifyFp`、body、Cookie、Authorization 或签名值。capture 本身可能含会话上下文，应按敏感调试文件保存。

## 待处理的原生链

2026-07-14 在 MuMu Android 15 中已确认：

- 桌面显示名”抖音商城”对应 `com.ss.android.ugc.livelite`，版本 `39.5.0`
- Golden Goose 官方商品详情是原生 `ProductDetailActivity`
- Playwright Android 返回 `webViews: []`
- 分享操作触发 `BdTuringVerifyActivity` 二次验证，未自动绕过

原生链 Hook 方案已实施，详见 [NATIVE_CHAIN.md](NATIVE_CHAIN.md)。概要：

| 问题 | 解决方案 | 脚本 |
|---|---|---|
| API 端点不同 (`/pack/` vs `/pack/h5/`) | Hook Retrofit2 `Request$Builder.build()` | `hook/native-chain.js` |
| 网络栈 Retrofit2 + TTNet/Cronet | 多层 Hook：Retrofit2 → OkHttp → Cronet native | `hook/native-chain.js` |
| Frida 17 `Java is not defined` | 使用 `frida-java-bridge` + `frida-compile` 打包 | `npm run build:native-chain` |
| ARM64 MetaSec 在 emulated realm | dual-realm attach (native + emulated) | `hook/native-probe.py --dual-realm` |
| BdTuringVerifyActivity 二次验证 | Hook `onCreate()` → 立即 `finish()` | `hook/native-chain.js` |

运行：
```powershell
npm run capture:native          # Node.js — 完整 JSON capture
python hook/native-probe.py --dual-realm  # Python — 双 realm 原生探针
```

H5 `a_bogus` 结论不能替代原生 `/pack/` 验证。二者使用不同的签名路径。
