#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate a final Douyin Mall CSV with official v.douyin.com short links.

The official app copy flow ends with:

    POST https://lf.snssdk.com/shorten/
    body: targets=<long-url>&belong=douyinecommerce&persist=1

This endpoint is the actual official short-link generator.  It does not need
the native signer for the simple product-detail target, and `persist=1` makes
the same target resolve to the same official short URL.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import json
import re
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any

import requests


FIELD_TITLE = "品名"
FIELD_SHOP = "店铺名"
FIELD_PRICE = "价格"
FIELD_SALES = "销量"
FIELD_SHARE = "分享链接"
FIELDS = [FIELD_TITLE, FIELD_SHOP, FIELD_PRICE, FIELD_SALES, FIELD_SHARE]

PRODUCT_ID_RE = re.compile(r"\b(\d{16,22})\b")
ID_QUERY_RE = re.compile(r"[?&]id=(\d{16,22})\b")
SHORT_RE = re.compile(r"https://v\.douyin\.com/[A-Za-z0-9_-]+/?")


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = [{k: (v or "") for k, v in row.items()} for row in reader]
    return rows


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in FIELDS})


def product_id_from_row(row: dict[str, str]) -> str:
    share = row.get(FIELD_SHARE, "")
    match = ID_QUERY_RE.search(share)
    if match:
        return match.group(1)
    haystack = " ".join(str(row.get(k, "")) for k in list(row.keys()) + [FIELD_SHARE])
    match = PRODUCT_ID_RE.search(haystack)
    return match.group(1) if match else ""


def official_target(product_id: str) -> str:
    # Minimal Douyin Mall product target. The official short-link endpoint wraps
    # this into v.douyin.com and the short link 302s back to this target.
    return f"https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id={product_id}"


def full_copy_text(short_url: str, title: str) -> str:
    short_url = short_url if short_url.endswith("/") else f"{short_url}/"
    return f"【抖音商城】{short_url} {title}\n长按复制此条消息，打开抖音商城搜索，查看商品详情！"


def shorten_one(session: requests.Session, product_id: str, timeout: float, retries: int) -> str:
    target = official_target(product_id)
    body = {
        "targets": target,
        "belong": "douyinecommerce",
        "persist": "1",
    }
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            resp = session.post(
                "https://lf.snssdk.com/shorten/",
                data=body,
                timeout=timeout,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "User-Agent": "com.ss.android.ugc.livelite/390501",
                },
            )
            resp.raise_for_status()
            payload: dict[str, Any] = resp.json()
            if payload.get("code") != 0:
                raise RuntimeError(f"shorten code={payload.get('code')} message={payload.get('message')}")
            data = payload.get("data") or []
            if not data:
                raise RuntimeError("shorten returned empty data")
            short_url = str(data[0].get("short_url") or "")
            if not SHORT_RE.fullmatch(short_url if short_url.endswith("/") else f"{short_url}/"):
                raise RuntimeError(f"invalid short_url={short_url!r}")
            return short_url if short_url.endswith("/") else f"{short_url}/"
        except Exception as exc:  # noqa: BLE001 - CLI should keep retrying.
            last_error = exc
            if attempt < retries:
                time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(str(last_error) if last_error else "shorten failed")


def load_checkpoint(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {str(k): str(v) for k, v in data.items() if v}
    except Exception:
        return {}


def save_checkpoint(path: Path, data: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="output/FINAL-golden-goose-products.csv")
    parser.add_argument("--output", default="output/FINAL-golden-goose-products-final.csv")
    parser.add_argument("--checkpoint", default="output/official-shorten-checkpoint.json")
    parser.add_argument("--summary", default="output/official-shorten-summary.json")
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--verify-redirects", type=int, default=5, help="verify first N short URLs with HEAD/GET")
    args = parser.parse_args()

    in_path = Path(args.input)
    out_path = Path(args.output)
    checkpoint_path = Path(args.checkpoint)
    rows = read_csv(in_path)
    checkpoint = load_checkpoint(checkpoint_path)

    product_ids: list[str] = []
    row_pid: list[str] = []
    missing: list[int] = []
    for idx, row in enumerate(rows):
        pid = product_id_from_row(row)
        row_pid.append(pid)
        if pid:
            product_ids.append(pid)
        else:
            missing.append(idx)
    unique_ids = sorted(set(product_ids))
    pending = [pid for pid in unique_ids if not checkpoint.get(pid)]

    print(f"[load] rows={len(rows)} unique_product_ids={len(unique_ids)} cached={len(checkpoint)} pending={len(pending)}")
    errors: dict[str, str] = {}

    def task(pid: str) -> tuple[str, str, str]:
        with requests.Session() as session:
            try:
                return pid, shorten_one(session, pid, args.timeout, args.retries), ""
            except Exception as exc:  # noqa: BLE001
                return pid, "", str(exc)

    completed = 0
    if pending:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            futures = {executor.submit(task, pid): pid for pid in pending}
            for future in concurrent.futures.as_completed(futures):
                pid, short_url, error = future.result()
                if short_url:
                    checkpoint[pid] = short_url
                    completed += 1
                else:
                    errors[pid] = error
                if (completed + len(errors)) % 20 == 0 or completed + len(errors) == len(pending):
                    save_checkpoint(checkpoint_path, checkpoint)
                    print(f"[shorten] done={completed} errors={len(errors)} / {len(pending)}")

    save_checkpoint(checkpoint_path, checkpoint)

    for idx, row in enumerate(rows):
        pid = row_pid[idx]
        short_url = checkpoint.get(pid, "") if pid else ""
        if short_url:
            row[FIELD_SHARE] = full_copy_text(short_url, row.get(FIELD_TITLE, ""))

    write_csv(out_path, rows)

    verified: list[dict[str, str]] = []
    if args.verify_redirects > 0:
        sample = [checkpoint[pid] for pid in unique_ids if checkpoint.get(pid)][: args.verify_redirects]
        for short_url in sample:
            try:
                resp = requests.get(short_url, allow_redirects=False, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
                verified.append({
                    "short_url": short_url,
                    "status": str(resp.status_code),
                    "location": resp.headers.get("Location", ""),
                })
            except Exception as exc:  # noqa: BLE001
                verified.append({"short_url": short_url, "error": str(exc)})

    summary = {
        "input": str(in_path),
        "output": str(out_path),
        "rows": len(rows),
        "unique_product_ids": len(unique_ids),
        "missing_product_id_rows": missing,
        "shortened_total": sum(1 for pid in unique_ids if checkpoint.get(pid)),
        "completed_this_run": completed,
        "errors": errors,
        "verified_redirects": verified,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    Path(args.summary).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if not errors and not missing else 2


if __name__ == "__main__":
    raise SystemExit(main())
