# 店铺/商品列表 API 静态逆向结论

日期：2026-07-14
样本：`reverse/samples/douyin-mall-39.5.0.apk`

## 结论

本轮按 jadx/DEX/包内 Lynx 资源搜索后，**没有在已反编译 Java 代码里找到一个可直接按 `sec_shop_id` 拉全店商品的 Retrofit 接口**（例如 `/aweme/v2/shop/product/list/` 这一类路径未命中）。店铺页更像是 Schema/KMP/Lynx 容器驱动，静态 Java 侧只暴露了入口和数据模型。

能确认的最高价值线索如下：

1. **店铺页入口 Schema**
   - `sslocal://goods/store?sec_shop_id=...`
   - `sslocal://goods/shop?...sort_type=0&modal=seven_split...`
   - Router 配置存在 `ec_shop/goods/list`，但这是客户端 schema/router 路径，不是 HTTP API。

2. **已确认可返回“店铺 + 商品卡片”的列表接口，但不是任意店铺全量商品**
   - `GET https://lianmengapi.snssdk.com/ecom/repurchase/v1/follow/shoplist`
   - `GET https://lianmengapi.snssdk.com/ecom/repurchase/v1/purchased/shoplist`
   - 参数：`offset`, `limit`（模板里默认 `limit=20`）
   - 响应：`status_code`, `has_more`, `offset`, `follow_shops` 或 `purchased_shops`；前端统一映射到 `purchased_shops`，每个 shop card 里含 `products[]`，商品卡字段包括 `product_id`, `commodity_id`, `commodity_type`, `url`, `price`, `img` 等。
   - 用途：可批量拿“关注店/常买店”列表里的 product_id，但不是“指定店铺 sec_shop_id 的全店商品”。

3. **按 product_ids 批量补全商品信息的接口**
   - `GET ${API_ECOM}/bff/product/infos`
   - 参数：`marketing_channel=explosive_subsidy`, `product_ids=<comma list>`, `ecom_scene_id=...`
   - 这是“已有 product_id 后补信息”，不负责发现 ID。

4. **候选但未确认的店铺数据接口/入口**
   - `/api/anchor/shop/widget_data`：DEX 字符串命中，未找到 Java 调用点；像规则/路由/埋点允许列表中的路径。
   - `/ecom/product/detail/preload/list`：商品详情预加载列表，适合已知商品，不是店铺列表。
   - `/aweme/v2/shop/promotion/recommend/`：推荐商品，不是全店。

## 证据位置

### 1) Java/jadx 命中的商品详情与推荐接口

- `reverse/partial_src/sources/com/bytedance/android/shopping/anchorv3/repository/api/AnchorV3Api.java`
  - `POST /aweme/v2/shop/promotion/pack/`
  - `POST /aweme/v2/shop/promotion/pack/detail/`
  - `POST /aweme/v2/shop/promotion/pack/inner/`
  - `POST /aweme/v2/shop/promotion/recommend/`
  - `GET /aweme/v2/shop/promotion/group/`
- `reverse/partial_src/sources/com/bytedance/android/shopping/anchorv4/perf/preload/PreloadApi.java`
  - `POST https://ecom.snssdk.com/ecom/product/detail/preload`
  - `POST https://ecom.snssdk.com/ecom/product/detail/preload/list`
- `reverse/partial_src/sources/com/bytedance/android/shopping/feed/repository/api/GoodPriceApi.java`
  - `POST /ecom/video/get_good_products/`

### 2) 店铺页 Native 数据模型存在，但接口不在已反编译 Java 明文里

DEX 字符串和部分 Java 源显示店铺商品卡模型：

- `com/bytedance/android/ec/store/repository/vo/ShopSlcProductItemV2`
- `com/bytedance/android/ec/store/repository/vo/ShopSlcProductItemVO`
- `com/bytedance/android/ec/store/repository/vo/StoreV2ProductItemVO`
- `com/bytedance/android/ec/window/base/repository/vo/WindowV2ProductItemVO`
- `EC_SHOP_PRODUCTS`

对应使用点示例：

- `reverse/partial_src/sources/com/bytedance/android/ec/store/product/presenter/baseinf/QECProductCardFragmentPresenter.java`
- `reverse/partial_src/sources/com/bytedance/android/ec/store/product/presenter/element/*`

### 3) Schema 证据

包内资源（从 APK ZIP 直接扫）：

- `assets/offline/ecom_mall_cards_legou/cards/page_card/template.js`
  - `getShopSchema()` 构造 `sslocal://goods/store?sec_shop_id=...`
  - `getWindowSchema()` 构造 `sslocal://goods/shop?...`
- `assets/offline/ecom_mall_cards_legou/cards/header_card/template.js`
  - 同样构造 `goods/store` / `goods/shop`
- `assets/roma_schema_config_v2.json`
  - `host: ec_shop`, `path: /goods/list`
- `assets/slice_warm_data.json`, `assets/yata.json`
  - 示例：`shop_url: sslocal://goods/store?sec_shop_id=...`

### 4) 远端 Lynx 模板确认的“关注/常买店铺列表”接口

DEX 里发现入口：

