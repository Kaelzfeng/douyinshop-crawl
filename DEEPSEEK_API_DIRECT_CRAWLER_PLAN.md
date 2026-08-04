# 抖音商城 API 直采改造任务书

## 一、项目位置

```text
E:\douyin-golden-goose-crawler
```

## 二、任务目标

把当前“ADB 操作 App UI + Frida 旁路读取响应”的采集流程，改造成：

```text
Node.js 构造搜索请求
→ 必要时通过 Frida RPC 借 App 生成原生签名
→ Node.js 直接发送 HTTP 请求
→ 根据响应 cursor/has_more 自动翻页
→ 解析并保存商品数据
→ 调用官方短链 API 生成 v.douyin.com 链接
→ 写入 SQLite 和 CSV
```

最终生产采集过程中禁止依赖：

- `adb shell input text`
- `adb shell input tap`
- `adb shell input swipe`
- UIAutomator 页面解析
- 打开搜索页、商品详情页或店铺页
- 点击分享、复制链接
- Playwright 浏览器采集

允许模拟器继续运行，但只能作为登录会话和 Frida 签名机使用。第一阶段不要求立刻移除模拟器。

## 三、当前真实状态

### 已完成

1. Frida 可以从 App 搜索响应中提取：
   - `product_id`
   - 商品名称
   - 店铺名称
   - 价格
   - 销量
2. 已有 SQLite、去重、事件记录和 CSV 导出。
3. 官方短链 API 已经验证成功，历史运行记录为 25/25 成功。
4. 已捕获搜索接口 URL、请求体和部分设备公共参数。
5. 项目已有 Frida、native signer、H5 `a_bogus` 和网络 Hook 研究代码。

### 尚未完成

1. 搜索接口尚未证明可以由 Node/Python 脱离 UI 直接重放。
2. 尚未完整捕获请求发出前的最终 headers、Cookie 和签名字段。
3. 尚未实现 `cursor → next_cursor → has_more` 的纯 HTTP 翻页。
4. 当前所谓 Android-only 仍由 ADB 操作 UI，不是真正的纯 API 采集。

## 四、已经确认的接口

### 4.1 商品搜索接口

日志中捕获到：

```text
POST https://ecom.ecombdapi.com/aweme/v3/shop/search/aggregate/shopping/stream/
```

已观察到请求体包含：

```text
cursor=0
count=8
keyword=ggdb
query_correct_type=1
search_channel=search_order_center
search_source=normal_search
search_scene=douyin_search
search_session_id=<动态值>
shown_count=0
```

URL 公共参数中已观察到：

```text
iid
device_id
aid=561124
app_name=douyinecommerce
version_code=390600
version_name=39.6.0
device_platform=android
os_api=35
device_type=MI 5s
device_brand=Xiaomi
cdid
_rticket
ts
klink_egdi
```

不要硬编码整条旧 URL。必须区分静态设备参数和每次请求需要更新的动态参数。

### 4.2 官方短链接口

```text
POST https://lf.snssdk.com/shorten/
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
User-Agent: com.ss.android.ugc.livelite/390600
```

请求体：

```text
targets=https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=<product_id>
belong=douyinecommerce
persist=1
```

读取响应：

```text
data[0].short_url
```

参考实现：

```text
tools/generate_official_shortlink_table.py
```

该接口已经可用，不要重新设计短链生成方案，也不要再使用 UI 点击分享。

## 五、关键代码和资料

优先阅读：

```text
src/android-only-cli.mjs
android-only-collector/agent.js
android-only-collector/events.mjs
android-only-collector/sqlite-store.mjs
src/frida-sign-rpc.mjs
hook/sign-rpc.js
hook/native-signer-agent.js
native_sign.py
NATIVE_SIGNER.md
NATIVE_CHAIN.md
SIGNING.md
STORE_BFF_REQUEST_FORMAT.md
reverse/PURE_REVERSE_PLAN.md
tools/generate_official_shortlink_table.py
tools/crawl_store_products_http.py
output/android-only-events.jsonl
output/android-only.sqlite
```

特别注意：日志中的 `stage=detail_response` 并不一定代表商品详情请求，不少商品实际来自搜索聚合接口响应。

## 六、实施阶段

### 阶段 0：保护现场

在改代码之前：

1. 执行 `git status --short`。
2. 不得覆盖、撤销或格式化用户已有修改。
3. 复制一份用于分析的请求样本，不要修改原始 JSONL 和 SQLite。
4. 所有新实验输出写到 `output/direct-search/`。

### 阶段 1：捕获一条完整的最终搜索请求

目标是拿到网络栈真正发出前的：

- HTTP method
- 完整 URL
- 原始 POST body 字节
- 全部 headers
- Cookie
- 时间戳
- 对应响应 body

重点检查：

```text
X-SS-STUB
X-Gorgon
X-Argus
X-Khronos
X-Ladon
X-Neptune
X-Typhon
X-Medusa
Cookie
```

