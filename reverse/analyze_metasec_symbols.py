#!/usr/bin/env python3
"""Summarize the ELF surface of libmetasec_ml.so.

The library is stripped, so this intentionally reports both the dynamic symbol
table and init-array relocation targets.  The latter are useful as stable
static-analysis anchors even when normal function names are unavailable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from elftools.elf.elffile import ELFFile
from elftools.elf.sections import NoteSection


def analyze(path: Path) -> dict:
    raw = path.read_bytes()
    with path.open("rb") as stream:
        elf = ELFFile(stream)
        dynamic = elf.get_section_by_name(".dynamic")
        dynsym = elf.get_section_by_name(".dynsym")
        init_array = elf.get_section_by_name(".init_array")
        rela_dyn = elf.get_section_by_name(".rela.dyn")

        needed: list[str] = []
        soname = None
        if dynamic:
            for tag in dynamic.iter_tags():
                if tag.entry.d_tag == "DT_NEEDED":
                    needed.append(tag.needed)
                elif tag.entry.d_tag == "DT_SONAME":
                    soname = tag.soname

        defined: list[dict] = []
        imports: list[str] = []
        if dynsym:
            for symbol in dynsym.iter_symbols():
                if not symbol.name:
                    continue
                if symbol["st_shndx"] == "SHN_UNDEF":
                    imports.append(symbol.name)
                else:
                    defined.append(
                        {
                            "name": symbol.name,
                            "type": symbol["st_info"]["type"],
                            "bind": symbol["st_info"]["bind"],
                            "address": symbol["st_value"],
                            "size": symbol["st_size"],
                        }
                    )

        init_targets: list[int] = []
        if init_array and rela_dyn:
            start = init_array["sh_addr"]
            end = start + init_array["sh_size"]
            init_targets = [
                relocation["r_addend"]
                for relocation in rela_dyn.iter_relocations()
                if start <= relocation["r_offset"] < end
            ]

        notes: list[dict] = []
        for section in elf.iter_sections():
            if isinstance(section, NoteSection):
                for note in section.iter_notes():
                    description = note["n_desc"]
                    if isinstance(description, bytes):
                        description = description.hex()
                    notes.append(
                        {
                            "section": section.name,
                            "name": note["n_name"],
                            "type": note["n_type"],
                            "description": description,
                        }
                    )

        return {
            "path": str(path.resolve()),
            "size": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "elf_class": elf.elfclass,
            "machine": elf["e_machine"],
            "type": elf["e_type"],
            "soname": soname,
            "needed": needed,
            "has_symtab": elf.get_section_by_name(".symtab") is not None,
            "dynamic_symbol_count": dynsym.num_symbols() if dynsym else 0,
            "defined_dynamic_symbols": defined,
            "imports": sorted(imports),
            "init_array_targets": init_targets,
            "notes": notes,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("library", type=Path)
    parser.add_argument("--output", "-o", type=Path)
    args = parser.parse_args()
    result = analyze(args.library)
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
