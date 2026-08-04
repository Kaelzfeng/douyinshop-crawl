# Android-only collector production test

## 1. 环境

- App：抖音商城 39.6.0
- Package：`com.ss.android.ugc.livelite`
- ADB serial：`emulator-5554`
- Frida：17.16.1
- Frida server：`127.0.0.1:27042`
- Node：22.x
- Agent：`android-only-collector/agent.bundle.js`
- 测试日期：2026-07-20

## 2. 启动命令

```powershell
$adb = 'C:\ReverseLab\tools\platform-tools\adb.exe'
& $adb devices
& $adb -s emulator-5554 forward tcp:27042 tcp:27042

node android-only-collector/collector-runner.mjs `
  --frida-host 127.0.0.1:27042 `
  --package com.ss.android.ugc.livelite `
  --db output/android-only.sqlite `
  --events output/android-only-events.jsonl
```

CSV 导出：

```powershell
node android-only-collector/export.mjs `
  --db output/android-only.sqlite `
  --output products.csv
```

## 3. 测试步骤

1. 启动模拟器并确认 `adb devices` 显示 `emulator-5554 device`。
2. 建立 `27042` 端口转发。
3. 启动 `collector-runner.mjs`。
4. 打开抖音商城，等待首页完成加载。
5. 搜索测试词，滚动商品列表。
6. 点击商品，确认出现 `product_found`。
7. 点击分享并复制链接，确认出现 `share_found` 和 `product_share_linked`。
8. 停止 runner 后检查 SQLite，再导出 CSV。

## 4. 本次真实验收结果

Frida 连接和 Agent 加载成功：

- `attached pid=35910`
- `agent_loaded=1`
- `ready=1`
- `hooked=23`
- 本次运行批次：`7e07bd3e-1044-4237-9b9f-936a6c84b524`

App 在本次环境中一直停留在 `SplashActivity`，无法进入商城搜索页；ADB 日志随后报告该 Activity ANR。因此未能完成“搜索→滚动→分享”的 UI 步骤，也没有本批次的 `share_found` / `product_share_linked`。

不过启动期间已捕获真实商品响应并生成 `product_found`：

```json
{
  "event": "product_found",
  "product_id": "3665229883430283300",
  "product_name": "洁柔便携随身装手帕纸古龙水香4层6片*24包湿水可用面巾纸小包",
  "price": "6.50",
  "shop_name": "",
  "sales": "",
  "share_url": ""
}
```

本批次统计：

| 指标 | 结果 |
|---|---:|
| `product_found` 事件 | 4 |
| 有效商品 ID | 1 |
| 重复事件 | 3 |
| 缺 `product_id` | 0 |
| 缺价格 | 0 |
| `share_found` | 0 |
| `product_share_linked` | 0 |

重复的 4 个 `product_found` 最终只写入一个 `products.product_id` 记录，说明唯一约束和去重链路生效。

CSV 实际样例（`products.csv`）：

本次导出 13 行商品数据，按 `product_id` 一商品一行；同一商品的多条历史分享链接只取最近一次。

```csv
"product_id","product_name","shop_name","price","sales","share_url"
"3665229883430283300","洁柔便携随身装手帕纸古龙水香4层6片*24包湿水可用面巾纸小包","","6.50","",""
```

当前 SQLite 汇总：`products=13`、`shares=5`、`product_shares=7`。其中后两项包含此前已完成的分享关联记录；本次 Splash 阻塞批次没有新增分享事件。

## 5. 常见错误

- `adb devices` 没有目标设备：先启动模拟器，确认 serial 与 `--serial` 一致。
- `Failed to attach`：确认 Frida server 正在设备内监听，并重新执行 `adb forward tcp:27042 tcp:27042`。
- 只有 `attached` 没有 `agent_loaded`：检查 `agent.bundle.js` 路径和 `node --check android-only-collector/agent.bundle.js`。
- 有 `agent_loaded` 但没有商品事件：先让 App 进入商品列表并滚动；当前测试中是 `SplashActivity` ANR，需先恢复 App 页面。
- 只有大量通用 `ecom` 请求：不要把 URL 中的 `iid` 当作商品 ID；当前 agent 已过滤该误报，并要求明确商品 URL/字段。
- 没有 `product_share_linked`：确认复制内容包含 `https://v.douyin.com/`，且先有相同 `product_id` 的 `product_found`。
- SQLite 写入失败：检查 `output/android-only.sqlite.failed.jsonl`，其中保留失败事件供重放/诊断。
