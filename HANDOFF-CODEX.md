# Handoff to Codex — Direct Search API Crawler

## 任务

把 Douyin Mall 采集从 ADB UI 操作改造为纯 API 直采。完整任务书：
`C:\Users\zc bx\Documents\Codex\2026-07-21\ni-b\outputs\DEEPSEEK_API_DIRECT_CRAWLER_PLAN.md`

## 当前状态

**核心通路已验证成功**，Frida app-proxy 方式请求搜索 API 返回 HTTP 200 + status_code:0。

**唯一阻塞项：TTNet 流式响应的 dechunk 逻辑 bug。**

### 已完成

- ✅ Frida RPC 代理：app 内 HttpURLConnection + NetworkParams 签名
- ✅ 搜索接口请求成功（HTTP 200, 1.3MB+ 响应体）
- ✅ 短链 API 已验证（25/25），Node 端直调即可
- ✅ SQLite 存储、CSV 导出、CLI 入口代码已写好
- ✅ 24 个单元测试全部通过
- ✅ Emulator 在线（PID 62982, com.ss.android.ugc.livelite）
- ✅ Git 状态已确认，用户修改受保护

## 阻塞项详情

### TTNet 流式响应格式

响应体不是标准 JSON，而是自定义流式格式：

```
<hex-size>\r\n<data>\r\n<hex-size>\r\n<data>\r\n...0\r\n\r\n
```

**Bug**：`src/direct-search-client.mjs` 的 `dechunkTTNetStream()` 假设每个 chunk data 是一个完整 JSON 文档，但实际上 JSON 文档可以跨 chunk 边界。chunk 2（45KB）的数据在中途开始了一个新的 JSON 对象，该对象延续到 chunk 3。

### 修复方案

在 `src/direct-search-client.mjs` 中修改 `dechunkTTNetStream()`：

1. **先拼接**所有 chunk data 为一个完整字符串
2. **再从拼接后的大字符串中切分** JSON 文档（用 `{` `}` 配对）
3. 逐个 `JSON.parse`

参考实现（已在 `tools/analyze-response.mjs` 中有类似的 JSON 文档切分器）。

### 响应结构（已知）

- Doc 1（~2KB）：`page_data.outer_card_layer.product_preload_list` — product_id + cover_url 列表
- Doc 2（~45KB）：`page_data.feed_layer.sections[0]` — sort_and_filter_section（筛选项 UI）
- Doc 3（~900KB）：`page_data.feed_layer.sections[1+]` — 商品卡片

单个商品卡片格式：
```json
{
  "ProductID": "3755321058031436047",
  "Title": "Golden Goose...",
  "Price": 589600,
  "MaterialContentInfo": "素材id:601,素材内容:SHOPNAME;素材id:546,素材内容:已售500+件;"
}
```

Price 单位是分（÷100）。Shop name 在 MaterialContentInfo 的 `素材id:601` 字段。Sales 在 `素材id:546` 字段。

## 需要修改的文件

### 1. `src/direct-search-client.mjs` — 修复 dechunkTTNetStream()

这是**唯一需要修改的逻辑**。位置在文件开头的 `dechunkTTNetStream` 函数。

修复后函数签名不变，仍然是 `(raw: string) => Array<object>`。

修复后 cursor/has_more 字段应该能从 Doc 2+3 中解析出来。

### 2. 其他文件状态

| 文件 | 状态 | 说明 |
|------|------|------|
| `hook/direct-search-agent.js` | ✅ | Frida RPC agent 源码 |
| `hook/direct-search-agent.bundle.js` | ✅ | 已编译，修改源码后需重编译 |
| `src/direct-search-client.mjs` | ⚠️ | dechunker 需修复 |
| `src/direct-search-cli.mjs` | ✅ | CLI（搜索→翻页→SQLite→短链→CSV） |
| `src/official-shortener.mjs` | ✅ | 短链 API |
| `test/direct-search.test.mjs` | ✅ | 24 pass / 0 fail |
| `package.json` | ✅ | 已添加 `start:direct-api` 和 `build:direct-search` |

## 调试素材

已保存的原始响应（用于离线调试 dechunker，无需模拟器）：
- `output/direct-search/debug-raw.txt` — 最新完整原始响应（1.3MB）
- `output/direct-search/raw-response.txt` — 之前的捕获

## 验证步骤（修复 dechunker 后按顺序执行）

```bash
# 1. 调试：确认能解析出商品和 cursor/has_more
node tools/quick-debug.mjs

# 2. 翻页验证：至少 3 页不同商品
node tools/test-pagination.mjs

# 3. 正式采集：连续 10 页
node src/direct-search-cli.mjs --keywords ggdb --max-pages 10 --count 8

# 4. 单元测试仍通过
node --test test/direct-search.test.mjs

# 5. 完整验收（10页 + 短链 + CSV）
node src/direct-search-cli.mjs --keywords ggdb --all --count 20
```

## 验收标准（硬性）

1. ✅/❌ 搜索翻页全程无 ADB UI 操作 — 当前已达标
2. ❌ 连续成功翻页 10 页 — 等 dechunker 修复
3. ❌ 读取真实 next_cursor/has_more — 等 dechunker 修复
4. ✅ App 停留在任意页面 — 当前已达标
5. ✅ 短链通过 /shorten/ API — 已验证
6. ✅ 六字段 CSV 输出 — 代码就绪
7. ✅ SQLite 断点续跑 — 代码就绪

## 禁止

- adb shell input text/tap/swipe
- UIAutomator
- 点击分享按钮
- 回退到"Frida 读 UI 触发的响应"
- 覆盖用户已有 git 修改
