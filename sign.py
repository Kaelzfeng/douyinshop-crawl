"""App-independent a_bogus signer backed by the extracted local bdms runtime.

The Node helper keeps one headless Edge page alive, loads the checked-in bdms
bundle, and calls its VM signer closure directly. It does not attach to Android,
drive the Douyin app, or send an API request.
"""

from __future__ import annotations

import atexit
import json
import os
import queue
import subprocess
import threading
from collections import deque
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlencode, urlsplit


ROOT = Path(__file__).resolve().parent
SERVICE = ROOT / "tools" / "bdms-signer-service.mjs"


class SignerError(RuntimeError):
    """Raised when the local bdms signer cannot start or sign an input."""


class ABogusSigner:
    """Persistent local signer suitable for signing many requests quickly."""

    def __init__(self, *, startup_timeout: float = 45.0) -> None:
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self._process = subprocess.Popen(
            ["node", str(SERVICE)],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            creationflags=creationflags,
        )
        self._responses: queue.Queue[dict[str, Any]] = queue.Queue()
        self._stderr: deque[str] = deque(maxlen=50)
        self._lock = threading.Lock()
        self._next_id = 1
        self._closed = False

        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

        ready = self._get_response(startup_timeout)
        if ready.get("type") != "ready":
            self.close(force=True)
            raise SignerError(self._format_error(ready))
        self.metadata = ready

    def _read_stdout(self) -> None:
        assert self._process.stdout is not None
        for line in self._process.stdout:
            try:
                self._responses.put(json.loads(line))
            except json.JSONDecodeError:
                self._responses.put({"type": "fatal", "error": f"invalid service output: {line!r}"})

    def _read_stderr(self) -> None:
        assert self._process.stderr is not None
        for line in self._process.stderr:
            self._stderr.append(line.rstrip())

    def _get_response(self, timeout: float) -> dict[str, Any]:
        try:
            return self._responses.get(timeout=timeout)
        except queue.Empty as error:
            state = self._process.poll()
            details = "\n".join(self._stderr)
            raise SignerError(
                f"signer service timed out (exit={state})"
                + (f"\n{details}" if details else "")
            ) from error

    def _format_error(self, response: Mapping[str, Any]) -> str:
        message = str(response.get("error", response))
        details = "\n".join(self._stderr)
        return message + (f"\n{details}" if details else "")

    def _request(self, operation: Mapping[str, Any], timeout: float = 15.0) -> dict[str, Any]:
        if self._closed or self._process.poll() is not None:
            raise SignerError("signer service is not running")
        assert self._process.stdin is not None

        with self._lock:
            request_id = self._next_id
            self._next_id += 1
            payload = {"id": request_id, **operation}
            self._process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self._process.stdin.flush()
            response = self._get_response(timeout)
            if response.get("id") != request_id:
                raise SignerError(f"signer protocol desynchronized: {response}")
            if not response.get("ok"):
                raise SignerError(self._format_error(response))
            return response

    def sign(self, query: str, body: str = "") -> str:
        """Sign a raw query string (without '?') and its exact serialized body."""

        if not isinstance(query, str) or not isinstance(body, str):
            raise TypeError("query and body must both be strings")
        return str(self._request({"op": "sign", "query": query.lstrip("?"), "body": body})["a_bogus"])

    def close(self, *, force: bool = False) -> None:
        if self._closed:
            return
        self._closed = True
        if not force and self._process.poll() is None and self._process.stdin is not None:
            try:
                self._process.stdin.write(json.dumps({"id": 0, "op": "close"}) + "\n")
                self._process.stdin.flush()
                self._process.wait(timeout=5)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                force = True
        if force and self._process.poll() is None:
            self._process.terminate()
        for stream in (self._process.stdin, self._process.stdout, self._process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass

    def __enter__(self) -> "ABogusSigner":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def _build_query(url: str, params: Mapping[str, Any] | Sequence[tuple[str, Any]] | None) -> str:
    parsed = urlsplit(url)
    if not parsed.scheme and "?" not in url and "=" in url and params is None:
        return url.lstrip("?")
    query = parsed.query
    if params is not None:
        items = params.items() if isinstance(params, Mapping) else params
        extra = urlencode(list(items), doseq=True)
        query = "&".join(part for part in (query, extra) if part)
    return query


_default_signer: ABogusSigner | None = None
_default_lock = threading.Lock()


def _get_default_signer() -> ABogusSigner:
    global _default_signer
    with _default_lock:
        if _default_signer is None:
            _default_signer = ABogusSigner()
        return _default_signer


def generate_a_bogus(
    url: str,
    params: Mapping[str, Any] | Sequence[tuple[str, Any]] | None = None,
    timestamp: int | None = None,
    *,
    body: str = "",
) -> str:
    """Generate a_bogus for a URL/query and exact body string.

    ``timestamp`` is accepted for API compatibility; bdms reads its own clock and
    entropy internally, so supplying it does not override the runtime clock.
    """

    _ = timestamp
    return _get_default_signer().sign(_build_query(url, params), body)


def generate_verify_fp(device_info: Mapping[str, Any] | None = None) -> str:
    """Return an explicitly supplied session verifyFp.

    The analyzed bdms bundle does not generate verifyFp. Pass it as
    ``device_info['verifyFp']`` or set ``DOUYIN_VERIFY_FP``; fabricating one here
    would produce a token that is not tied to the browser session.
    """

    value = (device_info or {}).get("verifyFp") or os.getenv("DOUYIN_VERIFY_FP")
    if not isinstance(value, str) or not value.startswith("verify_"):
        raise SignerError(
            "verifyFp is outside bdms; supply device_info['verifyFp'] or DOUYIN_VERIFY_FP"
        )
    return value


def _close_default() -> None:
    global _default_signer
    if _default_signer is not None:
        _default_signer.close()
        _default_signer = None


atexit.register(_close_default)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Generate a_bogus using the extracted local bdms runtime")
    parser.add_argument("url", help="full URL or raw query string")
    parser.add_argument("--body", default="", help="exact serialized request body")
    args = parser.parse_args()
    with ABogusSigner() as signer:
        query = _build_query(args.url, None)
        print(json.dumps({"a_bogus": signer.sign(query, args.body)}, ensure_ascii=False))
