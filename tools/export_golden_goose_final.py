from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


FIELD_TITLE = "\u54c1\u540d"
FIELD_SHOP = "\u5e97\u94fa\u540d"
FIELD_PRICE = "\u4ef7\u683c"
FIELD_SALES = "\u9500\u91cf"
FIELD_SHARE = "\u5206\u4eab\u94fe\u63a5"
OFFICIAL_SHOP = "GOLDEN GOOSE\u5b98\u65b9\u65d7\u8230\u5e97"


def clean_price(value: str) -> str:
    value = (value or "").strip()
    if value.endswith(".0"):
        return value[:-2]
    return value


def is_golden_goose(row: dict[str, str]) -> bool:
    haystack = " ".join(
        [
            row.get("title", ""),
            row.get("brand_name", ""),
            row.get(FIELD_TITLE, ""),
            row.get(FIELD_SHOP, ""),
        ]
    ).lower()
    return "golden" in haystack or "goose" in haystack or "ggdb" in haystack


def normalize_sales_for_final(row: dict[str, str]) -> str:
    """Return a true sold-count label for the final 销量 column.

    BFF `sale_desc` is a UI display field.  It can be "已售100+" or
    "107人加购".  The latter is not sales, so leave 销量 blank instead of
    writing a misleading 0.
    """

    display = (
        row.get("sales_display")
        or row.get("sale_desc")
        or row.get("sales_desc")
        or ""
    ).strip()
    raw = (row.get("sales") or row.get(FIELD_SALES) or "").strip()
    if display:
        if display.startswith("\u5df2\u552e"):
            return display.replace("\u5df2\u552e", "", 1).strip()
        if "\u52a0\u8d2d" in display:
            return ""
        return display
    return raw


def convert_row(row: dict[str, str]) -> dict[str, str]:
    title = (row.get("title") or row.get(FIELD_TITLE) or "").strip()
    shop = (row.get("shop_name") or row.get(FIELD_SHOP) or "").strip() or OFFICIAL_SHOP
    price = clean_price(row.get("show_price_yuan") or row.get(FIELD_PRICE) or "")
    sales = normalize_sales_for_final(row)
    product_id = (
        row.get("promotion_id")
        or row.get("product_id")
        or (row.get(FIELD_SHARE, "").rstrip("/").split("/")[-1] if row.get(FIELD_SHARE) else "")
    ).strip()
    return {
        FIELD_TITLE: title,
        FIELD_SHOP: shop,
        FIELD_PRICE: price,
        FIELD_SALES: sales,
        FIELD_SHARE: f"https://v.douyin.com/{product_id}" if product_id else "",
    }


def load_rows(paths: list[Path]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for path in paths:
        if not path.exists():
            continue
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if is_golden_goose(row):
                    converted = convert_row(row)
                    if converted[FIELD_TITLE] or converted[FIELD_SHARE]:
                        rows.append(converted)
    return rows


def dedupe(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for row in rows:
        key = row[FIELD_SHARE] or f"{row[FIELD_TITLE]}\0{row[FIELD_PRICE]}"
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[FIELD_TITLE, FIELD_SHOP, FIELD_PRICE, FIELD_SALES, FIELD_SHARE],
        )
        writer.writeheader()
        writer.writerows(rows)


def run() -> int:
    parser = argparse.ArgumentParser(description="Build final five-column Golden Goose CSV.")
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, default=Path("output/golden-goose-final-products.csv"))
    parser.add_argument("--summary", type=Path, default=Path("output/golden-goose-final-products.summary.json"))
    args = parser.parse_args()

    rows = dedupe(load_rows(args.inputs))
    write_csv(args.output, rows)
    summary = {
        "inputs": [str(path) for path in args.inputs if path.exists()],
        "output": str(args.output),
        "rows": len(rows),
        "columns": [FIELD_TITLE, FIELD_SHOP, FIELD_PRICE, FIELD_SALES, FIELD_SHARE],
        "filter": "title/brand/shop contains golden/goose/ggdb",
    }
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
