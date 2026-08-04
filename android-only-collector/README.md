# Android-only collector

独立的数据源模块：通过 MuMu 上运行的 `com.ss.android.ugc.livelite` 进程接入 Frida，输出结构化 JSON 事件，并将事件和商品—分享链接关联写入 SQLite。

该目录不依赖、不修改 `src/`、`hook/`、Playwright 或现有 crawler。旧采集流程仍按原方式运行。

## 环境

- Node.js 22+（使用内置 `node:sqlite`，无需新增 npm 依赖）
- Node 侧 `frida` 包从当前工作目录、`DOUYIN_CRAWLER_ROOT` 或现有工作区 `E:\douyin-golden-goose-crawler` 的 `node_modules` 解析；如从其他目录运行，请先设置 `DOUYIN_CRAWLER_ROOT`
- MuMu / ADB 设备已启动，抖音商城已登录并运行
- Frida server 已运行，默认远程地址 `127.0.0.1:27042`

## 启动

首次运行或修改 `agent.js` 后，先生成 Frida bundle：

```powershell
npx.cmd frida-compile android-only-collector/agent.js `
  -o android-only-collector/agent.bundle.js -B iife -S
```

先用 ADB 建立 MuMu 与 Frida server 的通道，并确认目标进程已经存在：

```powershell
adb connect 127.0.0.1:16384
adb -s emulator-5554 forward tcp:27042 tcp:27042
adb -s emulator-5554 shell pidof com.ss.android.ugc.livelite
```

不要用 `am force-stop` 重启抖音；需要恢复进程时使用项目既有的软启动流程。

```powershell
node android-only-collector/collector.mjs `
  --frida-host 127.0.0.1:27042 `
  --db output/android-only.sqlite `
  --events output/android-only-events.jsonl
```

也可以直接指定 PID：

```powershell
node android-only-collector/collector.mjs --pid 12345
```

程序会持续 attach，直到 `Ctrl+C`。标准输出和 JSONL 文件每行都是一个 JSON 对象，不输出普通日志。

## Runtime debug

仅检查商品详情请求/响应路径时，使用 debug 模式：

```powershell
node android-only-collector/collector.mjs `
  --debug `
  --frida-host 127.0.0.1:27042 `
  --events runtime-debug.jsonl `
  --db output/runtime-debug.sqlite
```

该模式只记录 `Request.Builder.url`、`Response.getUrl`、`ResponseBody.string` 长度、`Gson.fromJson` 类名和 `TypeAdapter.fromJson` 类名，不记录响应正文，也不生成 `product_found`。

## 事件

Frida 原始事件统一为 `event: "frida_event"`，并由 Node 侧转换为：

- `product_found`：从商品 deeplink、`/ecom/product/detail/pack/async`、`/promotion/pack/` 请求、Retrofit Response Body、TypedByteArray 或 Gson 商品 JSON 中识别到商品。
- `share_found`：从 `v.douyin.com` URL、`ShareLinkManager.LIZLLL`、Intent 或剪贴板文本中识别到分享链接。
- `product_share_linked`：根据显式 `product_id` 或默认 60 秒时间窗口完成关联。

事件核心字段：

```json
{
  "schema_version": 1,
  "event_id": "uuid",
  "run_id": "uuid",
  "ts": 0,
  "event": "product_found|share_found|product_share_linked",
  "stage": "detail_request|detail_response|clipboard|share_link|correlated",
  "product_id": "...",
  "promotion_id": "...",
  "share_url": "https://v.douyin.com/.../",
  "title": "...",
  "url": "...",
  "source": "frida|collector"
}
```

## SQLite

数据库包含：

- `events`：完整 JSON 事件流
- `products`：按 `product_id` 聚合的商品信息
- `shares`：按 `share_url` 聚合的分享链接
- `product_shares`：`product_id` 与 `share_url` 的关联及置信度

示例查询：

```sql
SELECT product_id, share_url, confidence, correlation_reason
FROM product_shares
ORDER BY last_seen_ts DESC;
```

## 测试

```powershell
node --check android-only-collector/collector.mjs
node --check android-only-collector/agent.js
node --check android-only-collector/events.mjs
node --check android-only-collector/sqlite-store.mjs
node android-only-collector/collector.mjs --help
```

## Stable runner and export

For a reconnecting long-running process, use the bundled Android agent:

```powershell
node android-only-collector/collector-runner.mjs `
  --frida-host 127.0.0.1:27042 `
  --package com.ss.android.ugc.livelite `
  --db output/android-only.sqlite `
  --events output/android-only-events.jsonl
```

The runner observes `product_found` and `product_share_linked`, persists them
to SQLite, retries after a Frida session loss, and prints collection statistics
on shutdown. Failed SQLite events are kept in
`output/android-only.sqlite.failed.jsonl`.

Export the final six fields:

```powershell
node android-only-collector/export.mjs `
  --db output/android-only.sqlite `
  --output products.csv
```
