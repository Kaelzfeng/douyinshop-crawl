from __future__ import annotations

import argparse
import csv
import json
import random
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from native_sign import NativeMetaSecSigner
from tools.crawl_store_products_http import (
    dedupe_append,
    form_get,
    load_bff_requests,
    make_body,
    parse_form,
)
from tools.extract_store_product_bff import parse_json_strings
from tools.verify_store_product_bff import extract_products, signed_post


PACK_PATH = "/aweme/v2/shop/promotion/pack/"


def replace_url_path(url: str, path: str = PACK_PATH, host: str | None = None) -> str:
    parsed = urllib.parse.urlsplit(url)
    netloc = host or parsed.netloc
    return urllib.parse.urlunsplit((parsed.scheme or "https", netloc, path, parsed.query, ""))


def load_detail_template(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    body_file = ROOT / data["bodyFile"] if not Path(data["bodyFile"]).is_absolute() else Path(data["bodyFile"])
    data["body"] = body_file.read_text(encoding="utf-8")
    return data


def body_for_promotion(template_body: str, old_id: str, promotion_id: str) -> str:
    out: list[tuple[str, str]] = []
    for key, value in urllib.parse.parse_qsl(template_body, keep_blank_values=True):
        value = value.replace(old_id, promotion_id) if old_id else value
        if key in {"promotion_ids", "promotion_id", "ec_promotion_id"}:
            value = promotion_id
        out.append((key, value))
    if not any(k == "promotion_ids" for k, _ in out):
        out.append(("promotion_ids", promotion_id))
    return urllib.parse.urlencode(out)


def first_string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def price_to_yuan(value: Any) -> str:
    if value in (None, ""):
        return ""
    try:
        number = float(value)
    except Exception:
        return first_string(value)
    # Douyin price fields are usually cents/fen for integer values.
    if number >= 1000 and number.is_integer():
        return f"{number / 100:.2f}".rstrip("0").rstrip(".")
    return f"{number:.2f}".rstrip("0").rstrip(".")


def normalize_sales_for_final(display: Any = "", raw: Any = "") -> str:
    text = str(display or "").strip()
    if text:
        if text.startswith("\u5df2\u552e"):
            return text.replace("\u5df2\u552e", "", 1).strip()
        if "\u52a0\u8d2d" in text:
            return ""
        return text
    if raw is None:
        return ""
    return str(raw).strip()


def extract_detail_fields(payload_text: str, promotion_id: str) -> tuple[dict[str, Any], dict[str, str]]:
    raw = json.loads(payload_text)
    deep = parse_json_strings(raw)

    fields = {
        "title": "",
        "shop_name": "",
        "price": "",
        "sales": "",
    }

    def maybe_set(key: str, value: Any) -> None:
        text = first_string(value).strip()
        if text and not fields[key]:
            fields[key] = text

    def walk(obj: Any) -> None:
        if isinstance(obj, dict):
            lower = {str(k).lower(): v for k, v in obj.items()}

            for k in ("title", "product_title", "product_name", "name"):
                if k in lower and k != "name":
                    maybe_set("title", lower[k])
            if "shop_name" in lower:
                maybe_set("shop_name", lower["shop_name"])

            # Common native/H5 price locations.
            price_info = lower.get("price_info") or lower.get("price") or lower.get("price_data")
            if isinstance(price_info, dict):
                for k in ("show_price", "discount_price", "sale_price", "min_price", "price"):
                    if k in {str(x).lower(): x for x in price_info.keys()}:
                        src_key = {str(x).lower(): x for x in price_info.keys()}[k]
                        maybe_set("price", price_to_yuan(price_info.get(src_key)))
                        break
            for k in ("show_price", "discount_price", "sale_price", "min_price"):
                if k in lower:
                    maybe_set("price", price_to_yuan(lower[k]))

            sales_info = lower.get("sales_info") or lower.get("sale_info")
            if isinstance(sales_info, dict):
                for k in ("sales", "sales_desc", "sale_num", "sell_num", "sold_count"):
                    if k in {str(x).lower(): x for x in sales_info.keys()}:
                        src_key = {str(x).lower(): x for x in sales_info.keys()}[k]
                        maybe_set("sales", sales_info.get(src_key))
                        break
            for k in ("sales", "sales_desc", "sale_num", "sell_num", "sold_count"):
                if k in lower:
                    maybe_set("sales", lower[k])

            for child in obj.values():
                walk(child)
        elif isinstance(obj, list):
            for child in obj:
                walk(child)

    walk(deep)
    return raw, fields


def bff_fallback(row: dict[str, Any]) -> dict[str, str]:
    sales_value = normalize_sales_for_final(
        row.get("sales_display") or row.get("sale_desc"),
        row.get("sales"),
    )
    return {
        "title": str(row.get("title") or ""),
        "shop_name": str(row.get("shop_name") or ""),
        "price": str(row.get("show_price_yuan") or ""),
        "sales": sales_value,
    }


def final_row(summary: dict[str, Any], detail: dict[str, str] | None = None) -> dict[str, str]:
    fallback = bff_fallback(summary)
    detail = detail or {}
    pid = str(summary.get("promotion_id") or summary.get("product_id") or "")
    return {
        "品名": detail.get("title") or fallback["title"],
        "店铺名": detail.get("shop_name") or fallback["shop_name"],
        "价格": detail.get("price") or fallback["price"],
        "销量": detail.get("sales") or fallback["sales"],
        "分享链接": f"https://v.douyin.com/{pid}",
    }


def write_final_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["品名", "店铺名", "价格", "销量", "分享链接"])
        writer.writeheader()
        writer.writerows(rows)


