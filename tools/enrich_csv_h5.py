"""Enrich product CSV fields via signed H5 pack API (goods_detail / promotion pack).

Uses existing capture template + ABogusSigner (no Android share click).

Examples:
  python tools/enrich_csv_h5.py output/semi-smoke.csv --output output/semi-smoke-enriched.csv
  python tools/enrich_csv_h5.py --ids 3752273946104430948,3688078130989367587
  python tools/enrich_csv_h5.py --ids-file tmp/ids.txt --jsonl
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
import time
from pathlib import Path
from typing import Any
from urllib.request import build_opener

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sign import ABogusSigner  # noqa: E402
from tools.fetch_h5_product_details import (  # noqa: E402
    NoRedirect,
    fetch_one,
    load_template,
    read_ids,
)
from tools.verify_h5_api import CaptureError  # noqa: E402

OUTPUT_FIELDS = ["搜索关键词", "商品id", "商品品名", "店铺名", "价格", "销量", "分享的链接"]


def haohuo_link(product_id: str) -> str:
    return (
        "https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html"
        f"?id={product_id}&origin_type=3002070010&h5_origin_type=detail_share_funshopping"
    )


def re_is_bogus_short(link: str, product_id: str) -> bool:
    # fetch_h5_product_details historically wrote fake short links like v.douyin.com/{id}
    return bool(product_id) and link.rstrip("/").endswith(f"v.douyin.com/{product_id}")


def format_sales(sales: str) -> str:
    s = (sales or "").strip()
    if not s:
        return ""
    if s.endswith("件"):
        return s
    if any(ch.isdigit() for ch in s):
        return s if "件" in s or "万" in s else f"{s}件"
    return s


def merge_row(base: dict[str, str], h5: dict[str, str]) -> dict[str, str]:
    pid = base.get("商品id") or h5.get("product_id") or ""
    title = (base.get("商品品名") or "").strip() or (h5.get("title") or "").strip()
    shop = (base.get("店铺名") or "").strip() or (h5.get("shop_name") or "").strip()
    price = (base.get("价格") or "").strip() or (h5.get("price") or "").strip()
    sales = (base.get("销量") or "").strip() or format_sales(h5.get("sales") or "")
    link = (base.get("分享的链接") or "").strip()
    # Keep real short links; otherwise use stable haohuo product page (not pack API URL)
    if not link or re_is_bogus_short(link, pid) or "/aweme/v2/shop/promotion/" in link:
        link = haohuo_link(pid)
    if not link:
        link = haohuo_link(pid)
    return {
        "搜索关键词": base.get("搜索关键词") or "",
        "商品id": pid,
        "商品品名": title,
        "店铺名": shop,
        "价格": price,
        "销量": sales,
        "分享的链接": link,
        "_h5_status": h5.get("status_code") or "",
        "_h5_http": h5.get("http_status") or "",
        "_h5_msg": h5.get("msg") or "",
    }


def read_product_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = []
        for row in reader:
            pid = (row.get("商品id") or row.get("product_id") or row.get("id") or "").strip()
            if not pid:
                # last resort: parse from link
                link = row.get("分享的链接") or ""
                for part in link.replace("?", "&").split("&"):
                    if part.startswith("id=") or part.startswith("product_id="):
                        pid = part.split("=", 1)[1]
                        break
            rows.append(
                {
                    "搜索关键词": row.get("搜索关键词") or row.get("query") or "",
                    "商品id": "".join(ch for ch in pid if ch.isdigit()),
                    "商品品名": row.get("商品品名") or row.get("title") or "",
                    "店铺名": row.get("店铺名") or row.get("shop_name") or "",
                    "价格": row.get("价格") or row.get("price") or "",
                    "销量": row.get("销量") or row.get("sales") or "",
                    "分享的链接": row.get("分享的链接") or row.get("share_link") or "",
                }
            )
        return rows


def write_product_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in OUTPUT_FIELDS})


def main() -> int:
    parser = argparse.ArgumentParser(description="Enrich CSV / product ids via H5 pack API")
    parser.add_argument("csv", type=Path, nargs="?", default=None, help="Input product CSV")
    parser.add_argument("--ids", type=str, default="", help="Comma-separated product ids")
    parser.add_argument("--ids-file", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--capture", type=Path, default=None)
    parser.add_argument("--responses-jsonl", type=Path, default=None)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--delay-ms", type=int, default=600)
    parser.add_argument("--jitter-ms", type=int, default=400)
    parser.add_argument("--only-missing", action="store_true", help="Skip rows that already have title+price")
    parser.add_argument("--jsonl", action="store_true", help="Also print one JSON object per line to stdout")
    args = parser.parse_args()

    rows_in: list[dict[str, str]] = []
    if args.csv:
        rows_in = read_product_csv(args.csv)
    elif args.ids_file:
        for pid in read_ids(args.ids_file):
            rows_in.append(
                {
                    "搜索关键词": "",
                    "商品id": pid,
                    "商品品名": "",
                    "店铺名": "",
                    "价格": "",
                    "销量": "",
                    "分享的链接": haohuo_link(pid),
                }
            )
    elif args.ids:
        for pid in args.ids.split(","):
            pid = "".join(ch for ch in pid if ch.isdigit())
            if pid:
                rows_in.append(
                    {
                        "搜索关键词": "",
                        "商品id": pid,
                        "商品品名": "",
                        "店铺名": "",
                        "价格": "",
                        "销量": "",
                        "分享的链接": haohuo_link(pid),
                    }
                )
    else:
        parser.error("provide csv path, --ids, or --ids-file")

    out_path = args.output
    if out_path is None:
        if args.csv:
            out_path = args.csv.with_name(args.csv.stem + "-h5-enriched.csv")
        else:
            out_path = Path("output/h5-enriched.csv")

    resp_path = args.responses_jsonl or out_path.with_suffix(".responses.jsonl")

    try:
        base_url, query, template_body, old_id = load_template(args.capture)
    except CaptureError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2

    opener = build_opener(NoRedirect)
    rows_out: list[dict[str, str]] = []
    ok_count = 0

    with ABogusSigner() as signer, resp_path.open("w", encoding="utf-8") as rf:
        for index, base in enumerate(rows_in):
            pid = base.get("商品id") or ""
            if not pid:
                rows_out.append(base)
                continue
            if args.only_missing and base.get("商品品名") and base.get("价格"):
                rows_out.append(base)
                continue

            h5_row, payload = fetch_one(
                opener,
                signer,
                base_url=base_url,
                query=query,
                template_body=template_body,
                old_id=old_id,
                product_id=pid,
                timeout=args.timeout,
            )
            merged = merge_row(base, h5_row)
            rows_out.append(merged)
            if merged.get("商品品名") or merged.get("价格"):
                ok_count += 1

            rf.write(
                json.dumps(
                    {
                        "index": index,
                        "product_id": pid,
                        "row": merged,
                        "h5": h5_row,
                        "response": payload,
                        "status_code": payload.get("status_code") if isinstance(payload, dict) else "",
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            rf.flush()

            line = {
                "index": index,
                "product_id": pid,
                "title": merged.get("商品品名", "")[:40],
                "price": merged.get("价格", ""),
                "sales": merged.get("销量", ""),
                "shop": merged.get("店铺名", "")[:20],
                "h5_status": merged.get("_h5_status", ""),
                "http": merged.get("_h5_http", ""),
            }
            print(json.dumps(line, ensure_ascii=False), flush=True)
            if args.jsonl:
                pass  # already printed

            if index + 1 < len(rows_in) and args.delay_ms > 0:
                time.sleep((args.delay_ms + random.randint(0, max(0, args.jitter_ms))) / 1000)

    write_product_csv(out_path, rows_out)
    summary = {
        "ok": ok_count > 0,
        "input_rows": len(rows_in),
        "enriched_with_title_or_price": ok_count,
        "output": str(out_path),
        "responses": str(resp_path),
    }
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0 if ok_count > 0 or not rows_in else 2


if __name__ == "__main__":
    raise SystemExit(main())