不要假设所有字段都必需。必须通过逐项实验确认。

优先在 Retrofit/TTNet/Cronet 最终发送边界抓取，而不是只在 Request.Builder 早期阶段抓取。早期 URL 和 headers 可能还没有完成签名。

阶段产物：

```text
output/direct-search/request-sample.json
output/direct-search/response-sample.json
output/direct-search/header-classification.md
```

`header-classification.md` 必须把字段分为：

- 静态设备字段
- 会话字段
- 每请求动态字段
- body 派生签名
- 暂时未知

### 阶段 2：原样重放第一页

先不要修改 cursor，也不要重构。

使用捕获到的完整请求，立即在 Node.js 中原样重放：

```text
捕获请求 → 5 秒内重放 → HTTP 200 → 响应包含商品
```

新建建议文件：

```text
tools/replay-search-request.mjs
```

必须输出：

- HTTP 状态码
- 服务端业务状态码
- 响应长度
- 商品数量
- product_id 示例
- 服务端错误正文前 500 字符

若原样重放失败，不得直接进入翻页实现。先定位是 Cookie、动态时间参数还是签名失效。

### 阶段 3：确定签名最小集合

按控制变量测试：

1. 只更新时间戳，其他保持不变。
2. 修改 `cursor`，保持 body 长度相近。
3. 修改 `keyword`。
4. 修改 body 后重新计算 `X-SS-STUB`。
5. 分别移除可疑签名 header，记录服务端响应。

如果修改 body 后旧签名失效，则接入 Frida RPC 签名代理。

推荐短期架构：

```text
Node 构造 URL/body
→ Frida RPC signSearchRequest(url, body, baseHeaders)
→ App 内调用现有签名链
→ 返回最终 headers
→ Node fetch/undici 发送请求
```

项目已有部分 MetaSec signer，但不要声称它已经覆盖完整搜索签名。必须用真实请求验证。

建议 RPC 返回：

```json
{
  "url": "最终URL",
  "headers": {
    "X-SS-STUB": "...",
    "X-Gorgon": "...",
    "X-Argus": "...",
    "X-Khronos": "...",
    "X-Ladon": "...",
    "X-Neptune": "..."
  },
  "body_sha256": "...",
  "signed_at": 0
}
```

如果 App 内签名链只能同时发送请求，不能只返回 headers，则实现“App 内请求代理 RPC”：Node 把 URL/body 传入 App，App 发请求并把响应 body 返回 Node。这仍然属于无 UI API 采集，可以作为第一版交付。

### 阶段 4：实现 cursor 翻页

只有阶段 2、3 成功后才能进行。

新建建议模块：

```text
src/direct-search-client.mjs
```

接口建议：

```js
const client = await createDirectSearchClient(options);

const page = await client.searchPage({
  keyword: 'ggdb',
  cursor: 0,
  count: 20,
  searchSessionId,
});
```

标准化返回：

```js
{
  products: [],
  cursor: '0',
  nextCursor: '...',
  hasMore: true,
  rawResponse: {},
}
```

响应中的 cursor 字段不能凭经验猜测。必须从真实响应定位并记录 JSON path。

循环终止条件：

1. `has_more === false`；或
2. `next_cursor` 为空；或
3. `next_cursor === current_cursor`；或
4. 连续 3 页没有新增 `product_id`；或
5. 达到显式安全页数上限。

必须按 `product_id` 去重，并保存每页原始响应，便于追查漏数。

### 阶段 5：复用现有解析与数据库

不要重新写一套互不兼容的商品结构。最终字段为：

```text
product_id
product_name
shop_name
price
sales
share_url
```

优先复用：

```text
android-only-collector/events.mjs
android-only-collector/sqlite-store.mjs
android-only-collector/export.mjs
```

如果现有事件转换器强依赖 Frida event envelope，可以增加清晰的纯函数：

```js
parseSearchResponse(rawResponse)
```

然后将结果转换为现有 `product_found` 事件或直接调用数据库的显式 upsert API。

数据来源必须记录为：

```text
source = direct_search_api
stage = search_response
```

不要继续把搜索响应标成 `detail_response`。

### 阶段 6：批量生成短链

对数据库中没有 `product_shares` 的商品调用短链 API。

要求：

- 默认并发 3
- 请求间隔 500 ms
- 超时 15 秒
- 最多重试 3 次
- 指数退避
- 已存在短链不得覆盖
- API 失败不得中止整个任务
- 失败写入 `output/direct-search/shorten-failures.jsonl`
- 使用 `product_id` 明确关联，不使用时间窗口猜测

数据库关联信息：

```text
source = direct_shorten
confidence = 1
correlation_reason = direct_shorten_product_id
```

### 阶段 7：增加独立 CLI

不要直接删除原 UI 采集器。增加独立入口：

```text
src/direct-search-cli.mjs
```

命令建议：