def crawl_bff(args: argparse.Namespace, signer: NativeMetaSecSigner) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    templates = load_bff_requests(Path(args.capture))
    first_template = templates[args.request_index]
    next_template = templates[min(args.next_request_index, len(templates) - 1)]
    sec_shop_id = args.sec_shop_id or form_get(parse_form(first_template["utf8"]), "sec_shop_id")

    products: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    next_pagination: str | None = None
    responses_path = Path(args.bff_responses_jsonl)
    responses_path.parent.mkdir(parents=True, exist_ok=True)

    with responses_path.open("w", encoding="utf-8") as response_file:
        page_index = 0
        while args.pages <= 0 or page_index < args.pages:
            if args.max_pages > 0 and page_index >= args.max_pages:
                break
            template = first_template if page_index == 0 else next_template
            body = make_body(
                template["utf8"],
                sec_shop_id=sec_shop_id,
                pagination_params=next_pagination if page_index > 0 else None,
            )
            http_status, response_headers, text = signed_post(
                template["url"], body, template.get("headers") or {}, signer, args.timeout
            )
            raw, rows = extract_products(text, page_index)
            for row in rows:
                row["page_index"] = page_index
            added = dedupe_append(products, seen_ids, rows)
            summary = {
                "page_index": page_index,
                "http_status": http_status,
                "status_code": raw.get("status_code"),
                "has_more": raw.get("has_more"),
                "product_count": len(rows),
                "new_product_count": added,
                "product_ids": [r.get("product_id") for r in rows],
            }
            summaries.append(summary)
            response_file.write(json.dumps({"summary": summary, "response": raw}, ensure_ascii=False) + "\n")
            response_file.flush()
            print(json.dumps({"stage": "bff", **summary}, ensure_ascii=False), flush=True)

            if http_status != 200 or raw.get("status_code") != 0:
                break
            next_pagination = raw.get("pagination_params")
            if not raw.get("has_more") or not next_pagination:
                break
            if args.stop_on_no_new and page_index > 0 and added == 0:
                break

            page_index += 1
            if args.bff_delay_ms > 0:
                time.sleep((args.bff_delay_ms + random.randint(0, max(0, args.jitter_ms))) / 1000)

    return products, summaries


