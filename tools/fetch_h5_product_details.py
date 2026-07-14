from __future__ import annotations

import argparse
import csv
import json
import random
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sign import ABogusSigner  # noqa: E402
from tools.verify_h5_api import (  # noqa: E402
    DEFAULT_USER_AGENT,
    ENDPOINT_ORIGIN,
    extract_capture_request,
    expected_product_id,
    latest_capture,
)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def load_template(capture_path: Path | None) -> tuple[str, str, str, str]:
    path = capture_path or latest_capture()
    capture = json.loads(path.read_text(encoding="utf-8"))
    base_url, query, body = extract_capture_request(capture)
    old_id = expected_product_id(body)
    return base_url, query, body, old_id


def replace_product_id(template_body: str, old_id: str, product_id: str) -> str:
    # The captured body contains the product id in a few fields.  Replacing the
    # old id first preserves every unrelated native/H5 param exactly.
    body = template_body.replace(old_id, product_id)
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    from urllib.parse import parse_qsl

    for key, value in parse_qsl(body, keep_blank_values=True):
        if key in {"promotion_ids", "promotion_id", "product_id", "ec_promotion_id"}:
            value = product_id
        pairs.append((key, value))
        seen.add(key)
    if "promotion_ids" not in seen:
        pairs.append(("promotion_ids", product_id))
    return urlencode(pairs)


def first_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def unmask_or_blank(text: Any) -> str:
    s = first_text(text)
    # H5 detail often masks non-authenticated display prices as "2???".
    return "" if "?" in s else s


def walk(obj: Any):
    if isinstance(obj, dict):
        yield obj
        for value in obj.values():
            yield from walk(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from walk(value)


def pick_price(payload: dict[str, Any]) -> str:
    ph = payload.get("promotion_h5") or {}
    basic = ph.get("basic_info_data") or {}
    price_info = basic.get("price_info") or {}
    candidates: list[Any] = []
    for section_name in ("discount_price", "price", "market_price"):
        section = price_info.get(section_name)
        if isinstance(section, dict):
            for key in ("min_price", "max_price", "price", "text"):
                if key in section:
                    candidates.append(section.get(key))
        elif section is not None:
            candidates.append(section)
    for d in walk(payload):
        for key in ("show_price", "sale_price", "min_price", "discount_price", "price"):
            if key in d:
                candidates.append(d.get(key))
    for value in candidates:
        s = unmask_or_blank(value)
        if not s:
            continue
        try:
            # Integer cent/fen values appear in some native payloads; H5 strings
            # are normally already yuan display values.
            n = float(s)
            if n >= 1000 and str(s).isdigit():
                return f"{n / 100:.2f}".rstrip("0").rstrip(".")
        except Exception:
            pass
        return s
    return ""


def pick_sales(payload: dict[str, Any]) -> str:
    candidates: list[Any] = []
    for d in walk(payload):
        for key in ("sales", "sales_desc", "sale_num", "sell_num", "sold_count", "sales_count"):
            if key in d:
                candidates.append(d.get(key))
    for value in candidates:
        s = first_text(value)
        if s:
            return s
    return ""


def parse_detail(payload: dict[str, Any], product_id: str) -> dict[str, str]:
    ph = payload.get("promotion_h5") or {}
    basic = ph.get("basic_info_data") or {}
    title_info = basic.get("title_info") or {}
    shop_basic = ((ph.get("shop_info") or {}).get("basic_info") or {})
    return {
        "product_id": product_id,
        "title": first_text(title_info.get("title") or basic.get("title") or basic.get("name")),
        "shop_name": first_text(shop_basic.get("shop_name")),
        "price": pick_price(payload),
        "sales": pick_sales(payload),
        "detail_url": first_text(payload.get("detail_url")),
        "share_link": f"https://v.douyin.com/{product_id}",
        "status_code": str(payload.get("status_code", "")),
        "msg": first_text(payload.get("msg")),
    }


def fetch_one(
    opener,
    signer: ABogusSigner,
    *,
    base_url: str,
    query: str,
    template_body: str,
    old_id: str,
    product_id: str,
    timeout: float,
) -> tuple[dict[str, str], dict[str, Any]]:
    body = replace_product_id(template_body, old_id, product_id)
    signature = signer.sign(query, body)
    signed_query = f"{query}&a_bogus={quote(signature, safe='')}"
    parsed = urlsplit(base_url)
    url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, signed_query, ""))
    request = Request(
        url,
        data=body.encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": ENDPOINT_ORIGIN,
            "Referer": f"{ENDPOINT_ORIGIN}/",
            "User-Agent": DEFAULT_USER_AGENT,
        },
        method="POST",
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read()
            http_status = response.status
    except HTTPError as error:
        raw = error.read()
        http_status = error.code
    except URLError as error:
        return {
            "product_id": product_id,
            "title": "",
            "shop_name": "",
            "price": "",
            "sales": "",
            "detail_url": "",
            "share_link": f"https://v.douyin.com/{product_id}",
            "status_code": "",
            "msg": str(error.reason),
        }, {"error": str(error.reason)}

    try:
        payload = json.loads(raw)
    except Exception:
        payload = {"status_code": "", "msg": f"non-json http={http_status} bytes={len(raw)}"}
    row = parse_detail(payload, product_id) if isinstance(payload, dict) else parse_detail({}, product_id)
    row["http_status"] = str(http_status)
    row["response_bytes"] = str(len(raw))
    return row, payload if isinstance(payload, dict) else {"raw": str(payload)}


