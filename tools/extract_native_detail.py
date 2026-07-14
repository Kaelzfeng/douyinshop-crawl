"""Extract the native product detail stream request from a Frida capture.

The capture is produced by:
    python hook/capture-native-sign.py --output output/native-response-capture.json

This tool writes:
  - a compact JSON request template with URL, method, headers and body metadata
  - a raw form body file

It also verifies that X-SS-STUB is the uppercase MD5 of the captured body.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
from typing import Any


TARGET = "/ecom/product/detail/stream/"


def find_detail_request(capture: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    events = capture.get("events") or []
    bodies = capture.get("requestBodies") or []
    for body in bodies:
        url = body.get("url") or ""
        if TARGET not in url:
            continue
        stream_id = body.get("streamId")
        event = next(
            (
                item
                for item in events
                if item.get("event") == "connection-final"
                and item.get("streamId") == stream_id
                and TARGET in (item.get("url") or "")
            ),
            None,
        )
        if event is not None:
            return event, body
    raise SystemExit(f"no {TARGET} request found in capture")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("capture", help="capture JSON produced by hook/capture-native-sign.py")
    parser.add_argument("--output", default="output/native-detail-request.json")
    parser.add_argument("--body-output", default="output/native-detail-request.body")
    args = parser.parse_args()

    capture_path = Path(args.capture)
    capture = json.loads(capture_path.read_text(encoding="utf-8"))
    event, body = find_detail_request(capture)
    raw_body = base64.b64decode(body["base64"])
    headers = event.get("headers") or {}
    body_md5 = hashlib.md5(raw_body).hexdigest().upper()
    captured_stub = headers.get("X-SS-STUB") or headers.get("x-ss-stub")

    template = {
        "source": str(capture_path),
        "capturedAt": capture.get("capturedAt"),
        "productId": capture.get("productId"),
        "method": event.get("method") or "POST",
        "url": event.get("url") or body.get("url"),
        "headers": headers,
        "bodyFile": args.body_output,
        "bodyLength": len(raw_body),
        "xSsStub": captured_stub,
        "computedBodyMd5": body_md5,
        "stubMatchesBody": captured_stub == body_md5,
    }

    output = Path(args.output)
    body_output = Path(args.body_output)
    output.parent.mkdir(parents=True, exist_ok=True)
    body_output.parent.mkdir(parents=True, exist_ok=True)
    body_output.write_bytes(raw_body)
    output.write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(template, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