def fetch_details(
    args: argparse.Namespace,
    signer: NativeMetaSecSigner,
    products: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, str]], list[dict[str, Any]]]:
    if args.no_details:
        return {}, []

    template = load_detail_template(Path(args.detail_template))
    old_id = str(template.get("productId") or "")
    detail_url = args.detail_url or replace_url_path(
        template["url"],
        PACK_PATH,
        None if not args.detail_host else args.detail_host,
    )
    if args.detail_headers_from == "bff":
        header_source = (load_bff_requests(Path(args.capture))[args.request_index].get("headers") or {})
    else:
        header_source = template.get("headers") or {}

    detail_map: dict[str, dict[str, str]] = {}
    events: list[dict[str, Any]] = []
    out_path = Path(args.detail_responses_jsonl)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    limit = len(products) if args.detail_limit <= 0 else min(args.detail_limit, len(products))
    with out_path.open("w", encoding="utf-8") as f:
        for index, product in enumerate(products[:limit]):
            promotion_id = str(product.get("promotion_id") or product.get("product_id") or "")
            if not promotion_id:
                continue
            body = body_for_promotion(template["body"], old_id, promotion_id)
            event: dict[str, Any] = {"index": index, "promotion_id": promotion_id}
            try:
                http_status, _headers, text = signed_post(detail_url, body, header_source, signer, args.timeout)
                raw, fields = extract_detail_fields(text, promotion_id)
                code = raw.get("status_code", raw.get("code")) if isinstance(raw, dict) else None
                msg = raw.get("msg") if isinstance(raw, dict) else ""
                event.update({"http_status": http_status, "code": code, "msg": msg, "fields": fields})
                if http_status == 200 and code in (0, None) and any(fields.values()):
                    detail_map[promotion_id] = fields
                f.write(json.dumps({"event": event, "response": raw}, ensure_ascii=False) + "\n")
                f.flush()
                print(json.dumps({"stage": "detail", **event}, ensure_ascii=False), flush=True)
                if args.stop_details_on_frequency and str(code) == "11001":
                    break
            except Exception as error:
                event.update({"error": str(error)})
                f.write(json.dumps({"event": event}, ensure_ascii=False) + "\n")
                f.flush()
                print(json.dumps({"stage": "detail", **event}, ensure_ascii=False), flush=True)
                if args.stop_details_on_error:
                    break
            events.append(event)
            if args.detail_delay_ms > 0 and index + 1 < limit:
                time.sleep((args.detail_delay_ms + random.randint(0, max(0, args.jitter_ms))) / 1000)
    return detail_map, events


def run(args: argparse.Namespace) -> int:
    signer = NativeMetaSecSigner(args.serial, launch=not args.no_launch)
    try:
        products, page_summaries = crawl_bff(args, signer)
        detail_map, detail_events = fetch_details(args, signer, products)
    finally:
        signer.close()

    final_rows = []
    for product in products:
        pid = str(product.get("promotion_id") or product.get("product_id") or "")
        final_rows.append(final_row(product, detail_map.get(pid)))

    write_final_csv(Path(args.output), final_rows)
    summary = {
        "pages_requested": "until_end" if args.pages <= 0 else args.pages,
        "max_pages": args.max_pages,
        "pages_done": len(page_summaries),
        "products": len(products),
        "details_attempted": len(detail_events),
        "details_ok": len(detail_map),
        "output": args.output,
        "bff_responses_jsonl": args.bff_responses_jsonl,
        "detail_responses_jsonl": args.detail_responses_jsonl,
        "pages": page_summaries,
    }
    Path(args.summary).parent.mkdir(parents=True, exist_ok=True)
    Path(args.summary).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if products else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Full store BFF -> pack detail -> final five-column CSV.")
    parser.add_argument("--capture", default="output/shop-store-capture.json")
    parser.add_argument("--request-index", type=int, default=0)
    parser.add_argument("--next-request-index", type=int, default=1)
    parser.add_argument("--sec-shop-id", default="")
    parser.add_argument("--pages", type=int, default=0, help="0 or negative = crawl BFF until has_more=false")
    parser.add_argument("--max-pages", type=int, default=0, help="optional hard cap for BFF pages; 0 = no cap")
    parser.add_argument("--serial", default="127.0.0.1:16384")
    parser.add_argument("--no-launch", action="store_true")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--bff-delay-ms", type=int, default=2500)
    parser.add_argument("--detail-delay-ms", type=int, default=3500)
    parser.add_argument("--jitter-ms", type=int, default=1200)
    parser.add_argument("--stop-on-no-new", action=argparse.BooleanOptionalAction, default=True)

    parser.add_argument("--no-details", action="store_true", help="write final CSV from BFF summary only")
    parser.add_argument("--detail-template", default="output/native-detail-request.json")
    parser.add_argument("--detail-url", default="")
    parser.add_argument("--detail-host", default="ecom.ecombdapi.com")
    parser.add_argument("--detail-headers-from", choices=["bff", "detail"], default="bff")
    parser.add_argument("--detail-limit", type=int, default=0, help="0 = all products")
    parser.add_argument("--stop-details-on-frequency", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--stop-details-on-error", action=argparse.BooleanOptionalAction, default=False)

    parser.add_argument("--output", default="output/final-products.csv")
    parser.add_argument("--summary", default="output/final-products.summary.json")
    parser.add_argument("--bff-responses-jsonl", default="output/final-products.bff.responses.jsonl")
    parser.add_argument("--detail-responses-jsonl", default="output/final-products.detail.responses.jsonl")
    return parser


if __name__ == "__main__":
    raise SystemExit(run(build_parser().parse_args()))
