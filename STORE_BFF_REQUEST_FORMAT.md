# `/aweme/v1/store/product/bff/` 请求格式、详情接口映射和分页

## 1. SSRApiChunk / SSRApiStream 调用方结论

静态搜索范围：

- `reverse/partial_src/sources`
- `reverse/security_src/sources`
- `reverse/classes20_src/sources`
- `reverse/target_dex/*.dex` 字符串

结果：

- `SSRApiChunk`、`SSRApiStream` 在 Java 反编译源码中只找到接口定义，没有直接调用方。
- `classes35.dex` 字符串中也只有接口名/请求体类名自身，没有发现硬编码调用链。
- `/aweme/v1/store/product/bff/`、`pagination_params`、`request_tab_type`、`client_slice_templates` 没有出现在 dex 字符串里。

因此这个店铺商品 BFF URL 不是普通 Retrofit 常量；它是店铺 TabKit/SSR 动态 URL 通道下发/拼出来的请求。

静态承载通道：

```java
// reverse/security_src/sources/com/bytedance/android/shopping/store/tabkit/ssr/SSRApiChunk.java:16-18
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
// reverse/security_src/sources/com/bytedance/android/shopping/store/tabkit/ssr/SSRApiStream.java:15-17
@POST
@Streaming
Call<TypedInput> post(
    @Url String str,
    @QueryMap Map<String, String> map,
    @HeaderMap Map<String, String> map2,
    @Body SSRRequestBody sSRRequestBody
);
```

## 2. 可用请求 body 格式

实测端点：

```text
POST https://ecom.snssdk.com/aweme/v1/store/product/bff/
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
```

form 参数顺序来自真实抓包：

```text
request_tab_type
sec_shop_id
filter_params
pagination_params
passthrough_api
client_state
click_products
client_slice_templates
client_experiment_list
```

最小可复用结构：

```text
request_tab_type=3
sec_shop_id=<sec_shop_id>
filter_params={"order":0,"sort_type":0,"pick_type":0,"custom_id_type":0}
pagination_params=<第一页初始 pagination_params 或上一页响应 pagination_params 原字符串>
passthrough_api={"entrance_location":"h5_cart_list","pre_store_source_page":"","pre_store_group_type":"","pre_group_id":"","pre_product_id":"","pre_live_id":"","store_type":"shop","live_user_act_params":"","sql_data_from_client":"{}","ecom_scene_id":"1003"}
client_state={"list_style":1}
click_products=
client_slice_templates=<第一页可空，第二页以后建议带抓包中的模板数组>
client_experiment_list=<抓包中的实验开关 JSON>
```

第一页抓包值已保存：

```text
output/store-bff-request-format.pretty.json
```

当前 HTTP 爬虫实现：

```text
tools/crawl_store_products_http.py
```

构造策略：

1. 第 1 页使用抓包第 0 个 BFF 请求 body 模板。
2. 第 2 页起使用抓包第 1 个 BFF 请求 body 模板，因为它带 `client_slice_templates`。
3. 每一页把上一页响应顶层 `pagination_params` 原字符串写回下一页 body 的 `pagination_params`。
4. 重新计算 `X-SS-STUB = MD5(body).upper()`。
5. 调 `native_sign.py` 生成 native header 后 POST。

## 3. `/aweme/v2/shop/promotion/pack/` 参数确认

静态接口：

```java
// reverse/partial_src/sources/com/bytedance/android/shopping/anchorv3/repository/api/AnchorV3Api.java:77-78
@POST("/aweme/v2/shop/promotion/pack/")
Observable<C0A4L> getShopPromotion(
    @Field("user_id") String str,
    @Field("user_open_id") String str2,
    @Field("sec_user_id") String str3,
    @Field("promotion_ids") List<String> list,
    @Field("item_id") String str4,
    @Field("sec_author_id") String str5,
    @Field("enter_from") String str6,
    @Field("meta_param") String str7,
    @Field("author_id") String str8,
    @Field("author_open_id") String str9,
    @Field("width") Integer num,
    @Field("height") Integer num2,
    @Field("rank_id") String str10,
    @Field("internal_feed_ab") Integer num3,
    @Field("source_type") String str11,
    @Field("qianchuan_ab") String str12,
    @Field("use_new_price") Integer num4,
    @Field("cps_track") String str13,
    @Field("user_addr_id") String str14,
    @Field("marketing_channel") String str15,
    @Field("gps_on") Integer num5,
    @Field("product_id") String str16,
    @Field("creative_id") String str17,
    @Field("promotion_id") String str18,
    @Field("inflow_meta_param") String str19,
    @FieldMap Map<String, String> map,
    @Field("video_page_source") String str20,
    @Field("same_product_scene") Integer num6,
    @Field("is_preload_req") Boolean bool
);
```

同类接口：

```text
POST /aweme/v2/shop/promotion/pack/inner/
POST /aweme/v2/shop/promotion/pack/detail/
```

结论：

- BFF 商品卡里同时有：

```text
base_info.product_id
base_info.promotion_id
```

- 当前抓到的店铺列表 18 条、HTTP 爬虫 36 条里：

```text
product_id == promotion_id
promotion_source == 6
```

- 原生详情抓包 `output/native-detail-request.body` 也证明详情接口实际把商品 ID 填在：

```text
promotion_ids=<id>
```

且顶层：

```text
product_id=
promotion_id=
```

所以调用 pack/详情时应优先使用：

```python
promotion_id = base_info["promotion_id"] or base_info["product_id"]
```

当前这个店铺场景里，BFF 的 `product_id` 可以直接作为 `promotion_ids` 用；更稳妥是取 `promotion_id` 字段。

## 4. 分页逻辑

BFF 响应顶层：

```json
{
  "has_more": true,
  "hybrid_list": {...},
  "pagination_params": "{...}",
  "status_code": 0
}
```

翻页规则：

```text
while response.status_code == 0 and response.has_more == true:
    next_body.pagination_params = response.pagination_params
```

注意：

- `pagination_params` 是响应顶层 JSON 字符串，不是 `hybrid_list` 内字段。
- 字符串内部也有 `has_next_page`、`products_has_more`、`cursor` 等，但实际可用翻页信号是顶层 `has_more` + 顶层 `pagination_params` 原样回传。
- 内部 `cursor` 在这次抓包里一直是 `0`，真正游标编码在 `bottom_module_params` 内。

响应内解析出的分页字段示例：

```json
{
  "cursor": 0,
  "size": 0,
  "bottom_module_type": 4,
  "bottom_module_params": "...",
  "ts": 1784003374089,
  "products_has_more": false,
  "has_next_page": true,
  "product_count": 0,
  "product_total_count": 0,
  "biz_extra": {"brand_shop": ""},
  "main_new_product_ids": null,
  "ignore_select_params": false,
  "tab_type": null,
  "combination_history": "",
  "rec_cursor": null
}
```

已验证：

```text
python tools/crawl_store_products_http.py --capture output/shop-store-capture.json --pages 4 --no-launch
```

结果：

```json
{
  "pages_done": 4,
  "products": 36,
  "all_status_code": 0
}
```

输出：

```text
output/store-products-http-4p.csv
output/store-products-http-4p.summary.json
output/store-products-http-4p.responses.jsonl
```

