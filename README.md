# 抖音商城通用关键词采集器

通过 **MuMu + 已登录抖音商城 + Frida**，按**任意关键词**调用商城搜索 API，采集商品字段并生成官方短链，导出 CSV。

不绑定特定品类（不再默认 `ggdb` / `小脏鞋`）。关键词必须由你指定。

输出字段：

```text
product_id,product_name,shop_name,price,sales,share_url
```

> 仅供本地学习与研究。请勿用于未授权的生产爬取或商业用途。

## 数据链路

```text
你指定的关键词
  -> 签名模式（见下）
  -> 搜索聚合 API 翻页
  -> SQLite 去重
  -> 官方 POST /shorten/ 补短链
  -> products.csv
```

无 ADB 点搜索/滚动/分享。

### 签名模式（纯逆向路径）

| `--sign-mode` | 行为 | 依赖 |
|---------------|------|------|
| `app_proxy`（默认） | Frida 在 App 内发 HTTP + 签名 | MuMu + 登录 + Frida |
| `frida_rpc` | Frida 只签名，Node `fetch` 出站 | 同上 + `output/session.json` Cookie |
| `local` | Unidbg MetaSec 侧车签名，无 Frida | `session.json` + `unidbg-metasec` 服务 |

```powershell
# 从 App 导出 Cookie / 设备参数（L2/L3 底座）
npm run build:direct-search
npm run session:export

# 对照 app_proxy vs frida_rpc
npm run search:compare -- --query 运动鞋

# 生产采集（最稳）
npm start -- --query 运动鞋 --all --sign-mode app_proxy

# L2 实验
npm start -- --query 运动鞋 --single-page --sign-mode frida_rpc --dump-wire
```

## 环境

| 项目 | 要求 |
|------|------|
| 系统 | Windows 10 / 11 |
| Node.js | ≥ 22（内置 `node:sqlite`） |
| 模拟器 | MuMu，ADB 默认 `emulator-5554` |
| App | `com.ss.android.ugc.livelite`，已登录 |
| Frida | `frida-server` + 本机 `127.0.0.1:27042` 转发 |

```powershell
npm install
npm run build:direct-search
adb connect 127.0.0.1:16384
adb -s emulator-5554 root
adb -s emulator-5554 forward tcp:27042 tcp:27042
```

## 用法

**必须提供关键词**，任选一种：

```powershell
# 单个关键词
npm start -- --query 运动鞋 --all

# 多个关键词（逗号分隔）
npm start -- --keywords 帆布鞋,板鞋,老爹鞋 --all

# 从文件读取（一行一个，也可用逗号）
npm start -- --keywords-file keywords.txt --all

# 环境变量
$env:CRAWL_KEYWORDS = "关键词A,关键词B"
npm start -- --all
```

常用选项：

| 参数 | 说明 |
|------|------|
| `--all` | 翻页直到 `has_more=false` |
| `--max-pages <n>` | 每关键词最多页数（默认 50） |
| `--count <n>` | 每页条数（默认 20，最大 50） |
| `--no-shorten` | 不生成短链 |
| `--single-page` | 只采一页（调试） |
| `--output <path>` | CSV 路径 |
| `--db <path>` | SQLite 路径 |
| `--serial <id>` | 设备 serial |
| `--sign-mode <m>` | `app_proxy` / `frida_rpc` / `local` |
| `--session <path>` | 会话 JSON（默认 `output/session.json`） |
| `--device-params <path>` | 设备参数 JSON |
| `--dump-wire` | 首屏后导出 wire headers |
| `--enrich` | 缺字段时 H5 补全（实验） |
| `-h, --help` | 帮助 |

### 纯逆向相关模块

| 路径 | 作用 |
|------|------|
| `src/session.mjs` | Cookie/token 会话 |
| `src/device-params.mjs` | 设备 query 参数 |
| `src/native-sign.mjs` | Unidbg 侧车客户端 |
| `src/a-bogus-vm.mjs` | 无浏览器 a_bogus（实验） |
| `tools/export-app-session.mjs` | Frida 导出会话 |
| `tools/compare-search-modes.mjs` | L1/L2 对照 |
| `tools/dump-sign-pairs.mjs` | 签名 I/O 样本 |
| `unidbg-metasec/` | 本地 MetaSec（脚手架） |

```powershell
npm start -- --help
```

## 输出

默认目录：`output/direct-search/`

| 文件 | 内容 |
|------|------|
| `products.sqlite` | 主库 |
| `products.csv` | 全部商品 |
| `products.complete.csv` | 六字段齐全的行 |
| `summary.json` | 运行统计 |
| `raw/<keyword>/` | 原始搜索响应 |

## 其他入口（可选）

| 命令 | 说明 |
|------|------|
| `npm start` | **默认**：通用 Direct Search API |
| `npm run start:android-ui` | 旧 Android UI 采集（仍偏专用脚本） |
| `npm run start:legacy` | 更早的 Playwright / semi / shop 流水线 |

## 重要说明

1. 不要对抖音使用 `am force-stop`，需要恢复时用软启动。
2. 修改 `hook/direct-search-agent.js` 后执行 `npm run build:direct-search`。
3. 搜索卡片可能缺销量/店名；`products.complete.csv` 只含完整行。
4. 需要设备保持登录；掉登录或验证码需在 MuMu 中手动处理。
