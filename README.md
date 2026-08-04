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
  -> Frida app-proxy（App 内发搜索请求）
  -> 搜索聚合 API 翻页
  -> SQLite 去重
  -> 官方 POST /shorten/ 补短链
  -> products.csv
```

无 ADB 点搜索/滚动/分享。模拟器只提供登录会话与签名环境。

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
| `-h, --help` | 帮助 |

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
