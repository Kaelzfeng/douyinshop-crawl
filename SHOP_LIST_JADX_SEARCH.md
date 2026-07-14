# 店铺商品列表 API 静态搜索结果

扫描范围：

- `reverse/partial_src/sources`
- `reverse/security_src/sources`

关键词覆盖：

- `shop/product` / `shop/goods` / `promotion/list`
- `product/list` / `shop_items`
- Retrofit `@POST` / `@GET` + `Shop` / `Goods` / `Product` / `Promotion`
- `sec_shop_id` / `shop_id`
- `page` + `size` + `cursor`
- `ecombdapi` / `ecom.snssdk`

汇总输出：

- `output/shop_list_static_search_summary.json`
- `output/store_api_candidate_files.json`
- `output/store_api_hits.tsv`

## 结论

在 `partial_src` / `security_src` 里没有找到硬编码的：

- `/aweme/v2/shop/product/list/`
- `/aweme/v2/shop/promotion/shop_items/`
- `/shop/product`
- `/shop/goods`
- `/product/list`

唯一命中的店铺商品列表入口是 **schema 路由**，不是 Retrofit 端点：

- `sslocal://ec_shop/goods/list.*`
- `aweme://goods/store.*`

实际 HTTP 商品列表端点未以常量形式出现在这两份 Java 反编译源码里；它走的是店铺 TabKit / SSR / 动态 URL 通道。结合已登录真机抓包，最终确认的 HTTP 端点是：

```text
POST https://ecom.snssdk.com/aweme/v1/store/product/bff/
```

该端点已端到端验证：HTTP 200 且响应 `status_code=0`。

## 最关键候选

### 1. 店铺商品列表真实 HTTP 端点：`POST /aweme/v1/store/product/bff/`

- 来源：动态抓包确认；静态 Java 中未出现硬编码路径。
- Host：`https://ecom.snssdk.com`
- Method：`POST`
- Content-Type：`application/x-www-form-urlencoded; charset=UTF-8`
- 返回商品位置：

```text
hybrid_list.sections[].items[].item_data
```

`item_data` 是 JSON 字符串，商品 ID：

```text
base_info.product_id
base_info.promotion_id
```

请求体核心参数：

```text
request_tab_type=3
sec_shop_id=<sec_shop_id>
filter_params={"order":0,"sort_type":0,"pick_type":0,"custom_id_type":0}
pagination_params=<上一页响应返回的 pagination_params>
passthrough_api={...}
client_state={"list_style":1}
click_products=
client_slice_templates=[...]    # 翻页请求常见
client_experiment_list={...}
```

所属静态通道候选：

- `reverse/security_src/sources/com/bytedance/android/shopping/store/tabkit/ssr/SSRApiChunk.java:16-18`
- `reverse/security_src/sources/com/bytedance/android/shopping/store/tabkit/ssr/SSRApiStream.java:15-17`

```java
@POST
@Streaming
Observable<SsResponse<TypedInput>> post(
    @Url String str,
    @QueryMap Map<String, String> map,
    @HeaderMap Map<String, String> map2,
    @Body SSRRequestBody sSRRequestBody
);
```

```java
@POST
@Streaming
Call<TypedInput> post(
    @Url String str,
    @QueryMap Map<String, String> map,
    @HeaderMap Map<String, String> map2,
    @Body SSRRequestBody sSRRequestBody
);
```

判断：这是店铺 TabKit/SSR 动态 URL 请求通道，最符合抓到的 `/aweme/v1/store/product/bff/`。

## Schema 入口证据

### 2. `sslocal://ec_shop/goods/list.*`

- 文件：`reverse/security_src/sources/com/ss/android/ugc/aweme/qrcode/handler/DeepLinkPageHandler.java:18`
- 所属类名：`DeepLinkPageHandler`
- URL/Schema：

```text
sslocal://ec_shop/goods/list.*
aweme://goods/store.*
sslocal://goods/shop.*
```

参数：走 schema query，静态注解只声明 handler URI；实际参数可包含 `sec_shop_id`、`entrance_location` 等。

### 3. `ec_shop/goods/list`

- 文件：`reverse/partial_src/sources/X/C0A31.java:32`
- 所属类名：`C0A31`
- URL/Schema fragment：

```text
ec_shop/goods/list
goods/store
goods/shop
```

判断：这是商品/店铺 schema 白名单或路由映射，说明“店铺商品列表”在客户端首先是 schema 页面，不是普通固定 Retrofit 接口。

## Retrofit 候选，但不是全店商品列表

### 4. `GET https://ecom.snssdk.com/aweme/v2/commerce/common/favorite/feed`

- 文件：`reverse/partial_src/sources/com/bytedance/android/shopping/anchorv3/guessulike/api/GuessULikeApi.java:13-14`
- 所属类名：`GuessULikeApi`
- 参数：

```text
product_id
count
page_num
page_name
cursor
feedbacks
filters
enter_from
internal_feed_ab
meta_param
product_is_invalid
use_new_price
width
height
author_id
shop_id
item_id
ecom_scene_id
force_insert_type_list
pdp_session_id
```

判断：商品详情页“猜你喜欢/推荐流”，带 `shop_id + cursor + count`，但不是全店商品列表。

### 5. `GET https://aweme.snssdk.com/aweme/v2/commerce/favorite/feed`

