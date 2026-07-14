"""Attach to Douyin Mall and expose the in-process NetworkParams signer.

Diagnostic usage:
    python hook/native-signer-rpc.py --status
    python hook/native-signer-rpc.py --sign-url https://aweme.snssdk.com/
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import frida


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default=SERIAL)
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--sign-url")
    parser.add_argument("--headers", default="{}", help="JSON object")
    args = parser.parse_args()

    if not BUNDLE.exists():
        raise RuntimeError(f"missing bundle: {BUNDLE}")

    device = frida.get_device(args.serial, timeout=10)
    process = find_process(device)
    session = device.attach(process.pid, realm="native")
    script = session.create_script(BUNDLE.read_text(encoding="utf-8"))
    script.on("message", lambda message, data: print(json.dumps(message, ensure_ascii=False), file=sys.stderr))
    script.load()

    try:
        print(json.dumps({"process": process.name, "pid": process.pid, "ping": script.exports_sync.ping()}, ensure_ascii=False))
        if args.status or not args.sign_url:
            print(json.dumps(script.exports_sync.status(), ensure_ascii=False, indent=2))
        if args.sign_url:
            headers = json.loads(args.headers)
            result = script.exports_sync.sign(args.sign_url, headers)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    finally:
        script.unload()
        session.detach()


if __name__ == "__main__":
    raise SystemExit(main())