```text
sslocal://webcast_lynxview?url=https%3A%2F%2Flf-webcast-sourcecdn-tos.bytegecko.com%2Fobj%2Fbyte-gurd-source%2Fwebcast%2Fecom%2Flynx%2Fclient_ecom_shop_list%2Fapp%2Ftemplate.js&...
```

已下载保存：

- `reverse/remote_lynx/client_ecom_shop_list_template.js`
- 摘要片段：`reverse/remote_lynx/client_ecom_shop_list_api_snippet.js`

核心逻辑（反混淆前的压缩片段）：

```js
var o="https://lianmengapi.snssdk.com";
var i = r === ShopListTypeFollow
  ? `${o}/ecom/repurchase/v1/follow/shoplist`
  : `${o}/ecom/repurchase/v1/purchased/shoplist`;
fetch({ url: i, method: "GET", headers: { "Content-Type": "application/json" }, data: {}, params: { ...t } });
```

调用处默认分页参数：

```js
{ offset: state.offset, limit: 20 }
```

页面状态更新逻辑：

```js
hasMore = raw.has_more
offset = raw.offset
shops = currentPage === 1 ? raw.purchased_shops : shops.concat(raw.purchased_shops)
```

Follow 模式会做字段归一化：

```js
if (shopListType === ShopListTypeFollow && raw.follow_shops) {
  raw.purchased_shops = raw.follow_shops
}
```

## 对爬虫的可用性判断

- 如果目标是“从账号可见的关注店/常买店中批量拿商品 ID”：可以从 `follow/shoplist`、`purchased/shoplist` 入手。
- 如果目标是“输入任意 `sec_shop_id`，全量拉该店所有商品”：本轮静态 jadx 未找到明文 HTTP 接口；应走动态抓包，打开 `sslocal://goods/store?sec_shop_id=<id>` 后捕获实际网络请求。

建议下一步动态命中目标：

1. 把 hook 过滤范围扩大到：`goods/store`, `goods/shop`, `ec_shop/goods/list`, `/api/anchor/shop/widget_data`, `/ecom/repurchase/`, `/bff/product/infos`, `/store`, `/window`。
2. 通过 adb 打开样例店铺：
   ```powershell
   adb shell am start -a android.intent.action.VIEW -d "sslocal://goods/store?sec_shop_id=YOCdLfNE&entrance_location=h5_cart_list&sort_type=0&url_maker=schema_sdk"
   ```
3. 捕获第一个返回 `StoreV2ProductItemVO` / `ShopSlcProductItemVO` / `EC_SHOP_PRODUCTS` 的请求；这才是任意店铺商品列表 API。

## 本轮产物

- `output/dex_shop_endpoint_candidates.tsv`：全 DEX 中与 shop/store/product/goods/window 相关的路径字符串候选。
- `reverse/remote_lynx/client_ecom_shop_list_template.js`：下载的店铺列表 Lynx 模板。
- `reverse/remote_lynx/client_ecom_shop_list_api_snippet.js`：模板里 API 调用片段。

---

## 动态抓包确认（2026-07-14）

已登录 App 下打开：

```text
snssdk561124://goods/store?sec_shop_id=YOCdLfNE&entrance_location=h5_cart_list&custom_id_type=0&sort_type=0&url_maker=schema_sdk
```

确认店铺商品列表接口为：

```text
POST https://ecom.snssdk.com/aweme/v1/store/product/bff/
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
```

关键请求体参数：

```text
sec_shop_id=YOCdLfNE
request_tab_type=3
filter_params={"order":0,"sort_type":0,"pick_type":0,"custom_id_type":0}
client_state={"list_style":1}
passthrough_api={"entrance_location":"h5_cart_list",...,"store_type":"shop","ecom_scene_id":"1003"}
pagination_params={"cursor":0,"size":0,"bottom_module_type":4,"bottom_module_params":"...",...}
client_experiment_list={...}
client_slice_templates=[...]   # 第二页/后续请求会带模板列表
```

响应特征：

```text
status_code: 0
has_more: true
pagination_params: "{...}"   # 字符串 JSON，下一页要回传/更新
hybrid_list.sections[].items[].item_data   # 字符串 JSON，里面是商品卡数据
```

商品字段位置：

```text
hybrid_list.sections[].items[].item_data.base_info.product_id
hybrid_list.sections[].items[].item_data.base_info.promotion_id
hybrid_list.sections[].items[].item_data.title_info.title
hybrid_list.sections[].items[].item_data.price_info.show_price
hybrid_list.sections[].items[].item_data.cover_info.cover.url_list[]
```

本次样例抓到 2 次 `/aweme/v1/store/product/bff/` 请求，每次 9 个商品，`status_code=0`，`has_more=true`。

产物：

- 原始抓包：`output/shop-store-capture.json`
- 请求摘要：`output/store-product-bff.requests.json`
- 响应摘要：`output/store-product-bff.responses.json`
- 商品 JSON：`output/store-product-bff.products.json`
- 商品 CSV：`output/store-product-bff.products.csv`
- 解析脚本：`tools/extract_store_product_bff.py`
- 通用 schema 抓包脚本：`hook/capture-open-uri.py`

备注：请求头中 `X-SS-STUB` 与请求体 MD5 一致；完整签名/重放仍应走已有 `native_sign.py` 做端到端验证。
