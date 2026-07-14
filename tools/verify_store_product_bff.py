from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import sys
import time
import urllib.parse
import urllib.request
import zlib
from pathlib import Path
from typing import Any

try:
    import brotli  # type: ignore
except Exception:  # pragma: no cover
    brotli = None

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from native_sign import NativeMetaSecSigner
from tools.extract_store_product_bff import parse_json_strings, find_product_objects, normalize_product

TARGET_PATH = "/aweme/v1/store/product/bff/"


def decode_body(raw: bytes, encoding: str | None) -> str:
    enc = (encoding or "").lower().strip()
    if "br" in enc and brotli is not None:
        raw = brotli.decompress(raw)
    elif "gzip" in enc:
        raw = gzip.decompress(raw)
    elif "deflate" in enc:
        raw = zlib.decompress(raw)
    return raw.decode("utf-8", errors="replace")


def update_url_time(url: str, now_ms: int | None = None) -> str:
    now_ms = now_ms or int(time.time() * 1000)
    parsed = urllib.parse.urlsplit(url)
    pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    out: list[tuple[str, str]] = []
    for key, value in pairs:
        if key == "_rticket":
            value = str(now_ms)
        elif key == "ts":
            value = str(now_ms // 1000)
        out.append((key, value))
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(out), parsed.fragment))


def headers_for_request(captured: dict[str, Any], body: bytes, extra: dict[str, str]) -> dict[str, str]:
    headers = {str(k): str(v) for k, v in (captured or {}).items()}
    # urllib sets Host/Content-Length; stale lengths break when body changes.
    for key in ["Content-Length", "content-length", "Accept-Encoding", "accept-encoding"]:
        headers.pop(key, None)
    now_ms = int(time.time() * 1000)
    headers["X-SS-REQ-TICKET"] = str(now_ms)
    headers["activity_now_client"] = str(now_ms + 2000)
    headers["X-SS-STUB"] = hashlib.md5(body).hexdigest().upper()
    headers.setdefault("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
    headers.setdefault("Accept", "application/json")
    headers.setdefault("User-Agent", "com.ss.android.ugc.livelite/390500 (Linux; U; Android 15; zh_CN; MI 5s; Build/V417IR; Cronet/TTNetVersion:9c39d3a4 2025-03-20 QuicVersion:55bb0079 2024-11-18)")
    headers.update(extra)
    return headers


def signed_post(url: str, body_text: str, headers: dict[str, str], signer: NativeMetaSecSigner, timeout: float = 30.0) -> tuple[int, dict[str, str], str]:
    body = body_text.encode("utf-8")
    url = update_url_time(url)
    base_headers = headers_for_request(headers, body, {})
    sign_headers = signer.sign(url, base_headers)
    final_headers = headers_for_request(headers, body, sign_headers)

    request = urllib.request.Request(url, data=body, headers=final_headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as resp:
        raw = resp.read()
        response_headers = {k.lower(): v for k, v in resp.headers.items()}
        text = decode_body(raw, response_headers.get("content-encoding"))
        return resp.status, response_headers, text


def load_capture_request(capture_path: Path, index: int = 0) -> dict[str, Any]:
    capture = json.loads(capture_path.read_text(encoding="utf-8"))
    matches = [b for b in capture.get("requestBodies", []) if TARGET_PATH in (b.get("url") or "")]
    if not matches:
        raise RuntimeError(f"no {TARGET_PATH} requestBodies in {capture_path}")
    return matches[index]


def extract_products(response_text: str, response_index: int = 0) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    raw = json.loads(response_text)
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
        rows.append(normalize_product(obj, response_index, len(rows)))
    return raw, rows


def write_products_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = list(rows[0].keys()) if rows else ["product_id", "title"]
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def verify(args: argparse.Namespace) -> int:
    req = load_capture_request(Path(args.capture), args.request_index)
    signer = NativeMetaSecSigner(args.serial, launch=not args.no_launch)
    try:
        http_status, response_headers, text = signed_post(req["url"], req["utf8"], req.get("headers") or {}, signer, args.timeout)
    finally:
        signer.close()
    raw, products = extract_products(text)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "http_status": http_status,
        "status_code": raw.get("status_code"),
        "has_more": raw.get("has_more"),
        "product_count": len(products),
        "product_ids": [p["product_id"] for p in products],
        "response_headers": response_headers,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.products_csv:
        write_products_csv(Path(args.products_csv), products)
    print(json.dumps({
        "http_status": http_status,
        "status_code": raw.get("status_code"),
        "has_more": raw.get("has_more"),
        "product_count": len(products),
        "output": str(out),
        "products_csv": args.products_csv,
    }, ensure_ascii=False))
    return 0 if http_status == 200 and raw.get("status_code") == 0 else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="End-to-end signed replay for Douyin shop product BFF.")
    parser.add_argument("--capture", default="output/shop-store-capture.json")
    parser.add_argument("--request-index", type=int, default=0)
    parser.add_argument("--serial", default="127.0.0.1:16384")
    parser.add_argument("--no-launch", action="store_true")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--output", default="output/store-product-bff.verify.json")
    parser.add_argument("--products-csv", default="output/store-product-bff.verify.products.csv")
    return parser


if __name__ == "__main__":
    raise SystemExit(verify(build_parser().parse_args()))
