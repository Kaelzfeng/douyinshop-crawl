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
from tools.verify_store_product_bff import TARGET_PATH, extract_products, signed_post


def load_bff_requests(capture_path: Path) -> list[dict[str, Any]]:
    capture = json.loads(capture_path.read_text(encoding="utf-8"))
    requests = [
        body for body in capture.get("requestBodies", [])
        if TARGET_PATH in (body.get("url") or "") and body.get("utf8")
    ]
    if not requests:
        raise RuntimeError(f"no {TARGET_PATH} requestBodies found in {capture_path}")
    return requests


def parse_form(body_text: str) -> list[tuple[str, str]]:
    return urllib.parse.parse_qsl(body_text, keep_blank_values=True)


def form_get(params: list[tuple[str, str]], key: str, default: str = "") -> str:
    for k, v in params:
        if k == key:
            return v
    return default


def replace_form_values(params: list[tuple[str, str]], updates: dict[str, str]) -> list[tuple[str, str]]:
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for key, value in params:
        if key in updates:
            out.append((key, updates[key]))
            seen.add(key)
        else:
            out.append((key, value))
    for key, value in updates.items():
        if key not in seen:
            out.append((key, value))
    return out


def make_body(template_body: str, *, sec_shop_id: str | None, pagination_params: str | None) -> str:
    params = parse_form(template_body)
    updates: dict[str, str] = {}
    if sec_shop_id:
        updates["sec_shop_id"] = sec_shop_id
    if pagination_params:
        updates["pagination_params"] = pagination_params
    params = replace_form_values(params, updates)
    return urllib.parse.urlencode(params)


def is_success(raw: dict[str, Any]) -> bool:
    return raw.get("status_code") == 0


def dedupe_append(all_rows: list[dict[str, Any]], seen_ids: set[str], rows: list[dict[str, Any]]) -> int:
    added = 0
    for row in rows:
        pid = str(row.get("product_id") or row.get("promotion_id") or "")
        if not pid or pid in seen_ids:
            continue
        seen_ids.add(pid)
        all_rows.append(row)
        added += 1
    return added


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "page_index",
        "response_index",
        "product_index",
        "product_id",
        "promotion_id",
        "promotion_source",
        "status",
        "product_type",
        "brand_name",
        "title",
        "show_price_fen",
        "show_price_yuan",
        "discount_desc",
        "sales",
        "shop_id",
        "shop_name",
        "sec_shop_id",
        "detail_url",
        "cover_url",
    ]
    extras = sorted({k for row in rows for k in row.keys()} - set(fields))
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields + extras, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def crawl(args: argparse.Namespace) -> int:
    templates = load_bff_requests(Path(args.capture))
    # page 0 uses the first captured open-page request; following pages prefer the
    # second captured request because it contains client_slice_templates emitted by the app.
    first_template = templates[args.request_index]
    next_template = templates[min(args.next_request_index, len(templates) - 1)]
    sec_shop_id = args.sec_shop_id or form_get(parse_form(first_template["utf8"]), "sec_shop_id")

    signer = NativeMetaSecSigner(args.serial, launch=not args.no_launch)
    all_products: list[dict[str, Any]] = []
    page_summaries: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    next_pagination: str | None = None

    responses_path = Path(args.responses_jsonl)
    responses_path.parent.mkdir(parents=True, exist_ok=True)

    try:
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
                    template["url"],
                    body,
                    template.get("headers") or {},
                    signer,
                    args.timeout,
                )
                raw, rows = extract_products(text, page_index)
                for row in rows:
                    row["page_index"] = page_index
                added = dedupe_append(all_products, seen_ids, rows)

                summary = {
                    "page_index": page_index,
                    "http_status": http_status,
                    "status_code": raw.get("status_code"),
                    "has_more": raw.get("has_more"),
                    "product_count": len(rows),
                    "new_product_count": added,
                    "product_ids": [r.get("product_id") for r in rows],
                    "response_header_keys": sorted(response_headers.keys()),
                }
                page_summaries.append(summary)
                response_file.write(json.dumps({
                    "summary": summary,
                    "response": raw,
                }, ensure_ascii=False) + "\n")
                response_file.flush()

                print(json.dumps(summary, ensure_ascii=False), flush=True)

                if http_status != 200 or not is_success(raw):
                    break
                next_pagination = raw.get("pagination_params")
                if not raw.get("has_more") or not next_pagination:
                    break
                if args.stop_on_no_new and page_index > 0 and added == 0:
                    break

                page_index += 1

                has_next_iteration = args.pages <= 0 or page_index < args.pages
                if has_next_iteration and args.delay_ms > 0:
                    jitter = random.randint(0, max(0, args.jitter_ms))
                    time.sleep((args.delay_ms + jitter) / 1000)
    finally:
        signer.close()

    out_csv = Path(args.output)
    write_csv(out_csv, all_products)

    summary_out = {
        "sec_shop_id": sec_shop_id,
        "pages_requested": "until_end" if args.pages <= 0 else args.pages,
        "max_pages": args.max_pages,
        "pages_done": len(page_summaries),
        "products": len(all_products),
        "output": str(out_csv),
        "responses_jsonl": str(responses_path),
        "pages": page_summaries,
    }
    summary_path = Path(args.summary)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary_out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "pages_done": len(page_summaries),
        "products": len(all_products),
        "output": str(out_csv),
        "summary": str(summary_path),
    }, ensure_ascii=False))

    return 0 if page_summaries and all(p.get("status_code") == 0 for p in page_summaries) else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Signed pure-Python HTTP crawler for Douyin shop product BFF.")
    parser.add_argument("--capture", default="output/shop-store-capture.json", help="capture JSON with logged-in BFF request headers/body")
    parser.add_argument("--request-index", type=int, default=0, help="captured request index for the first page")
    parser.add_argument("--next-request-index", type=int, default=1, help="captured request index used as page-2+ body template")
    parser.add_argument("--sec-shop-id", default="", help="override sec_shop_id; default comes from captured form body")
    parser.add_argument("--pages", type=int, default=0, help="0 or negative = crawl until has_more=false")
    parser.add_argument("--max-pages", type=int, default=0, help="optional hard cap when --pages <= 0; 0 = no cap")
    parser.add_argument("--serial", default="127.0.0.1:16384")
    parser.add_argument("--no-launch", action="store_true")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--delay-ms", type=int, default=2500)
    parser.add_argument("--jitter-ms", type=int, default=1200)
    parser.add_argument("--stop-on-no-new", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--output", default="output/store-products-http.csv")
    parser.add_argument("--summary", default="output/store-products-http.summary.json")
    parser.add_argument("--responses-jsonl", default="output/store-products-http.responses.jsonl")
    return parser


if __name__ == "__main__":
    raise SystemExit(crawl(build_parser().parse_args()))
