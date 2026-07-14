"""Replay a captured H5 product-detail request with a fresh local a_bogus.

The capture supplies the exact raw query and form body. This verifier removes
only the old a_bogus, signs the unchanged inputs, and sends no cookies or
authorization headers.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sign import ABogusSigner, SignerError  # noqa: E402


ENDPOINT_PATH = "/aweme/v2/shop/promotion/pack/h5/"
ENDPOINT_ORIGIN = "https://haohuo.jinritemai.com"
ENDPOINT_IDENTITY = f"POST {ENDPOINT_ORIGIN}{ENDPOINT_PATH}"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 "
    "Chrome/135 Mobile Safari/537.36"
)


class CaptureError(ValueError):
    """Raised when a capture has no reusable H5 request."""


def latest_capture() -> Path:
    captures = list((ROOT / "output" / "playwright").glob("sign-capture-*.json"))
    if not captures:
        raise CaptureError("no output/playwright/sign-capture-*.json file was found")
    return max(captures, key=lambda path: path.stat().st_mtime)


def extract_capture_request(capture: Mapping[str, Any]) -> tuple[str, str, str]:
    """Return base URL, unsigned raw query, and exact body from a capture."""

    for item in capture.get("transformations", []):
        if not isinstance(item, Mapping):
            continue
        unsigned_url = item.get("unsignedUrl")
        signed_url = item.get("signedUrl")
        body = item.get("body")
        if item.get("identity") != ENDPOINT_IDENTITY:
            continue
        if not isinstance(unsigned_url, str) or not isinstance(signed_url, str):
            continue
        if not isinstance(body, str) or not body:
            continue

        unsigned = urlsplit(unsigned_url)
        signed = urlsplit(signed_url)
        signed_origin = f"{signed.scheme}://{signed.netloc}"
        if unsigned.path != ENDPOINT_PATH or signed.path != ENDPOINT_PATH:
            continue
        if signed_origin != ENDPOINT_ORIGIN:
            continue

        signed_without_a_bogus = []
        removed_signature = False
        for part in signed.query.split("&"):
            name = part.partition("=")[0].lower()
            if name == "a_bogus":
                removed_signature = True
                continue
            signed_without_a_bogus.append(part)

        query = unsigned.query
        if not removed_signature or "&".join(signed_without_a_bogus) != query:
            raise CaptureError("signed H5 URL differs from unsigned URL beyond a_bogus")
        if any(part.partition("=")[0].lower() == "a_bogus" for part in query.split("&")):
            raise CaptureError("unsigned H5 query already contains a_bogus")
        if "verifyFp=" not in query:
            raise CaptureError("captured H5 query has no verifyFp")
        base_url = f"{ENDPOINT_ORIGIN}{ENDPOINT_PATH}"
        return base_url, query, body

    raise CaptureError(f"capture has no signed {ENDPOINT_PATH} transformation with a body")


def expected_product_id(body: str) -> str:
    form = parse_qs(body, keep_blank_values=True)
    for name in ("promotion_ids", "ec_promotion_id"):
        values = form.get(name)
        if values and values[0]:
            return values[0].split(",", 1)[0]
    raise CaptureError("captured request body has no promotion product ID")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def verify(capture_path: Path, timeout: float) -> dict[str, Any]:
    capture = json.loads(capture_path.read_text(encoding="utf-8"))
    base_url, query, body = extract_capture_request(capture)
    product_id = expected_product_id(body)

    with ABogusSigner() as signer:
        signature = signer.sign(query, body)

    signed_query = f"{query}&a_bogus={quote(signature, safe='')}"
    parsed = urlsplit(base_url)
    signed_url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, signed_query, ""))
    origin = f"{parsed.scheme}://{parsed.netloc}"
    request = Request(
        signed_url,
        data=body.encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": origin,
            "Referer": f"{origin}/",
            "User-Agent": os.getenv("DOUYIN_SIGNER_USER_AGENT", DEFAULT_USER_AGENT),
        },
        method="POST",
    )

    try:
        with build_opener(NoRedirect).open(request, timeout=timeout) as response:
            http_status = response.status
            raw_response = response.read()
    except HTTPError as error:
        raise RuntimeError(f"H5 endpoint returned HTTP {error.code}") from error
    except URLError as error:
        raise RuntimeError(f"H5 endpoint request failed: {error.reason}") from error

    try:
        payload = json.loads(raw_response)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"H5 endpoint returned non-JSON data ({len(raw_response)} bytes)"
        ) from error

    if not isinstance(payload, Mapping):
        raise RuntimeError("H5 endpoint returned a JSON value that is not an object")
    status_code = payload.get("status_code")
    promotion_h5 = payload.get("promotion_h5")
    basic_info = promotion_h5.get("basic_info_data") if isinstance(promotion_h5, Mapping) else None
    response_product_id = basic_info.get("product_id") if isinstance(basic_info, Mapping) else None
    shop_info = promotion_h5.get("shop_info") if isinstance(promotion_h5, Mapping) else None
    shop_basic = shop_info.get("basic_info") if isinstance(shop_info, Mapping) else None
    shop_name = shop_basic.get("shop_name") if isinstance(shop_basic, Mapping) else None
    product_matched = str(response_product_id) == product_id
    shop_name_matched = isinstance(shop_name, str) and "GOLDEN GOOSE" in shop_name.upper()
    ok = (
        http_status == 200
        and status_code == 0
        and product_matched
        and shop_name_matched
    )
    return {
        "ok": ok,
        "capture": capture_path.name,
        "endpoint": ENDPOINT_PATH,
        "http_status": http_status,
        "status_code": status_code,
        "product_id": product_id,
        "product_id_matched": product_matched,
        "shop_name_matched": shop_name_matched,
        "a_bogus_length": len(signature),
        "response_bytes": len(raw_response),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify the local bdms signer against a captured Douyin H5 detail request"
    )
    parser.add_argument(
        "capture",
        nargs="?",
        type=Path,
        help="sign-capture JSON; defaults to the newest one",
    )
    parser.add_argument("--capture", dest="capture_option", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--timeout", type=float, default=30.0, help="HTTP timeout in seconds")
    args = parser.parse_args()

    try:
        selected_capture = args.capture_option or args.capture
        capture_path = selected_capture.resolve() if selected_capture else latest_capture()
        result = verify(capture_path, args.timeout)
    except (CaptureError, SignerError, OSError, RuntimeError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
