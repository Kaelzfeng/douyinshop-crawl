"""Capture live NetworkParams security-factor calls while opening a product."""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import frida


ROOT = Path(__file__).parent.parent
APP_ID = "com.ss.android.ugc.livelite"
SERIAL = "127.0.0.1:16384"
BUNDLE = Path(__file__).with_name("native-signer-agent.bundle.js")


def find_process(device: frida.core.Device):
    for process in device.enumerate_processes(scope="full"):
        applications = process.parameters.get("applications", [])
        if process.name == APP_ID or process.name.startswith(APP_ID + ":"):
            return process
        if "抖音商城" in process.name or APP_ID in applications:
            return process
    raise RuntimeError("Douyin Mall process is not running")


def restart_app(serial: str, wait_seconds: float = 7.0) -> None:
    subprocess.run(
        ["adb", "-s", serial, "shell", "am", "force-stop", APP_ID],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        [
            "adb", "-s", serial, "shell", "monkey",
            "-p", APP_ID, "-c", "android.intent.category.LAUNCHER", "1",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(wait_seconds)


def attach_with_retry(device: frida.core.Device, serial: str):
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            process = find_process(device)
            session = device.attach(process.pid, realm="native")
            return process, session
        except (
            frida.ProcessNotRespondingError,
            frida.ProcessNotFoundError,
            frida.TransportError,
            RuntimeError,
        ) as error:
            last_error = error
            restart_app(serial, wait_seconds=7.0 + attempt * 2.0)
    raise RuntimeError(f"attach failed after retries: {last_error}") from last_error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default=SERIAL)
    parser.add_argument("--product-id", default="3713354677006499920")
    parser.add_argument("--schema-from-capture")
    parser.add_argument("--seconds", type=float, default=25.0)
    parser.add_argument("--output")
    args = parser.parse_args()

    device = frida.get_device(args.serial, timeout=10)
    process, session = attach_with_retry(device, args.serial)
    script = session.create_script(BUNDLE.read_text(encoding="utf-8"))
    events: list[dict] = []
    body_chunks: dict[str, list[bytes]] = {}
    response_chunks: dict[str, list[bytes]] = {}

    def on_message(message, _data):
        if message["type"] == "send":
            payload = message["payload"]
            if payload.get("event") in {
                "security-factor", "cronet-security-factor", "f3-sign",
                "request-header", "connection-final", "trace-install-error",
                "output-stream-hooked", "request-body-chunk", "request-body-error",
                "input-stream-hooked", "response-stream", "response-body-chunk",
                "response-body-error",
            }:
                events.append(payload)
                if payload.get("event") == "request-body-chunk":
                    body_chunks.setdefault(payload["streamId"], []).append(
                        base64.b64decode(payload["base64"])
                    )
                if payload.get("event") == "response-body-chunk":
                    response_chunks.setdefault(payload["streamId"], []).append(
                        base64.b64decode(payload["base64"])
                    )
                print(json.dumps(payload, ensure_ascii=False))
        elif message["type"] == "error":
            print(json.dumps(message, ensure_ascii=False))

    script.on("message", on_message)
    script.load()
    print(json.dumps(script.exports_sync.status(), ensure_ascii=False))
    print(json.dumps(script.exports_sync.starttrace(), ensure_ascii=False))
    self_test_url = "https://ecom.ecombdapi.com/aweme/v2/shop/promotion/pack/?native_signer_probe=1"
    print(json.dumps({"selfTest": script.exports_sync.sign(self_test_url, {})}, ensure_ascii=False))

    if args.schema_from_capture:
        capture = json.loads(Path(args.schema_from_capture).read_text(encoding="utf-8"))
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(capture["finalPageUrl"]).query)
        uri = query["detail_schema"][0].replace("sslocal://", "snssdk561124://", 1)
        uri = re.sub(r"3713354677006499920", args.product_id, uri)
    else:
        uri = f"snssdk561124://ec_goods_detail?product_id={args.product_id}&enter_from=copy"
    encoded_uri = base64.b64encode(uri.encode("utf-8")).decode("ascii")
    remote_command = (
        f'URI=$(echo {encoded_uri} | base64 -d); '
        f'am start -a android.intent.action.VIEW -d "$URI" -p {APP_ID}'
    )
    subprocess.run(
        [
            "adb", "-s", args.serial, "shell",
            remote_command,
        ],
        check=True,
    )

    try:
        time.sleep(args.seconds)
    finally:
        try:
            script.exports_sync.stoptrace()
        except Exception:
            pass
        script.unload()
        session.detach()

    output = Path(args.output) if args.output else ROOT / "output" / f"native-security-factor-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    bodies = []
    for stream_id, chunks in body_chunks.items():
        raw = b"".join(chunks)
        first = next(
            (event for event in events if event.get("streamId") == stream_id and event.get("url")),
            {},
        )
        bodies.append(
            {
                "streamId": stream_id,
                "url": first.get("url"),
                "length": len(raw),
                "base64": base64.b64encode(raw).decode("ascii"),
                "utf8": raw.decode("utf-8", errors="replace"),
            }
        )
    responses = []
    for stream_id, chunks in response_chunks.items():
        raw = b"".join(chunks)
        first = next(
            (event for event in events if event.get("streamId") == stream_id and event.get("url")),
            {},
        )
        responses.append(
            {
                "streamId": stream_id,
                "url": first.get("url"),
                "status": first.get("responseCode"),
                "headers": first.get("responseHeaders"),
                "length": len(raw),
                "base64": base64.b64encode(raw).decode("ascii"),
                "utf8": raw.decode("utf-8", errors="replace"),
            }
        )
    output.write_text(
        json.dumps(
            {
                "capturedAt": datetime.now(timezone.utc).isoformat(),
                "pid": process.pid,
                "productId": args.product_id,
                "events": events,
                "requestBodies": bodies,
                "responseBodies": responses,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps({"output": str(output), "events": len(events)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