```powershell
node src/direct-search-cli.mjs `
  --keywords ggdb,小脏鞋 `
  --all `
  --count 20 `
  --db output/direct-search/products.sqlite `
  --output output/direct-search/products.csv `
  --shorten-workers 3 `
  --shorten-delay-ms 500
```

建议 npm script：

```json
{
  "start:direct-api": "node src/direct-search-cli.mjs"
}
```

`--all` 表示翻到服务端 `has_more=false`，不是 UI 滑到没有变化。

## 七、必须实现的测试

### 单元测试

1. 搜索响应商品字段解析。
2. cursor 和 has_more 解析。
3. 重复 product_id 去重。
4. cursor 不变化时终止。
5. 连续空页时终止。
6. HTTP 非 200 错误。
7. 业务状态码错误。
8. 签名 RPC 超时和重连。
9. 短链正常响应。
10. 短链空 data、非法 URL、非 200、重试。
11. SQLite 断点续跑。
12. 已有 share_url 不覆盖。

### 集成测试

使用真实账号和设备完成：

```text
关键词 ggdb：连续直连 10 页
关键词 小脏鞋：连续直连 10 页
```

必须验证：

- 不执行任何 `adb input` 命令。
- 每页都有明确 cursor 记录。
- 第二页与第一页存在不同商品。
- 10 页内没有错误地反复请求 cursor=0。
- CSV 中短链可跳转到对应 product_id。

## 八、硬性验收标准

以下条件全部满足，才能称为“API 直采完成”：

1. 搜索和翻页全程不使用 ADB UI 操作。
2. Node 或 App 内请求代理可以主动请求任意 keyword/cursor。
3. 连续成功翻页至少 10 页。
4. 可以自动读取 `next_cursor`，而不是硬编码页码。
5. App 停留在任意页面都不影响采集。
6. 短链通过 `/shorten/` API 批量生成。
7. 进程中断后可以从 SQLite 继续。
8. 输出六字段 CSV。

以下情况不得宣称完成：

- 只用 Frida 读取由 UI 触发的响应。
- 仍需 ADB 搜索、滑动或点击商品。
- 只成功重放 cursor=0 一页。
- 修改 cursor 后签名失败。
- 用缓存响应冒充实时请求。
- 只生成短链但没有打通搜索翻页。

## 九、诊断输出要求

每个请求至少记录：

```json
{
  "keyword": "ggdb",
  "cursor": "0",
  "next_cursor": "...",
  "has_more": true,
  "http_status": 200,
  "business_status": 0,
  "response_bytes": 0,
  "products_in_page": 0,
  "new_products": 0,
  "sign_mode": "frida_rpc|app_proxy|local",
  "elapsed_ms": 0
}
```

禁止在日志中输出完整 Cookie、Token、签名密钥或账号凭据。调试样本中的敏感 headers 必须脱敏。

## 十、优先级和止损规则

优先级：

```text
完整最终请求捕获
> 原样重放成功
> 修改 cursor 后签名成功
> 连续翻页
> 接数据库和短链
> 性能优化
```

止损规则：

1. 原样请求都不能重放时，不要继续写大规模架构代码。
2. 两小时内无法实现 header-only signer 时，改做 App 内请求代理 RPC。
3. 不要回退到 UI 滑动并把它称为 API 采集。
4. 每完成一个阶段都保留可运行验证命令和原始证据。

## 十一、要求 DeepSeek 最终报告的内容

完成后必须明确报告：

1. 实际使用的请求模式：Node HTTP、Frida header signer 或 App 内请求代理。
2. 搜索接口最终必需的 headers 和签名字段。
3. cursor 与 has_more 的真实 JSON path。
4. 连续翻页测试页数和商品数量。
5. 每分钟商品吞吐量。
6. 是否执行过任何 ADB UI 命令。
7. 测试命令和结果。
8. 修改文件列表。
9. 尚未解决的风险。

## 十二、可直接发给 DeepSeek 的执行指令

```text
请在 E:\douyin-golden-goose-crawler 中按照
DEEPSEEK_API_DIRECT_CRAWLER_PLAN.md 完成 API 直采改造。

不要只给建议，必须先读取现有代码和 output/android-only-events.jsonl，
按阶段提供可运行实现与验证证据。不要覆盖用户已有修改。

最重要的验收标准：搜索和翻页过程中不得执行 adb input text、tap、swipe，
必须主动请求 /aweme/v3/shop/search/aggregate/shopping/stream/，读取真实
next_cursor/has_more 并连续成功翻页至少 10 页。

如果无法在 Node 端直接生成完整原生签名，优先实现 Frida RPC 签名代理；
如果 header-only signer 暂时无法完成，则实现 App 内请求代理 RPC，但仍然禁止 UI 操作。

短链直接复用 tools/generate_official_shortlink_table.py 已验证的
POST https://lf.snssdk.com/shorten/ 方案。

不要把“Frida 读取 UI 触发的响应”称为纯 API。只有通过上述验收后才能报告完成。
```
