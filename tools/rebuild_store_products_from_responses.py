from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.crawl_store_products_http import write_csv
from tools.extract_store_product_bff import find_product_objects, normalize_product, parse_json_strings


def dedupe_append(rows: list[dict[str, Any]], seen: set[str], candidates: list[dict[str, Any]]) -> int:
    added = 0
    for row in candidates:
        pid = str(row.get("product_id") or row.get("promotion_id") or "")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        rows.append(row)
        added += 1
    return added


def rows_from_response(raw: dict[str, Any], response_index: int) -> list[dict[str, Any]]:
    deep = parse_json_strings(raw)
    product_objects = find_product_objects(deep)
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for _, obj in product_objects:
        base = obj.get("base_info") or {}
        pid = str(base.get("product_id") or base.get("promotion_id") or "")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        row = normalize_product(obj, response_index, len(rows))
        row["page_index"] = response_index
        rows.append(row)
    return rows


def run() -> int:
    parser = argparse.ArgumentParser(description="Rebuild product CSV from crawl *.responses.jsonl files.")
    parser.add_argument("responses", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path, default=None)
    args = parser.parse_args()

    all_rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    page_summaries: list[dict[str, Any]] = []
    response_index = 0
    for path in args.responses:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            raw = item.get("response") or {}
            rows = rows_from_response(raw, response_index)
            added = dedupe_append(all_rows, seen, rows)
            page_summaries.append(
                {
                    "source": str(path),
                    "response_index": response_index,
                    "status_code": raw.get("status_code"),
                    "has_more": raw.get("has_more"),
                    "product_count": len(rows),
                    "new_product_count": added,
                }
            )
            response_index += 1

    write_csv(args.output, all_rows)
    summary = {
        "inputs": [str(path) for path in args.responses if path.exists()],
        "output": str(args.output),
        "responses": response_index,
        "products": len(all_rows),
        "blank_sales": sum(1 for row in all_rows if row.get("sales") in (None, "")),
        "zero_sales": sum(1 for row in all_rows if str(row.get("sales")) == "0"),
        "pages": page_summaries,
    }
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
