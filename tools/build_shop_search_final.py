from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.extract_store_product_bff import parse_json_strings, find_product_objects, normalize_product


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: list[dict[str, str]], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def is_golden_goose(title: str) -> bool:
    s = title.lower()
    compact = re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", s)
    return (
        ("golden" in compact and "goose" in compact)
        or "ggdb" in compact
        or "黄金鹅" in compact
    )


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


def load_capture_products(capture_paths: list[Path]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for path in capture_paths:
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        for response_index, resp in enumerate(data.get("responseBodies", [])):
            text = resp.get("utf8") or ""
            if not text.lstrip().startswith(("{", "[")):
                continue
            try:
                raw = json.loads(text)
            except Exception:
                continue
            for _, obj in find_product_objects(parse_json_strings(raw)):
                row = normalize_product(obj, response_index, len(out))
                pid = str(row.get("product_id") or row.get("promotion_id") or "")
                if pid:
                    out[pid] = row
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ids", type=Path, default=Path("output/golden-goose-shop-search-product-ids.csv"))
    parser.add_argument(
        "--details",
        type=Path,
        nargs="+",
        default=[
            Path("output/golden-goose-shop-search-h5-details.csv"),
            Path("output/retry-failed-h5-details.csv"),
            Path("output/retry-one-h5-detail.csv"),
            Path("output/miehaha-h5-details.csv"),
        ],
    )
    parser.add_argument("--capture-glob", default="output/golden-goose-shop-*-capture.json")
    parser.add_argument("--output", type=Path, default=Path("output/golden-goose-search-shops-products.csv"))
    parser.add_argument("--index-output", type=Path, default=Path("output/golden-goose-search-shops-products.index.csv"))
    parser.add_argument("--summary", type=Path, default=Path("output/golden-goose-search-shops-products.summary.json"))
    args = parser.parse_args()

    id_rows = read_csv(args.ids)
    meta_by_id = {row["product_id"]: row for row in id_rows if row.get("product_id")}

    detail_by_id: dict[str, dict[str, str]] = {}
    for path in args.details:
        if not path.exists():
            continue
        for row in read_csv(path):
            pid = row.get("product_id") or ""
            if not pid:
                continue
            # Prefer later retry rows when they contain a title.
            if row.get("title") or pid not in detail_by_id:
                detail_by_id[pid] = row

    capture_products = load_capture_products(sorted(Path().glob(args.capture_glob)))

    index_rows: list[dict[str, str]] = []
    final_rows: list[dict[str, str]] = []
    for pid, meta in meta_by_id.items():
        detail = detail_by_id.get(pid, {})
        cap = capture_products.get(pid, {})
        title = detail.get("title") or str(cap.get("title") or "")
        shop_name = detail.get("shop_name") or str(cap.get("shop_name") or meta.get("shop_name_from_card") or "")
        price = (
            meta.get("card_price")
            or str(cap.get("show_price_yuan") or "")
            or detail.get("price")
            or ""
        )
        sales = normalize_sales_for_final(
            cap.get("sales_display") or cap.get("sale_desc") or detail.get("sales"),
            cap.get("sales") if cap.get("sales") is not None else detail.get("sales"),
        )
        row = {
            "product_id": pid,
            "sec_shop_id": meta.get("sec_shop_id", ""),
            "source_capture": meta.get("capture", ""),
            "card_order": meta.get("card_order", ""),
            "品名": title,
            "店铺名": shop_name,
            "价格": price,
            "销量": sales,
            "分享链接": detail.get("share_link") or f"https://v.douyin.com/{pid}",
            "detail_url": detail.get("detail_url", ""),
            "is_golden_goose": "1" if is_golden_goose(title) else "0",
            "http_status": detail.get("http_status", ""),
            "status_code": detail.get("status_code", ""),
            "msg": detail.get("msg", ""),
        }
        index_rows.append(row)
        if row["is_golden_goose"] == "1":
            final_rows.append({k: row[k] for k in ["品名", "店铺名", "价格", "销量", "分享链接"]})

    write_csv(args.index_output, index_rows, [
        "product_id",
        "sec_shop_id",
        "source_capture",
        "card_order",
        "品名",
        "店铺名",
        "价格",
        "销量",
        "分享链接",
        "detail_url",
        "is_golden_goose",
        "http_status",
        "status_code",
        "msg",
    ])
    write_csv(args.output, final_rows, ["品名", "店铺名", "价格", "销量", "分享链接"])

    summary = {
        "input_ids": len(id_rows),
        "details": len(detail_by_id),
        "capture_products": len(capture_products),
        "golden_goose_rows": len(final_rows),
        "output": str(args.output),
        "index_output": str(args.index_output),
    }
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
