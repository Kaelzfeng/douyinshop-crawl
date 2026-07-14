"""Persistent in-process MetaSec signer for Douyin Mall 39.5.0.

The signer attaches to the already initialized Android app and calls:
    NetworkParams.LJIILLIIL(url, headers)

CLI JSONL protocol:
    {"id":1,"op":"status"}
    {"id":2,"op":"sign","url":"https://...","headers":{"accept":"application/json"}}
    {"id":3,"op":"close"}
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import frida


APP_ID = "com.ss.android.ugc.livelite"
DEFAULT_SERIAL = "127.0.0.1:16384"
ROOT = Path(__file__).resolve().parent
DEFAULT_BUNDLE = ROOT / "hook" / "native-signer-agent.bundle.js"


class NativeSignerError(RuntimeError):
    pass


class NativeMetaSecSigner:
    def __init__(
        self,
        serial: str = DEFAULT_SERIAL,
        *,
        bundle_path: str | Path = DEFAULT_BUNDLE,
        launch: bool = True,
        launch_wait: float = 6.0,
    ) -> None:
        self.serial = serial
        self.bundle_path = Path(bundle_path)
        self.launch = launch
        self.launch_wait = launch_wait
        self._device = None
        self._session = None
        self._script = None
        self._lock = threading.RLock()
        self._process: dict[str, Any] | None = None
        self.connect()

    def _start_app(self, *, force_stop: bool = False) -> None:
        if force_stop:
            subprocess.run(
                ["adb", "-s", self.serial, "shell", "am", "force-stop", APP_ID],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            time.sleep(1.0)
        subprocess.run(
            [
                "adb", "-s", self.serial, "shell", "monkey",
                "-p", APP_ID, "-c", "android.intent.category.LAUNCHER", "1",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(self.launch_wait)

    @staticmethod
    def _matches(process) -> bool:
        applications = process.parameters.get("applications", [])
        return (
            process.name == APP_ID
            or process.name.startswith(APP_ID + ":")
            or "抖音商城" in process.name
            or APP_ID in applications
        )

    def _find_process(self):
        assert self._device is not None
        for process in self._device.enumerate_processes(scope="full"):
            if self._matches(process):
                return process
        return None

    def connect(self) -> None:
        with self._lock:
            self.close()
            if not self.bundle_path.exists():
                raise NativeSignerError(f"signer bundle is missing: {self.bundle_path}")

            self._device = frida.get_device(self.serial, timeout=10)
            last_error: Exception | None = None
            for attempt in range(3):
                process = self._find_process()
                if (process is None or attempt > 0) and self.launch:
                    self._start_app(force_stop=attempt > 0)
                    process = self._find_process()
                if process is None:
                    last_error = NativeSignerError(f"Douyin Mall process {APP_ID} is not running")
                    continue

                session = None
                script = None
                try:
                    session = self._device.attach(process.pid, realm="native")
                    script = session.create_script(self.bundle_path.read_text(encoding="utf-8"))
                    script.load()
                    status = script.exports_sync.status()
                    if not status.get("providerInstalled"):
                        raise NativeSignerError("MetaSec provider has not been installed")

                    self._session = session
                    self._script = script
                    self._process = {"pid": process.pid, "name": process.name}
                    return
                except Exception as error:
                    last_error = error
                    if script is not None:
                        try:
                            script.unload()
                        except Exception:
                            pass
                    if session is not None:
                        try:
                            session.detach()
                        except Exception:
                            pass
                    time.sleep(1.5 + attempt)

            raise NativeSignerError(f"attach/init failed after retries: {last_error}") from last_error

    def status(self) -> dict[str, Any]:
        with self._lock:
            if self._script is None:
                return {"connected": False, "process": self._process}
            try:
                agent = self._script.exports_sync.status()
            except Exception as error:
                return {"connected": False, "process": self._process, "error": str(error)}
            return {"connected": True, "process": self._process, "agent": agent}

    def sign(self, url: str, headers: dict[str, str | list[str]] | None = None) -> dict[str, str]:
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            raise TypeError("url must be an absolute HTTP(S) string")
        if headers is not None and not isinstance(headers, dict):
            raise TypeError("headers must be a dictionary")

        with self._lock:
            if self._script is None:
                self.connect()
            assert self._script is not None
            try:
                result = self._script.exports_sync.sign(url, headers or {})
            except (frida.InvalidOperationError, frida.ProcessNotFoundError, frida.TransportError) as error:
                self.connect()
                assert self._script is not None
                try:
                    result = self._script.exports_sync.sign(url, headers or {})
                except Exception as retry_error:
                    raise NativeSignerError(f"sign failed after reconnect: {retry_error}") from retry_error
            except Exception as error:
                raise NativeSignerError(f"sign failed: {error}") from error

            if result is None:
                raise NativeSignerError("MetaSec returned null")
            return {str(key): str(value) for key, value in result.items()}

    def close(self) -> None:
        with self._lock:
            if self._script is not None:
                try:
                    self._script.unload()
                except frida.InvalidOperationError:
                    pass
            if self._session is not None:
                try:
                    self._session.detach()
                except frida.InvalidOperationError:
                    pass
            self._script = None
            self._session = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()


def serve(signer: NativeMetaSecSigner) -> int:
    for line in sys.stdin:
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            op = request.get("op")
            if op == "status":
                result = signer.status()
            elif op == "sign":
                result = signer.sign(request["url"], request.get("headers", {}))
            elif op == "close":
                print(json.dumps({"id": request.get("id"), "ok": True}), flush=True)
                return 0
            else:
                raise NativeSignerError(f"unknown operation: {op}")
            response = {"id": request.get("id"), "ok": True, "result": result}
        except Exception as error:
            response = {"id": request.get("id"), "ok": False, "error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default=DEFAULT_SERIAL)
    parser.add_argument("--no-launch", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--sign-url")
    parser.add_argument("--headers", default="{}")
    args = parser.parse_args()

    with NativeMetaSecSigner(args.serial, launch=not args.no_launch) as signer:
        if args.status:
            print(json.dumps(signer.status(), ensure_ascii=False, indent=2))
            return 0
        if args.sign_url:
            print(json.dumps(signer.sign(args.sign_url, json.loads(args.headers)), ensure_ascii=False, indent=2))
            return 0
        return serve(signer)


if __name__ == "__main__":
    raise SystemExit(main())
