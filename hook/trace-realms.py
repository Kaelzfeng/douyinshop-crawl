"""Trace relevant modules across MuMu's native and emulated Frida realms."""

import json
import sys
import threading
import time

import frida


APP_ID = "com.ss.android.ugc.livelite"
SERIAL = "127.0.0.1:16384"
POLL_INTERVAL_SECONDS = 1.0

MODULE_FILTER = (
    "metasec|encryptor|sgmain|ttcrypto|sheo|krypton|ttnet|cronet|webview|"
    "chrome|ndk_translation|houdini"
)

sessions = {}
scripts = {}
emulated_attempts = {}
lock = threading.Lock()


def agent_source(realm: str, process_name: str) -> str:
    return f"""
'use strict';

const realm = {json.dumps(realm)};
const processName = {json.dumps(process_name)};
const interesting = /{MODULE_FILTER}/i;

send({{
  event: 'agent-loaded',
  pid: Process.id,
  process: processName,
  realm,
  arch: Process.arch
}});

globalThis.__moduleObserver = Process.attachModuleObserver({{
  onAdded(module) {{
    if (!interesting.test(module.name) && !interesting.test(module.path)) return;
    send({{
      event: 'module-added',
      pid: Process.id,
      process: processName,
      realm,
      arch: Process.arch,
      module: module.name,
      path: module.path,
      base: module.base.toString(),
      size: module.size
    }});
  }},
  onRemoved(module) {{
    if (!interesting.test(module.name) && !interesting.test(module.path)) return;
    send({{
      event: 'module-removed',
      pid: Process.id,
      process: processName,
      realm,
      arch: Process.arch,
      module: module.name,
      path: module.path
    }});
  }}
}});
"""


def on_message(pid: int, realm: str, message, _data) -> None:
    if message["type"] == "send":
        print(json.dumps(message["payload"], ensure_ascii=False), flush=True)
    elif message["type"] == "error":
        print(
            json.dumps(
                {
                    "event": "agent-error",
                    "pid": pid,
                    "realm": realm,
                    "description": message.get("description"),
                    "stack": message.get("stack"),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )


def attach_realm(device, pid: int, process_name: str, realm: str) -> bool:
    key = (pid, realm)
    with lock:
        if key in sessions:
            return True

    try:
        session = device.attach(pid, realm=realm)
        script = session.create_script(agent_source(realm, process_name))
        script.on("message", lambda message, data: on_message(pid, realm, message, data))
        script.load()
    except (
        frida.ProcessNotFoundError,
        frida.NotSupportedError,
        frida.InvalidOperationError,
        frida.ProtocolError,
    ) as error:
        if realm == "native":
            print(
                json.dumps(
                    {"event": "attach-failed", "pid": pid, "process": process_name,
                     "realm": realm, "error": str(error)},
                    ensure_ascii=False,
                ),
                flush=True,
            )
        return False

    def detached(reason, crash) -> None:
        with lock:
            sessions.pop(key, None)
            scripts.pop(key, None)
        print(
            json.dumps(
                {"event": "detached", "pid": pid, "process": process_name,
                 "realm": realm, "reason": reason, "crash": str(crash) if crash else None},
                ensure_ascii=False,
            ),
            flush=True,
        )

    session.on("detached", detached)
    with lock:
        sessions[key] = session
        scripts[key] = script
    return True


def belongs_to_target(process) -> bool:
    if process.name == APP_ID or process.name.startswith(APP_ID + ":"):
        return True
    if "抖音商城" in process.name:
        return True

    applications = process.parameters.get("applications", [])
    for application in applications:
        if isinstance(application, str) and application == APP_ID:
            return True
        if isinstance(application, dict) and application.get("identifier") == APP_ID:
            return True
    return False


def discover(device) -> None:
    for process in device.enumerate_processes(scope="full"):
        if not belongs_to_target(process):
            continue

        attach_realm(device, process.pid, process.name, "native")

        attempts = emulated_attempts.get(process.pid, 0)
        if (process.pid, "emulated") in sessions:
            continue
        emulated_attempts[process.pid] = attempts + 1
        if attach_realm(device, process.pid, process.name, "emulated"):
            print(
                json.dumps(
                    {"event": "emulated-attached", "pid": process.pid,
                     "process": process.name, "attempt": attempts + 1},
                    ensure_ascii=False,
                ),
                flush=True,
            )


def close_all() -> None:
    with lock:
        current_scripts = list(scripts.values())
        current_sessions = list(sessions.values())
        scripts.clear()
        sessions.clear()
    for script in current_scripts:
        try:
            script.unload()
        except frida.InvalidOperationError:
            pass
    for session in current_sessions:
        try:
            session.detach()
        except frida.InvalidOperationError:
            pass


def main() -> int:
    device = frida.get_device(SERIAL, timeout=10)
    spawn_mode = "--spawn" in sys.argv

    if spawn_mode:
        pid = device.spawn(APP_ID)
        print(json.dumps({"event": "spawned", "pid": pid, "application": APP_ID}), flush=True)
        attach_realm(device, pid, APP_ID, "native")
        device.resume(pid)
        print(json.dumps({"event": "resumed", "pid": pid}), flush=True)

    print(
        json.dumps(
            {"event": "ready", "application": APP_ID,
             "message": "Open a product detail page; press Ctrl+C to stop."},
            ensure_ascii=False,
        ),
        flush=True,
    )

    try:
        while True:
            discover(device)
            time.sleep(POLL_INTERVAL_SECONDS)
    except KeyboardInterrupt:
        return 0
    finally:
        close_all()


if __name__ == "__main__":
    raise SystemExit(main())
