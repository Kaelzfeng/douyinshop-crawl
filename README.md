# 抖音商城 Android-only 商品采集器

基于 **MuMu + ADB + Frida**，从抖音商城 Android App（`com.ss.android.ugc.livelite`）的 Lynx/XBridge 商品卡片采集数据。默认入口**不依赖 Playwright 作为商品数据源**。

固定采集关键词：

- `ggdb`
- `小脏鞋`

输出六字段 CSV（UTF-8 BOM + CRLF）：

```text
product_id,product_name,shop_name,price,sales,share_url
```

> 仅供本地学习、接口分析与逆向研究。请勿用于未授权的生产爬取或商业用途。

## 默认数据链路

```text
MuMu Android App
  -> Frida agent (android-only-collector/agent.bundle.js)
  -> Lynx / Retrofit / OkHttp / Gson 拦截
  -> product_found
  -> SQLite products
  -> 官方 POST /shorten/ 接口
  -> product_share_linked
  -> SQLite shares + product_shares
  -> products.csv
```

短链接**默认不再**通过「打开详情 → 点分享 → 复制剪贴板」获得。采集完成后直接请求：

```http
POST https://lf.snssdk.com/shorten/
```

响应中的 `data[0].short_url` 以 `confidence=1`、`correlation_reason=direct_shorten_product_id`、`source=direct_shorten` 关联到 `product_id`。已有 `share_url` 不会被覆盖。

## 环境要求

| 项目 | 要求 |
|------|------|
| 系统 | Windows 10 / 11 |
| Node.js | **≥ 22**（使用内置 `node:sqlite`） |
| 模拟器 | MuMu，ADB 默认 `emulator-5554`（连接 `127.0.0.1:16384`） |
| 屏幕 | 900×1600 **竖屏**（横屏会破坏搜索 UI） |
| App | `com.ss.android.ugc.livelite` **39.6.0**，已登录 |
| Frida | `frida-server` root 运行，本机转发 `127.0.0.1:27042` |
| 可选 | Python 3（`tools/` 签名验证脚本）、Edge（旧 Playwright 入口） |

安装依赖：

```powershell
npm install
```

编译 Android-only Frida agent（首次或修改 `agent.js` 后必须执行；`*.bundle.js` 不入库）：

```powershell
npm run build:android-agent
```

环境探测与端口转发：

```powershell
adb connect 127.0.0.1:16384
adb -s emulator-5554 root
adb -s emulator-5554 forward tcp:27042 tcp:27042
adb -s emulator-5554 shell pidof com.ss.android.ugc.livelite
npm run probe
```

**切勿**对抖音使用 `am force-stop`（会被计为崩溃）。需要恢复进程时使用项目内的软启动逻辑。

## 全量采集

清理本轮输出并采到结果耗尽：

```powershell
npm start -- --fresh --target 0 --shorten-workers 3 --shorten-delay-ms 500
```

断点续跑（不要加 `--fresh`）：

```powershell
npm start -- --target 0 --shorten-workers 3 --shorten-delay-ms 500
```

限时续跑（例如 3 小时，预留最后约 10 分钟生成短链和 CSV）：

```powershell
npm start -- --target 825 --time-budget-minutes 180 --shorten-workers 3 --shorten-delay-ms 500
```

### 常用参数

| 参数 | 说明 |
|------|------|
| `--target 0` | 不设条数上限，以连续重复/空页结束 |
| `--shorten-workers <n>` | 短链接口并发，默认 3 |
| `--shorten-delay-ms <n>` | 请求间隔与指数退避基数，默认 500ms |
| `--no-short-link` | 禁用官方短链接口 |
| `--share-ui-fallback` | 仅对 API 最终失败的商品启用旧 UI 分享兜底 |
| `--collect-only` | 只采商品卡片，不生成分享链接 |
| `--fresh` | 删除本轮选定输出文件后重跑 |
| `--time-budget-minutes <n>` | 限时采集，提前结束 UI 阶段以完成短链/CSV |
| `--serial <id>` | ADB 设备，默认 `emulator-5554` |
| `--frida-host <host>` | Frida 地址，默认 `127.0.0.1:27042` |

单次短链请求超时 15s，最多重试 3 次（指数退避）。单商品失败不会终止整批任务。

