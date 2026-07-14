from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from native_sign import NativeMetaSecSigner
from tools.extract_store_product_bff import find_product_objects, normalize_product, parse_json_strings
from tools.verify_store_product_bff import signed_post


FIELD_TITLE = "\u54c1\u540d"
FIELD_SHOP = "\u5e97\u94fa\u540d"
FIELD_PRICE = "\u4ef7\u683c"
FIELD_SALES = "\u9500\u91cf"
FIELD_SHARE = "\u5206\u4eab\u94fe\u63a5"
FINAL_FIELDS = [FIELD_TITLE, FIELD_SHOP, FIELD_PRICE, FIELD_SALES, FIELD_SHARE]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def product_id_from_share(row: dict[str, str]) -> str:
    return (row.get(FIELD_SHARE) or "").rstrip("/").rsplit("/", 1)[-1]


def rows_from_raw(raw: Any, source: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, (_, obj) in enumerate(find_product_objects(parse_json_strings(raw))):
        row = normalize_product(obj, 0, index)
        pid = str(row.get("product_id") or row.get("promotion_id") or "")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        row["source"] = source
        rows.append(row)
    return rows


def load_existing_capture_sales(capture_paths: list[Path]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for capture_path in capture_paths:
        try:
            capture = json.loads(capture_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for resp_index, resp in enumerate(capture.get("responseBodies", [])):
            url = resp.get("url") or ""
            text = resp.get("utf8") or ""
            if "/shop/bff/tab/" not in url or not text.lstrip().startswith(("{", "[")):
                continue
            try:
                raw = json.loads(text)
            except Exception:
                continue
            for row in rows_from_raw(raw, f"{capture_path.name}:responseBodies[{resp_index}]"):
                pid = str(row.get("product_id") or row.get("promotion_id") or "")
                out[pid] = row
    return out


def replay_capture_request(
    capture_path: Path,
    signer: NativeMetaSecSigner,
    response_jsonl,
    timeout: float,
) -> list[dict[str, Any]]:
    capture = json.loads(capture_path.read_text(encoding="utf-8"))
    reqs = [
        req for req in capture.get("requestBodies", [])
        if "/shop/bff/tab/" in (req.get("url") or "") and req.get("utf8")
    ]
    if not reqs:
        return []
    req = reqs[0]
    http_status, response_headers, text = signed_post(
        req["url"],
        req["utf8"],
        req.get("headers") or {},
        signer,
        timeout,
    )
    event = {
        "capture": capture_path.name,
        "http_status": http_status,
        "response_length": len(text),
        "response_header_keys": sorted(response_headers.keys()),
    }
    try:
        raw = json.loads(text)
        event["status_code"] = raw.get("status_code")
        rows = rows_from_raw(raw, f"{capture_path.name}:replay")
        event["product_count"] = len(rows)
    except Exception as error:
        raw = {"parse_error": str(error), "text_head": text[:500]}
        rows = []
        event["parse_error"] = str(error)
    response_jsonl.write(json.dumps({"event": event, "response": raw}, ensure_ascii=False) + "\n")
    response_jsonl.flush()
    print(json.dumps(event, ensure_ascii=False), flush=True)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Recover exact numeric sales for search-shop products via /shop/bff/tab/.")
    parser.add_argument("--id-csv", type=Path, default=Path("output/golden-goose-shop-search-product-ids.csv"))
    parser.add_argument("--final", type=Path, default=Path("output/golden-goose-final-with-search-shops.old-numeric-sales.csv"))
    parser.add_argument("--capture-dir", type=Path, default=Path("output"))
    parser.add_argument("--serial", default="127.0.0.1:16384")
    parser.add_argument("--no-launch", action="store_true")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--delay-ms", type=int, default=2500)
    parser.add_argument("--sales-output", type=Path, default=Path("output/golden-goose-shop-search-exact-sales.csv"))
    parser.add_argument("--responses-jsonl", type=Path, default=Path("output/golden-goose-shop-search-bff-tab-replay.responses.jsonl"))
    parser.add_argument("--output", type=Path, default=Path("output/golden-goose-final-exact-sales-with-search-shops.csv"))
    parser.add_argument("--summary", type=Path, default=Path("output/golden-goose-final-exact-sales-with-search-shops.summary.json"))
    args = parser.parse_args()

    id_rows = read_csv(args.id_csv)
    capture_by_pid = {row.get("product_id", ""): row.get("capture", "") for row in id_rows if row.get("product_id")}
    target_pids = set(capture_by_pid)
    capture_paths = sorted({args.capture_dir / name for name in capture_by_pid.values() if name})

    sales_by_pid = load_existing_capture_sales(capture_paths)
    missing = {pid for pid in target_pids if pid not in sales_by_pid}
    replay_paths = [p for p in capture_paths if any(pid in missing and capture_by_pid.get(pid) == p.name for pid in target_pids)]

    args.responses_jsonl.parent.mkdir(parents=True, exist_ok=True)
    signer = NativeMetaSecSigner(args.serial, launch=not args.no_launch)
    try:
        with args.responses_jsonl.open("w", encoding="utf-8") as response_file:
            for index, capture_path in enumerate(replay_paths):
                try:
                    rows = replay_capture_request(capture_path, signer, response_file, args.timeout)
                    for row in rows:
                        pid = str(row.get("product_id") or row.get("promotion_id") or "")
                        if pid:
                            sales_by_pid[pid] = row
                except Exception as error:
                    event = {"capture": capture_path.name, "error": str(error)}
                    response_file.write(json.dumps({"event": event}, ensure_ascii=False) + "\n")
                    response_file.flush()
                    print(json.dumps(event, ensure_ascii=False), flush=True)
                if index + 1 < len(replay_paths) and args.delay_ms > 0:
                    time.sleep(args.delay_ms / 1000)
    finally:
        signer.close()

    sales_rows: list[dict[str, Any]] = []
    for pid in sorted(target_pids):
        row = sales_by_pid.get(pid, {})
        sales_rows.append({
            "product_id": pid,
            "capture": capture_by_pid.get(pid, ""),
            "sales": row.get("sales", ""),
            "sale_desc": row.get("sale_desc", ""),
            "sales_display": row.get("sales_display", ""),
            "title": row.get("title", ""),
            "shop_name": row.get("shop_name", ""),
            "source": row.get("source", ""),
        })
    write_csv(args.sales_output, sales_rows, ["product_id", "capture", "sales", "sale_desc", "sales_display", "title", "shop_name", "source"])

    final_rows = read_csv(args.final)
    filled = 0
    still_blank = 0
    for row in final_rows:
        pid = product_id_from_share(row)
        exact = sales_by_pid.get(pid)
        if exact and (row.get(FIELD_SALES) or "") == "":
            value = exact.get("sales")
            if value is not None and value != "":
                row[FIELD_SALES] = str(value)
                filled += 1
        if not (row.get(FIELD_SALES) or "").strip():
            still_blank += 1
    write_csv(args.output, final_rows, FINAL_FIELDS)

    summary = {
        "id_rows": len(id_rows),
        "captures": len(capture_paths),
        "replayed_captures": len(replay_paths),
        "sales_found_for_search_ids": sum(1 for pid in target_pids if pid in sales_by_pid and sales_by_pid[pid].get("sales") not in (None, "")),
        "final_rows": len(final_rows),
        "filled_final_blank_sales": filled,
        "final_blank_sales": still_blank,
        "final_zero_sales": sum(1 for row in final_rows if (row.get(FIELD_SALES) or "").strip() == "0"),
        "output": str(args.output),
        "sales_output": str(args.sales_output),
        "responses_jsonl": str(args.responses_jsonl),
    }
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