def read_ids(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8-sig")
    ids: list[str] = []
    if path.suffix.lower() == ".json":
        data = json.loads(text)
        if isinstance(data, list):
            for item in data:
                if isinstance(item, str):
                    ids.append(item)
                elif isinstance(item, dict):
                    ids.append(str(item.get("product_id") or item.get("promotion_id") or ""))
        elif isinstance(data, dict):
            for item in data.get("ids", []) or data.get("products", []):
                if isinstance(item, str):
                    ids.append(item)
                elif isinstance(item, dict):
                    ids.append(str(item.get("product_id") or item.get("promotion_id") or ""))
    elif path.suffix.lower() in {".csv", ".tsv"}:
        dialect = "excel-tab" if path.suffix.lower() == ".tsv" else "excel"
        for row in csv.DictReader(text.splitlines(), dialect=dialect):
            ids.append(str(row.get("product_id") or row.get("promotion_id") or row.get("id") or ""))
    else:
        for line in text.splitlines():
            ids.extend(part for part in line.replace(",", " ").split() if part.isdigit())
    out: list[str] = []
    seen: set[str] = set()
    for product_id in ids:
        product_id = "".join(ch for ch in str(product_id) if ch.isdigit())
        if product_id and product_id not in seen:
            out.append(product_id)
            seen.add(product_id)
    return out


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "product_id",
        "title",
        "shop_name",
        "price",
        "sales",
        "share_link",
        "detail_url",
        "http_status",
        "status_code",
        "msg",
        "response_bytes",
    ]
    extras = sorted({k for row in rows for k in row.keys()} - set(fields))
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields + extras, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Douyin product detail via signed H5 pack endpoint.")
    parser.add_argument("ids_file", type=Path)
    parser.add_argument("--capture", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=Path("output/h5-product-details.csv"))
    parser.add_argument("--responses-jsonl", type=Path, default=Path("output/h5-product-details.responses.jsonl"))
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--delay-ms", type=int, default=800)
    parser.add_argument("--jitter-ms", type=int, default=700)
    args = parser.parse_args()

    ids = read_ids(args.ids_file)
    base_url, query, template_body, old_id = load_template(args.capture)
    opener = build_opener(NoRedirect)
    rows: list[dict[str, str]] = []
    args.responses_jsonl.parent.mkdir(parents=True, exist_ok=True)
    with ABogusSigner() as signer, args.responses_jsonl.open("w", encoding="utf-8") as rf:
        for index, product_id in enumerate(ids):
            row, payload = fetch_one(
                opener,
                signer,
                base_url=base_url,
                query=query,
                template_body=template_body,
                old_id=old_id,
                product_id=product_id,
                timeout=args.timeout,
            )
            rows.append(row)
            rf.write(json.dumps({"row": row, "response": payload}, ensure_ascii=False) + "\n")
            rf.flush()
            print(json.dumps({"index": index, **row}, ensure_ascii=False), flush=True)
            if index + 1 < len(ids) and args.delay_ms > 0:
                time.sleep((args.delay_ms + random.randint(0, max(0, args.jitter_ms))) / 1000)
    write_csv(args.output, rows)
    print(json.dumps({"ids": len(ids), "rows": len(rows), "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