查看全部参数：

```powershell
npm start -- --help
```

## 输出文件

| 文件 | 内容 |
|------|------|
| `output/android-only.sqlite` | SQLite 主库 |
| `output/android-only-events.jsonl` | Frida 结构化事件 |
| `output/products.csv` | 六字段完整商品（一商品一行） |
| `output/android-only-summary.json` | 采集与缺字段统计 |
| `output/official-shorten-cache.jsonl` | product_id → 官方短链断点缓存 |
| `output/shorten-failures.jsonl` | 短链最终失败记录 |

单独从数据库导出 CSV：

```powershell
npm run android:export
```

## 验证与测试

```powershell
npm test
```

## 登录与验证码

发现验证码页时会保存诊断截图、结束当前 App 会话、软重启并重试当前阶段；**不会**自动识别或破解验证码。登录失效时请先在 MuMu 中手动恢复登录。

## 其他入口（可选）

| 命令 | 说明 |
|------|------|
| `npm start` / `npm run android:collect` | **默认**：Android-only Frida 采集 + 官方短链 |
| `npm run start:direct-api` | Direct search / API 相关 CLI |
| `npm run start:legacy` | 旧 Playwright + 分享点击流水线（`src/cli.mjs`） |
| `node run-semi-xiaozangxie-ggdb.mjs` | 旧 semi 模式（Frida 拦截、不点分享） |

旧 crawler、hooks 与 Playwright 代码仍保留。旧入口参数示例：

```powershell
npm run start:legacy -- --semi --all --fresh
npm run start:legacy -- --shop-tab --query 小脏鞋
npm run start:legacy -- --direct --input links.txt --limit 50
```

## 项目结构（精简）

```text
src/
  android-only-cli.mjs      # 默认 CLI 入口
  official-shortener.mjs    # 官方 /shorten/ 短链
  app-health.mjs            # 软重启 / 存活检测 / 商品间冷却
  cli.mjs                   # 旧多模式入口 (start:legacy)
  semi-crawl.mjs / ...      # 旧采集模式
android-only-collector/
  agent.js                  # Frida hook 源码
  collector.mjs             # attach + 事件入库
  export.mjs                # SQLite → CSV
  sqlite-store.mjs
hook/                       # 各类 Frida agent / 签名 RPC
tools/                      # 签名服务、验证、诊断脚本
test/                       # Node + Python 测试
reverse/                    # 逆向笔记与签名相关材料（大样本已忽略）
ANDROID-ONLY.md             # Android-only 运行细则
```

## npm scripts

```text
npm start                 # Android-only 全流程
npm run android:collect   # 同上
npm run android:export    # 导出 CSV
npm run build:android-agent
npm run build:direct-search
npm run build:bypass
npm run build:webview-agent
npm run build:native-chain
npm run build:native-signer
npm run probe
npm test
npm run start:legacy
npm run start:direct-api
```

## 重要约束

1. **禁止 `am force-stop`** — 使用软重启，避免被判定多次崩溃。
2. **竖屏强制** — `adb shell wm size 900x1600`。
3. **中文关键词**在代码中使用 Unicode 转义，避免编码损坏。
4. **CSV** 始终带 UTF-8 BOM，换行使用 CRLF。
5. **Frida bundle 必须编译后使用**；修改 `agent.js` / `hook/*.js` 后重新 `frida-compile`。
6. MuMu user build（`ro.debuggable=0`）下 Frida 需 `adb root` + attach，或使用 Gadget 注入。

## 相关文档

| 文档 | 内容 |
|------|------|
| [ANDROID-ONLY.md](./ANDROID-ONLY.md) | Android-only 运行说明与短链策略 |
| [android-only-collector/README.md](./android-only-collector/README.md) | 独立 collector 模块说明 |
| [SIGNING.md](./SIGNING.md) | H5 a_bogus 签名 |
| [NATIVE_CHAIN.md](./NATIVE_CHAIN.md) / [NATIVE_SIGNER.md](./NATIVE_SIGNER.md) | Native 签名链路 |
| [reverse/PURE_REVERSE_PLAN.md](./reverse/PURE_REVERSE_PLAN.md) | 纯 HTTP 逆向路线图 |
| [HANDoFF.md](./HANDoFF.md) | 环境速查与排障手记 |