- 文件：`reverse/partial_src/sources/com/bytedance/android/shopping/feed/repository/api/InnerGuessULikeApi.java:18-22`
- 所属类名：`InnerGuessULikeApi`
- 参数：

```text
product_id
count
page_num
page_name
cursor
feedbacks
filters
enter_from
internal_feed_ab
meta_param
author_id
author_open_id
shop_id
item_id
pre_topics / pre_recommend
video_page_source / video_source_page
show_internal_list_style
same_product_scene
front_category_id
front_category_name
first_category_id
first_category_name
agg_params
is_star
is_ads
good_price_param
resource
resource_scene
search_filter_query_ids
search_filter_pids
```

判断：内流推荐商品 feed；有分页和 `shop_id`，但依赖 `product_id`，不是店铺全量列表。

### 6. `POST /aweme/v2/shop/promotion/pack/`

- 文件：`reverse/partial_src/sources/com/bytedance/android/shopping/anchorv3/repository/api/AnchorV3Api.java:77-78`
- 所属类名：`AnchorV3Api`
- 参数：

```text
user_id
user_open_id
sec_user_id
promotion_ids
item_id
sec_author_id
enter_from
meta_param
author_id
author_open_id
width
height
rank_id
internal_feed_ab
source_type
qianchuan_ab
use_new_price
cps_track
user_addr_id
marketing_channel
gps_on
product_id
creative_id
promotion_id
inflow_meta_param
FieldMap
video_page_source
same_product_scene
is_preload_req
```

判断：已知单品详情/批量 promotion pack，不是列表发现入口。

### 7. `POST /aweme/v2/shop/promotion/pack/inner/`

- 文件：
  - `reverse/partial_src/sources/com/bytedance/android/shopping/anchorv3/repository/api/AnchorV3Api.java:81-82`
  - `reverse/partial_src/sources/com/bytedance/android/shopping/feed/repository/api/AnchorV3Api.java:36-37`
- 所属类名：`AnchorV3Api`
- 参数：同 pack，另一个版本带：

```text
is_preload
agg_params
```

判断：内流商品详情，不是店铺商品列表。

### 8. `POST /aweme/v2/shop/promotion/recommend/`

- 文件：`reverse/partial_src/sources/com/bytedance/android/shopping/anchorv3/repository/api/AnchorV3Api.java:85-86`
- 所属类名：`AnchorV3Api`
- 参数：

```text
according_product_id
source
type
room_id
video_id
FieldMap
```

判断：基于单品的推荐，不是全店列表。

### 9. `POST /ecom/video/get_good_products/`

- 文件：`reverse/partial_src/sources/com/bytedance/android/shopping/feed/repository/api/GoodPriceApi.java:15-16`
- 所属类名：`GoodPriceApi`
- 参数：

```text
base_products
is_star
is_ads
enter_from
scene_list
item_id
current_scene
author_id
```

判断：视频/场景下的好价商品，不是店铺全量列表。

### 10. `GET https://ecom.snssdk.com/ecom/video/similar_product/feed`

- 文件：`reverse/partial_src/sources/com/bytedance/android/shopping/searchsimilar/api/SimilarProductApi.java:16-17`
- 所属类名：`SimilarProductApi`
- 参数：

```text
aweme_id
product_frame_id
cursor
count
penetrate_data
sort_rule
feedback
filters
```

判断：相似商品 feed，不是店铺列表。

## 泛型动态 URL 通道

这些接口本身没有固定 URL，但可以承载动态下发的接口路径：

### 11. `PlatformHttpRequestAPI`

- 文件：`reverse/partial_src/sources/com/bytedance/android/shopping/abscontainer/arch/platform/net/PlatformHttpRequestAPI.java:13-17`
- 所属类名：`PlatformHttpRequestAPI`
- URL：`@Url String str`
- 参数：

```text
GET  @Url str, @Body Map<String,Object>
POST @Url str, @Body Map<String,Object>
```

### 12. `IYataNetworkAbilityApi`

- 文件：`reverse/security_src/sources/com/bytedance/android/shopping/yata/ability/IYataNetworkAbilityApi.java:19-26`
- 所属类名：`IYataNetworkAbilityApi`
- URL：`@Url String str`
- 参数：

```text
GET  @Url str, @HeaderList, @QueryMap, @MaxLength
POST @Url str, @HeaderList, @Body RequestBody, @MaxLength
POST @Url str, @HeaderList, @Body TypedOutput, @MaxLength
```

### 13. `CardListApi`

- 文件：`reverse/partial_src/sources/com/bytedance/android/shopping/card_list/repo/CardListApi.java:17-21`
- 所属类名：`CardListApi`
- URL：`@Url String str`
- 参数：

```text
POST @Url str, @Body Object
POST @Url str, @MaxLength, @Body C44460An4
```

## 搜索计数

```json
{
  "files_scanned": 73458,
  "counts": {
    "shop/product|shop/goods|promotion/list": 2,
    "product/list|shop_items": 0,
    "sec_shop_id": 4,
    "shop_id": 55,
    "page+size+cursor_file": 35,
    "ecombdapi|ecom.snssdk": 59,
    "@POST/@GET Shop/Goods/Product/Promotion": 22
  }
}
```

## 最终采用

采用抓包确认且已签名验证通过的：

```text
POST https://ecom.snssdk.com/aweme/v1/store/product/bff/
```

已落地脚本：

```text
tools/verify_store_product_bff.py
tools/crawl_store_products_http.py
tools/extract_store_product_bff.py
```

