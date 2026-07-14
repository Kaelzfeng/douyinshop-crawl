#!/usr/bin/env python3
"""Locate Fort/AndJni DexVMP stubs and summarize libdexvmp.so in an APK."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path

from androguard.core.dex import DEX
from elftools.elf.elffile import ELFFile
from loguru import logger


JNI_CLASS = "Lcom/fort/andJni/JniLib1755042153;"
JNI_CLASS_BYTES = JNI_CLASS.encode()
DEX_NAME = re.compile(r"classes(\d*)\.dex$")
CONST_VALUE = re.compile(r"v(\d+), (-?(?:0x[0-9a-fA-F]+|\d+))$")
BOX_INT = re.compile(r"v(\d+), Ljava/lang/Integer;->valueOf")
GATEWAY = re.compile(r"->(c[A-Z])\(")


def dex_order(name: str) -> int:
    match = DEX_NAME.fullmatch(name)
    return int(match.group(1) or "1") if match else sys.maxsize


def boxed_integer_ids(instructions) -> list[int]:
    registers: dict[str, int] = {}
    values: list[int] = []
    for instruction in instructions:
        output = instruction.get_output()
        if instruction.get_name().startswith("const"):
            match = CONST_VALUE.fullmatch(output)
            if match:
                registers[match.group(1)] = int(match.group(2), 0)
        elif instruction.get_name() == "invoke-static":
            match = BOX_INT.match(output)
            if match and match.group(1) in registers:
                values.append(registers[match.group(1)])
    return values


def scan_dex(apk: zipfile.ZipFile) -> tuple[list[dict], list[dict]]:
    protected: list[dict] = []
    external_calls: list[dict] = []
    names = sorted(
        (name for name in apk.namelist() if DEX_NAME.fullmatch(name)),
        key=dex_order,
    )
    for name in names:
        raw = apk.read(name)
        if JNI_CLASS_BYTES not in raw and b"Lcn/wh/auth/" not in raw:
            continue
        dex = DEX(raw)
        for method in dex.get_encoded_methods():
            code = method.get_code()
            if not code:
                continue
            instructions = list(code.get_bc().get_instructions())
            outputs = [instruction.get_output() for instruction in instructions]
            jni_outputs = [output for output in outputs if JNI_CLASS in output]
            if jni_outputs:
                ids = boxed_integer_ids(instructions)
                gateway = GATEWAY.search(jni_outputs[-1])
                protected.append(
                    {
                        "dex": name,
                        "vm_id": ids[-1] if ids else None,
                        "gateway": gateway.group(1) if gateway else None,
                        "class": method.get_class_name(),
                        "method": method.get_name(),
                        "descriptor": method.get_descriptor(),
                    }
                )
            if not method.get_class_name().startswith("Lcn/wh/auth/"):
                for instruction, output in zip(instructions, outputs):
                    if "Lcn/wh/auth/" in output:
                        external_calls.append(
                            {
                                "dex": name,
                                "caller_class": method.get_class_name(),
                                "caller_method": method.get_name(),
                                "instruction": instruction.get_name(),
                                "target": output,
                            }
                        )
    return protected, external_calls


def scan_elf(raw: bytes) -> dict:
    elf = ELFFile(io.BytesIO(raw))
    dynamic = elf.get_section_by_name(".dynamic")
    dependencies = []
    soname = None
    if dynamic:
        for tag in dynamic.iter_tags():
            if tag.entry.d_tag == "DT_NEEDED":
                dependencies.append(tag.needed)
            elif tag.entry.d_tag == "DT_SONAME":
                soname = tag.soname

    dynsym = elf.get_section_by_name(".dynsym")
    defined_functions = []
    imports = []
    if dynsym:
        for symbol in dynsym.iter_symbols():
            if not symbol.name:
                continue
            if symbol["st_shndx"] == "SHN_UNDEF":
                imports.append(symbol.name)
            elif symbol["st_info"]["type"] == "STT_FUNC":
                defined_functions.append(
                    {
                        "name": symbol.name,
                        "address": symbol["st_value"],
                        "size": symbol["st_size"],
                    }
                )
    defined_functions.sort(key=lambda item: item["size"], reverse=True)
    text = elf.get_section_by_name(".text")
    return {
        "elf_class": elf.elfclass,
        "machine": elf["e_machine"],
        "type": elf["e_type"],
        "soname": soname,
        "dependencies": dependencies,
        "text_size": text["sh_size"] if text else None,
        "defined_function_count": len(defined_functions),
        "largest_functions": defined_functions[:10],
        "imports": sorted(imports),
        "has_jni_on_load": any(
            item["name"] == "JNI_OnLoad" for item in defined_functions
        ),
    }


def analyze(apk_path: Path) -> dict:
    apk_bytes = apk_path.read_bytes()
    with zipfile.ZipFile(io.BytesIO(apk_bytes)) as apk:
        protected, external_calls = scan_dex(apk)
        so_name = "lib/arm64-v8a/libdexvmp.so"
        so_raw = apk.read(so_name)

    protected.sort(key=lambda item: (item["vm_id"] is None, item["vm_id"] or -1))
    return {
        "sample": {
            "path": str(apk_path.resolve()),
            "size": len(apk_bytes),
            "sha256": hashlib.sha256(apk_bytes).hexdigest(),
        },
        "vmp_library": {
            "apk_entry": so_name,
            "size": len(so_raw),
            "sha256": hashlib.sha256(so_raw).hexdigest(),
            **scan_elf(so_raw),
        },
        "protected_method_count": len(protected),
        "vm_ids": [item["vm_id"] for item in protected],
        "gateway_counts": dict(Counter(item["gateway"] for item in protected)),
        "protected_methods": protected,
        "external_auth_call_count": len(external_calls),
        "external_auth_calls": external_calls,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", type=Path)
    parser.add_argument("--output", "-o", type=Path)
    args = parser.parse_args()
    logger.remove()
    result = analyze(args.apk)
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
