"""Capture signed network traffic around a single ADB tap.

This is intentionally smaller/safer than capture-open-uri.py for the search
shop-tab workflow: it does not deep-link into arbitrary shops, it only taps the
currently visible UI (for example a "进店" button) and records the requests that
the logged-in app itself emits.
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import frida


ROOT = Path(__file__).parent.parent
APP_ID = "com.ss.android.ugc.livelite"
SERIAL = "127.0.0.1:16384"
BUNDLE = Path(__file__).with_name("native-signer-agent.bundle.js")

CAPTURE_EVENTS = {
    "security-factor",
    "cronet-security-factor",
    "f3-sign",
    "request-header",
    "connection-final",
    "trace-install-error",
    "output-stream-hooked",
    "request-body-chunk",
    "request-body-error",
    "input-stream-hooked",
    "response-stream",
    "response-body-chunk",
    "response-body-error",
}


def find_process(device: frida.core.Device):
    for process in device.enumerate_processes(scope="full"):
        applications = process.parameters.get("applications", [])
        if process.name == APP_ID or process.name.startswith(APP_ID + ":"):
            return process
        if APP_ID in applications:
            return process
        if "抖音商城" in process.name or "Douyin" in process.name:
            return process
    raise RuntimeError("Douyin Mall process is not running")


def start_app(serial: str, wait_seconds: float = 4.0) -> None:
    subprocess.run(
        ["adb", "-s", serial, "shell", "monkey", "-p", APP_ID, "-c", "android.intent.category.LAUNCHER", "1"],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(wait_seconds)


def attach_with_retry(device: frida.core.Device, serial: str):
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            try:
                process = find_process(device)
            except RuntimeError:
                start_app(serial, wait_seconds=4.0 + attempt)
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
            start_app(serial, wait_seconds=5.0 + attempt * 2.0)
    raise RuntimeError(f"attach failed after retries: {last_error}") from last_error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default=SERIAL)
    parser.add_argument("--x", type=int, required=True)
    parser.add_argument("--y", type=int, required=True)
    parser.add_argument("--pre-seconds", type=float, default=1.0)
    parser.add_argument("--seconds", type=float, default=15.0)
    parser.add_argument("--back", type=int, default=0, help="press Back this many times after capture")
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
            if isinstance(payload, dict) and payload.get("event") in CAPTURE_EVENTS:
                events.append(payload)
                if payload.get("event") == "request-body-chunk":
                    body_chunks.setdefault(payload["streamId"], []).append(base64.b64decode(payload["base64"]))
                if payload.get("event") == "response-body-chunk":
                    response_chunks.setdefault(payload["streamId"], []).append(base64.b64decode(payload["base64"]))
                url = payload.get("url") or ""
                if any(token in url for token in ("shop", "store", "goods", "product", "ecom", "search")):
                    print(json.dumps({
                        "event": payload.get("event"),
                        "url": url.split("?")[0],
                        "method": payload.get("method"),
                        "responseCode": payload.get("responseCode"),
                        "length": payload.get("length"),
                    }, ensure_ascii=False), flush=True)
        elif message["type"] == "error":
            print(json.dumps(message, ensure_ascii=False), flush=True)

    script.on("message", on_message)
    script.load()
    print(json.dumps(script.exports_sync.status(), ensure_ascii=False), flush=True)
    print(json.dumps(script.exports_sync.starttrace(), ensure_ascii=False), flush=True)

    time.sleep(max(0.0, args.pre_seconds))
    subprocess.run(["adb", "-s", args.serial, "shell", "input", "tap", str(args.x), str(args.y)], check=True)
    time.sleep(max(0.0, args.seconds))

    try:
        script.exports_sync.stoptrace()
    finally:
        script.unload()
        session.detach()

    for _ in range(max(0, args.back)):
        subprocess.run(
            ["adb", "-s", args.serial, "shell", "input", "keyevent", "4"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(0.8)

    output = Path(args.output) if args.output else ROOT / "output" / f"tap-capture-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    output.parent.mkdir(parents=True, exist_ok=True)

    def first_event_for(stream_id: str) -> dict:
        return next((e for e in events if e.get("streamId") == stream_id and e.get("url")), {})

    bodies = []
    for stream_id, chunks in body_chunks.items():
        raw = b"".join(chunks)
        first = first_event_for(stream_id)
        bodies.append({
            "streamId": stream_id,
            "url": first.get("url"),
            "headers": first.get("headers"),
            "length": len(raw),
            "base64": base64.b64encode(raw).decode("ascii"),
            "utf8": raw.decode("utf-8", errors="replace"),
        })

    responses = []
    for stream_id, chunks in response_chunks.items():
        raw = b"".join(chunks)
        first = first_event_for(stream_id)
        responses.append({
            "streamId": stream_id,
            "url": first.get("url"),
            "status": first.get("responseCode"),
            "headers": first.get("responseHeaders"),
            "length": len(raw),
            "base64": base64.b64encode(raw).decode("ascii"),
            "utf8": raw.decode("utf-8", errors="replace"),
        })

    output.write_text(json.dumps({
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "pid": process.pid,
        "tap": {"x": args.x, "y": args.y},
        "events": events,
        "requestBodies": bodies,
        "responseBodies": responses,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "events": len(events),
        "requestBodies": len(bodies),
        "responseBodies": len(responses),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
