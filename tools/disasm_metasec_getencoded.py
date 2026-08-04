from __future__ import annotations
import json, struct
from pathlib import Path
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
from elftools.elf.elffile import ELFFile

SO = Path("reverse/apk_extracted/lib/arm64-v8a/libmetasec_ml.so")
data = SO.read_bytes()

with SO.open("rb") as f:
    elf = ELFFile(f)
    loads = []
    for seg in elf.iter_segments():
        if seg["p_type"] == "PT_LOAD":
            loads.append((seg["p_offset"], seg["p_vaddr"], seg["p_filesz"], seg["p_memsz"]))

def va_to_off(va: int):
    for po, pv, fs, ms in loads:
        if pv <= va < pv + ms:
            rel = va - pv
            if rel < fs:
                return po + rel
    return None

def off_to_va(off: int):
    for po, pv, fs, ms in loads:
        if po <= off < po + fs:
            return pv + (off - po)
    return None

md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
md.detail = True

def disasm_va(va: int, size: int = 0x80):
    off = va_to_off(va)
    if off is None:
        return []
    blob = data[off:off+size]
    out = []
    for insn in md.disasm(blob, va):
        out.append({"addr": hex(insn.address), "mnemonic": insn.mnemonic, "op_str": insn.op_str})
    return out

def find_func_start(va: int, max_back: int = 0x800):
    """Walk back looking for typical prologues: paciasp / stp x29,x30 / sub sp"""
    start = max(0, va - max_back)
    # align
    start = start & ~3
    candidates = []
    for a in range(start, va, 4):
        off = va_to_off(a)
        if off is None:
            continue
        w = struct.unpack_from("<I", data, off)[0]
        # STP X29, X30, [SP, #imm]!  : a9xx7bfd roughly - check pattern
        # paciasp: d503233f
        if w == 0xD503233F:  # paciasp
            candidates.append(a)
        # stp x29, x30, [sp, #-N]!
        if (w & 0xFFC07FFF) == 0xA9807BFD or (w & 0xFFC003E0) == 0xA90003E0 and ((w >> 5) & 0x1F) == 0x1E:
            # broader: look for stp *,*, [sp
            pass
        # common: a9xx7bfd = stp x29,x30,[sp,#-imm]!
        if (w & 0xFFC07FFF) == 0xA9807BFD or (w & 0xFFC07FFF) == 0xA9A07BFD or (w & 0xFFC003FF) == 0xA9007BFD:
            candidates.append(a)
        if (w & 0xFFC07FFF) in (0xA9BF7BFD, 0xA9BD7BFD, 0xA9BB7BFD, 0xA9B97BFD, 0xA9B77BFD, 0xA9B57BFD):
            candidates.append(a)
    # also generic stp x29,x30
    for a in range(start, va, 4):
        off = va_to_off(a)
        w = struct.unpack_from("<I", data, off)[0]
        # 29 and 30 as regs in stp: rt=29 rt2=30
        rt = w & 0x1F
        rt2 = (w >> 10) & 0x1F
        if (w >> 22) in (0x2A4, 0x2A5, 0x2A6) or (w & 0x7FC00000) == 0x29800000:
            if rt == 29 and rt2 == 30:
                candidates.append(a)
    if not candidates:
        return va & ~0xF
    # pick nearest below va
    below = [c for c in candidates if c <= va]
    return max(below) if below else va

# getEncodedP exact refs from previous probe
refs = [0x4BF458, 0x4BF494, 0x4BF4D0, 0x4BF50C, 0x4BF544]
# also include nearby cluster
getenc_va = off_to_va(data.find(b"getEncodedP"))

report = {
    "getEncodedP_va": hex(getenc_va) if getenc_va else None,
    "jni_onload_head": disasm_va(0x28F03C, 0x100),
    "sites": [],
}

for ref in refs:
    fstart = find_func_start(ref)
    site = {
        "ref_pc": hex(ref),
        "func_start_guess": hex(fstart),
        "disasm_around_ref": disasm_va(ref - 0x20, 0x80),
        "disasm_func_head": disasm_va(fstart, 0x60),
    }
    report["sites"].append(site)

# Scan for RegisterNatives PLT usage: import RegisterNatives
with SO.open("rb") as f:
    elf = ELFFile(f)
    dynsym = elf.get_section_by_name(".dynsym")
    imports = []
    if dynsym:
        for s in dynsym.iter_symbols():
            if s["st_shndx"] == "SHN_UNDEF" and s.name:
                imports.append(s.name)
    report["interesting_imports"] = [n for n in imports if any(k in n for k in [
        "RegisterNatives", "FindClass", "GetMethodID", "GetString", "NewString",
        "dlopen", "dlsym", "memcpy", "strlen", "snprintf", "vsnprintf", "md5", "AES"
    ])]
    report["import_count"] = len(imports)

out = Path("output/direct-search/metasec-disasm-getencoded.json")
out.write_text(json.dumps(report, indent=2), encoding="utf-8")
print("wrote", out)
print("imports sample", report["interesting_imports"][:40])
print("func starts", [s["func_start_guess"] for s in report["sites"]])
# print a compact view of first site around ref
for line in report["sites"][0]["disasm_around_ref"]:
    print(f"{line['addr']}: {line['mnemonic']} {line['op_str']}")
