# Android-only collector E2E test

目标：在 MuMu + ADB + Frida 中完成：

```text
商品详情请求
  -> Retrofit Response.getBody / TypedByteArray / Gson 商品 JSON
  -> product_found
  -> ClipboardManager.setPrimaryClip(v.douyin.com)
  -> share_found
  -> product_share_linked
  -> SQLite product_shares
```

## Long-running runner and CSV export

Run these commands from the project directory:

```powershell
Set-Location C:\ReverseLab\projects\douyin-mall-39.6.0-analysis

$adb = 'C:\ReverseLab\tools\platform-tools\adb.exe'
$serial = 'emulator-5554'  # replace with the serial shown by adb devices
& $adb devices
& $adb -s $serial forward tcp:27042 tcp:27042
& $adb -s $serial shell monkey -p com.ss.android.ugc.livelite 1

node .\android-only-collector\collector-runner.mjs `
  --frida-host 127.0.0.1:27042 `
  --package com.ss.android.ugc.livelite `
  --db output/android-only.sqlite `
  --events output/android-only-events.jsonl
```

While the runner is attached:

1. Open Douyin Mall.
2. Search for a product, for example `ggdb`.
3. Scroll the product list to trigger Lynx card data.
4. Open a product and use Share to trigger `share_found`.
5. Stop with `Ctrl+C`; the runner prints collection statistics.

Verify SQLite:

```powershell
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('output/android-only.sqlite'); console.table(db.prepare('SELECT p.product_id, COALESCE(NULLIF(p.product_name, ''''), p.title) AS product_name, p.shop_name, p.price, p.sales, s.share_url FROM products p LEFT JOIN product_shares ps ON ps.product_id = p.product_id LEFT JOIN shares s ON s.share_url = ps.share_url ORDER BY p.last_seen_ts DESC').all()); db.close();"
```

Export the six final fields to CSV:

```powershell
node .\android-only-collector\export.mjs `
  --db output/android-only.sqlite `
  --output products.csv
```

If SQLite is temporarily locked or an event cannot be persisted, the collector
continues and writes failed records to `output/android-only.sqlite.failed.jsonl`.

`product_found` 以商品详情响应 JSON 为主，不依赖 `sslocal://ec_goods_detail`；URI / Intent 仍作为补充信号保留。

本测试不绕过风控；如出现验证页，只完成账号允许的正常人工验证。

## 1. 环境准备

在仓库目录执行：

```powershell
Set-Location C:\ReverseLab\projects\douyin-mall-39.6.0-analysis

npx.cmd frida-compile android-only-collector/agent.js `
  -o android-only-collector/agent.bundle.js -B iife -S

$adb = 'C:\ReverseLab\tools\platform-tools\adb.exe'
& $adb -s 127.0.0.1:16384 forward tcp:27042 tcp:27042
& $adb -s 127.0.0.1:16384 shell pidof com.ss.android.ugc.livelite
```

如果没有 PID，启动抖音商城后重新检查：

```powershell
& $adb -s 127.0.0.1:16384 shell monkey -p com.ss.android.ugc.livelite 1
```

不要使用 `am force-stop`。

## 2. 启动采集器

使用独立的 E2E 输出文件：

```powershell
node .\android-only-collector\collector.mjs `
  --frida-host 127.0.0.1:27042 `
  --package com.ss.android.ugc.livelite `
  --window-ms 300000 `
  --db output/android-only-e2e.sqlite `
  --events output/android-only-e2e.jsonl
```

保持进程运行，等待输出 `collector_status` / `ready` 后再操作设备。

## 3. 手动操作

在 MuMu 内：

1. 打开抖音商城。
2. 搜索 `ggdb`。
3. 进入一个商品详情页。
4. 点击“分享”。
5. 如出现正常风控验证，完成验证后返回分享流程。

## 4. JSONL 验收

另开 PowerShell 查看三类事件：

```powershell
Get-Content .\output\android-only-e2e.jsonl |
  Select-String '"event":"(product_found|share_found|product_share_linked)"'
```

每类至少应有一条：

```json
{"event":"product_found","product_id":"...","promotion_id":"...","title":"..."}
{"event":"share_found","share_url":"https://v.douyin.com/.../"}
{"event":"product_share_linked","product_id":"...","share_url":"https://v.douyin.com/.../"}
```

## 5. SQLite 验收

使用 Node 内置 SQLite 查询最终关联：

```powershell
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('output/android-only-e2e.sqlite'); console.table(db.prepare('SELECT p.product_id, p.product_name, p.shop_name, p.price, p.sales, s.share_url, ps.confidence, ps.correlation_reason FROM product_shares ps JOIN products p ON p.product_id = ps.product_id JOIN shares s ON s.share_url = ps.share_url ORDER BY ps.last_seen_ts DESC').all()); db.close();"
```

验收记录应包含：

| 字段 | 来源 | 实际值 |
|---|---|---|
| `product_id` | `product_found` / `products` | 手动运行后填写 |
| `promotion_id` | `product_found` / `products` | 手动运行后填写 |
| `title` | `goods_detail.title` / `products` | 手动运行后填写 |
| `share_url` | `share_found` / `shares` | 手动运行后填写 |
| SQLite 关联 | `product_shares` | `product_id → share_url` |

runtime-analysis 中的已知样本可用于比对：

```text
product_id   = 3684801835211817377
promotion_id = 3684801835211817377
title        = Golden Goose女Super Star Sabot亮片半拖脏脏鞋GGDB
share_url    = https://v.douyin.com/oFHP9Ieye8I/
```

## 6. Confirmed 39.6.0 extraction paths

The field layer now uses the confirmed Android card/detail model names:

| Output field | Runtime field/path |
|---|---|
| `product_id` | `track_data.track_common_data.product_id` or `product_id` |
| `promotion_id` | `promotion_id` / `promotion_ids` |
| `title` | `title` or card exposure `real_title` |
| `shop_name` | `shop_info.name` (`CommonData.Product`) or `shop.name` (`ECProductStruct`) |
| `price` | `price.min_price` / `price.max_price`, or card `price_info.show_price` |
| `sales` | `sales`, with card fallback `price_sales_num` / `price_sales_desc` |

The detail `goods_detail` sample confirms `sales`, `min_price`, and `max_price` as direct keys. The raw price unit is preserved from the app response.

The canonical linked JSON is emitted with both `title` (compatibility) and `product_name` (Excel output):

```json
{
  "product_id": "",
  "product_name": "",
  "shop_name": "",
  "price": "",
  "sales": "",
  "share_url": ""
}
```

该样本仅是历史运行记录；E2E 验收以本次 JSONL 和 SQLite 实际输出为准。
