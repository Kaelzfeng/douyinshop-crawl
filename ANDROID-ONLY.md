# Android-only 运行说明

## 采集范围

默认入口 `src/android-only-cli.mjs` 固定搜索 `ggdb` 和 `小脏鞋`，遍历商城搜索结果及店铺结果。商品字段来自 Frida 捕获的 Android Lynx/XBridge 数据：

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

## 官方短链

默认不再执行“打开详情 -> 点击分享 -> 复制链接”。商品卡片采集结束后，`src/official-shortener.mjs` 使用 product_id 构造：

```text
https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=<product_id>
```

并调用：

```http
POST https://lf.snssdk.com/shorten/
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
User-Agent: com.ss.android.ugc.livelite/390600

targets=<商品详情URL>&belong=douyinecommerce&persist=1
```

仅接受符合 `https://v.douyin.com/.../` 格式的 `data[0].short_url`。

默认策略：

- 并发 3。
- 单请求超时 15 秒。
- 最多重试 3 次。
- 500ms 为请求间隔及指数退避基数。
- 已有关联直接跳过，不覆盖旧 `share_url`。
- 单商品失败写入 `output/shorten-failures.jsonl`，整批继续。
- 成功缓存写入 `output/official-shorten-cache.jsonl`，中断后可复用。

SQLite 关联值：

```text
confidence = 1
correlation_reason = direct_shorten_product_id
source = direct_shorten
```

## 启动

```powershell
cd E:\douyin-golden-goose-crawler
npm start -- --fresh --target 0 --shorten-workers 3 --shorten-delay-ms 500
```

继续未完成任务：

```powershell
npm start -- --target 0 --shorten-workers 3 --shorten-delay-ms 500
```

三小时限时续跑（预留最后 10 分钟生成短链和 CSV）：

```powershell
npm start -- --target 825 --time-budget-minutes 180 --shorten-workers 3 --shorten-delay-ms 500
```

可选模式：

```powershell
# 不调用短链接口，也不进行 UI 分享
npm start -- --no-short-link --target 0

# API 最终失败项才使用旧 UI 分享兜底
npm start -- --target 0 --share-ui-fallback

# 仅抓商品卡片字段
npm start -- --collect-only --target 0
```

## 输出与查询

默认文件：

```text
output/android-only.sqlite
output/android-only-events.jsonl
output/products.csv
output/android-only-summary.json
output/official-shorten-cache.jsonl
output/shorten-failures.jsonl
```

检查直接关联：

```powershell
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('output/android-only.sqlite',{readOnly:true}); console.table(db.prepare(\"SELECT product_id,share_url,confidence,correlation_reason,source FROM product_shares ORDER BY last_seen_ts DESC LIMIT 20\").all()); db.close();"
```

导出 CSV：

```powershell
npm run android:export
```

## 验收

```powershell
npm test
```

运行前确认：

```powershell
C:\ReverseLab\tools\platform-tools\adb.exe -s emulator-5554 get-state
C:\ReverseLab\tools\platform-tools\adb.exe -s emulator-5554 forward tcp:27042 tcp:27042
C:\ReverseLab\tools\platform-tools\adb.exe -s emulator-5554 shell pidof com.ss.android.ugc.livelite
```

验证码出现时程序会保存截图、强制结束 App 并重新启动当前阶段；不会尝试破解验证码。登录失效仍需恢复有效登录状态。
