from __future__ import annotations

import argparse
import csv
import json
import urllib.parse
from pathlib import Path
from typing import Any

TARGET_PATH = "/aweme/v1/store/product/bff/"


def parse_json_strings(value: Any) -> Any:
    if isinstance(value, str):
        s = value.strip()
        if (s.startswith("{") and s.endswith("}")) or (s.startswith("[") and s.endswith("]")):
            try:
                return parse_json_strings(json.loads(s))
            except Exception:
                return value
        return value
    if isinstance(value, list):
        return [parse_json_strings(v) for v in value]
    if isinstance(value, dict):
        return {k: parse_json_strings(v) for k, v in value.items()}
    return value


def find_product_objects(value: Any, path: str = "") -> list[tuple[str, dict[str, Any]]]:
    found: list[tuple[str, dict[str, Any]]] = []
    if isinstance(value, dict):
        base_info = value.get("base_info")
        if isinstance(base_info, dict) and (base_info.get("product_id") or base_info.get("promotion_id")):
            found.append((path, value))
        for key, child in value.items():
            found.extend(find_product_objects(child, f"{path}.{key}" if path else str(key)))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(find_product_objects(child, f"{path}[{index}]"))
    return found


def normalize_product(obj: dict[str, Any], response_index: int, product_index: int) -> dict[str, Any]:
    base = obj.get("base_info") or {}
    title = obj.get("title_info") or {}
    price = obj.get("price_info") or {}
    sales = obj.get("sales_info") or {}
    shop = obj.get("shop_info") or {}
    shop_base = shop.get("base_info") or {}
    link = obj.get("link_info") or {}
    cover = obj.get("cover_info") or {}
    cover_img = cover.get("cover") or {}
    raw_sales = sales.get("sales")
    if raw_sales is None or raw_sales == "":
        raw_sales = ""
    # BFF exposes the UI label as `sale_desc`, e.g. "已售5000+",
    # "已售0", or "107人加购".  The numeric `sales` field can be 0 even
    # when the UI is intentionally showing a non-sales engagement label,
    # so keep both and let final export use the display label.
    sale_desc = sales.get("sale_desc")
    if sale_desc is None or sale_desc == "":
        sale_desc = sales.get("sales_desc")
    if sale_desc is None or sale_desc == "":
        sale_desc = ""
    sales_display = sale_desc if sale_desc != "" else raw_sales
    return {
        "response_index": response_index,
        "product_index": product_index,
        "product_id": str(base.get("product_id") or ""),
        "promotion_id": str(base.get("promotion_id") or ""),
        "promotion_source": base.get("promotion_source"),
        "status": base.get("status"),
        "product_type": base.get("product_type"),
        "brand_name": base.get("brand_name"),
        "title": title.get("title") or "",
        "show_price_fen": price.get("show_price"),
        "show_price_yuan": (int(price["show_price"]) / 100 if isinstance(price.get("show_price"), int) else ""),
        "discount_desc": price.get("discount_desc") or "",
        # Keep numeric 0.  `sales.get("sales") or ...` incorrectly turned
        # legitimate zero records into blank cells.
        "sales": raw_sales,
        "sale_desc": sale_desc,
        "sales_display": sales_display,
        "shop_id": shop.get("shop_id") or shop_base.get("shop_id") or "",
        "shop_name": shop.get("shop_name") or shop_base.get("shop_name") or "",
        "sec_shop_id": shop.get("sec_shop_id") or shop_base.get("sec_shop_id") or "",
        "detail_url": link.get("detail_url") or link.get("url") or shop_base.get("shop_link") or "",
        "cover_url": (cover_img.get("url_list") or [""])[0] if isinstance(cover_img.get("url_list"), list) else "",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("capture", nargs="?", default="output/shop-store-capture.json")
    parser.add_argument("--out-prefix", default="output/store-product-bff")
    args = parser.parse_args()

    capture = json.loads(Path(args.capture).read_text(encoding="utf-8"))
    prefix = Path(args.out_prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)

    requests = []
    for body in capture.get("requestBodies", []):
        url = body.get("url") or ""
        if TARGET_PATH not in url:
            continue
        params = {k: v[0] if len(v) == 1 else v for k, v in urllib.parse.parse_qs(body.get("utf8", ""), keep_blank_values=True).items()}
        for key in ("filter_params", "pagination_params", "passthrough_api", "client_state", "client_experiment_list", "client_slice_templates"):
            if isinstance(params.get(key), str) and params[key].strip().startswith(("{", "[")):
                try:
                    params[key] = json.loads(params[key])
                except Exception:
                    pass
        requests.append({
            "url": url,
            "length": body.get("length"),
            "headers": body.get("headers"),
            "params": params,
        })

    products = []
    responses = []
    for response_index, resp in enumerate(capture.get("responseBodies", [])):
        url = resp.get("url") or ""
        if TARGET_PATH not in url:
            continue
        raw = json.loads(resp.get("utf8", "{}"))
        deep = parse_json_strings(raw)
        product_objects = find_product_objects(deep)
        seen = set()
        normalized = []
        for _, obj in product_objects:
            base = obj.get("base_info") or {}
            pid = str(base.get("product_id") or base.get("promotion_id") or "")
            if not pid or pid in seen:
                continue
            seen.add(pid)
            row = normalize_product(obj, response_index, len(normalized))
            normalized.append(row)
            products.append(row)
        responses.append({
            "url": url,
            "status": resp.get("status"),
            "length": resp.get("length"),
            "status_code": raw.get("status_code"),
            "has_more": raw.get("has_more"),
            "pagination_params": parse_json_strings(raw.get("pagination_params")),
            "product_count": len(normalized),
            "product_ids": [p["product_id"] for p in normalized],
        })

    (prefix.with_suffix(".requests.json")).write_text(json.dumps(requests, ensure_ascii=False, indent=2), encoding="utf-8")
    (prefix.with_suffix(".responses.json")).write_text(json.dumps(responses, ensure_ascii=False, indent=2), encoding="utf-8")
    (prefix.with_suffix(".products.json")).write_text(json.dumps(products, ensure_ascii=False, indent=2), encoding="utf-8")

    csv_path = prefix.with_suffix(".products.csv")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        fields = list(products[0].keys()) if products else ["product_id", "title"]
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(products)

    print(json.dumps({
        "requests": len(requests),
        "responses": len(responses),
        "products": len(products),
        "productsCsv": str(csv_path),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
