from __future__ import annotations
import struct, json
from pathlib import Path

SO = Path("reverse/apk_extracted/lib/arm64-v8a/libmetasec_ml.so")
data = SO.read_bytes()
assert data[:4] == b"\x7fELF"
e_phoff = struct.unpack_from("<Q", data, 32)[0]
e_phentsize = struct.unpack_from("<H", data, 54)[0]
e_phnum = struct.unpack_from("<H", data, 56)[0]
loads = []
for i in range(e_phnum):
    off = e_phoff + i * e_phentsize
    p_type, p_flags, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_align = struct.unpack_from("<IIQQQQQQ", data, off)
    if p_type == 1:
        loads.append((p_offset, p_vaddr, p_filesz, p_memsz, p_flags))

def va_to_off(va: int):
    for po, pv, fs, ms, fl in loads:
        if pv <= va < pv + max(ms, fs):
            rel = va - pv
            if rel < fs:
                return po + rel
    return None

e_shoff = struct.unpack_from("<Q", data, 40)[0]
e_shentsize = struct.unpack_from("<H", data, 58)[0]
e_shnum = struct.unpack_from("<H", data, 60)[0]
e_shstrndx = struct.unpack_from("<H", data, 62)[0]
shstr_off = struct.unpack_from("<Q", data, e_shoff + e_shstrndx * e_shentsize + 24)[0]
shstr_size = struct.unpack_from("<Q", data, e_shoff + e_shstrndx * e_shentsize + 32)[0]
shstr = data[shstr_off:shstr_off + shstr_size]

def sec_name(i: int) -> str:
    sh_name = struct.unpack_from("<I", data, e_shoff + i * e_shentsize)[0]
    end = shstr.find(b"\x00", sh_name)
    return shstr[sh_name:end].decode()

sections = {}
for i in range(e_shnum):
    base = e_shoff + i * e_shentsize
    name = sec_name(i)
    sh_addr = struct.unpack_from("<Q", data, base + 16)[0]
    sh_offset = struct.unpack_from("<Q", data, base + 24)[0]
    sh_size = struct.unpack_from("<Q", data, base + 32)[0]
    sh_link = struct.unpack_from("<I", data, base + 40)[0]
    sh_entsize = struct.unpack_from("<Q", data, base + 56)[0]
    sections[name] = (sh_addr, sh_offset, sh_size, sh_link, sh_entsize)

dynsym = sections.get(".dynsym")
dynstr = sections.get(".dynstr")
interesting = []
all_defined = []
if dynsym and dynstr:
    _, dynsym_off, dynsym_size, link, entsize = dynsym
    dynstr_off = dynstr[1]
    dynstr_size = dynstr[2]
    dstr = data[dynstr_off:dynstr_off + dynstr_size]
    entsize = entsize or 24
    for i in range(dynsym_size // entsize):
        st = dynsym_off + i * entsize
        st_name, st_info, st_other, st_shndx, st_value, st_size = struct.unpack_from("<IBBHQQ", data, st)
        if not st_name:
            continue
        end = dstr.find(b"\x00", st_name)
        name = dstr[st_name:end].decode("ascii", "ignore")
        if st_shndx == 0:
            continue
        all_defined.append((name, st_value, st_size))
        low = name.lower()
        if any(k in low for k in ["jni", "encode", "sign", "meta", "register", "init", "onload", "md5", "aes", "hmac"]):
            interesting.append((name, st_value, st_size))

jni_va = 0x28F03C
jni_off = va_to_off(jni_va)
# disassemble-ish: dump ARM64 instructions as hex + simple bl targets in first 0x200 bytes
code = data[jni_off:jni_off + 0x300] if jni_off is not None else b""

def decode_bl_targets(blob: bytes, base_va: int):
    outs = []
    for i in range(0, len(blob) - 3, 4):
        w = struct.unpack_from("<I", blob, i)[0]
        # BL imm26: top 6 bits 100101
        if (w >> 26) == 0b100101:
            imm26 = w & ((1 << 26) - 1)
            if imm26 & (1 << 25):
                imm26 -= (1 << 26)
            target = base_va + i + (imm26 << 2)
            outs.append((base_va + i, target))
        # B imm26 top 6 bits 000101
        if (w >> 26) == 0b000101:
            imm26 = w & ((1 << 26) - 1)
            if imm26 & (1 << 25):
                imm26 -= (1 << 26)
            target = base_va + i + (imm26 << 2)
            outs.append((base_va + i, target, "B"))
    return outs

bls = decode_bl_targets(code, jni_va)

# search for RegisterNatives import and xrefs via PLT - hard; instead find string refs to common method names
# scan for UTF8 "ms/bd/c/f3" or "ms.bd.c.f3"
needles = [b"ms/bd/c/f3", b"ms.bd.c.f3", b"LJIILLIIL", b"getEncodedP", b"X-Gorgon", b"X-Argus", b"X-Khronos", b"X-Ladon", b"X-Neptune", b"X-SS-STUB"]
needle_hits = {}
for n in needles:
    idxs = []
    start = 0
    while True:
        i = data.find(n, start)
        if i < 0:
            break
        idxs.append(i)
        start = i + 1
        if len(idxs) > 5:
            break
    needle_hits[n.decode()] = [hex(x) for x in idxs]

# ADRP+ADD style string refs to getEncodedP (file offset 0xc35d4). Map file off to VA.
def off_to_va(off: int):
    for po, pv, fs, ms, fl in loads:
        if po <= off < po + fs:
            return pv + (off - po)
    return None

getenc_off = data.find(b"getEncodedP")
getenc_va = off_to_va(getenc_off) if getenc_off >= 0 else None

# scan code for adrp pages pointing near getEncodedP
# ADRP: immlo bits 30..29, immhi 23..5, opcode 1xx10000
refs = []
if getenc_va is not None:
    text = sections.get(".text")
    if text:
        t_va, t_off, t_size, _, _ = text
        text_bytes = data[t_off:t_off + t_size]
        page_target = getenc_va & ~0xFFF
        for i in range(0, len(text_bytes) - 7, 4):
            w = struct.unpack_from("<I", text_bytes, i)[0]
            if (w & 0x9F000000) != 0x90000000:  # ADRP
                continue
            rd = w & 0x1F
            immlo = (w >> 29) & 0x3
            immhi = (w >> 5) & 0x7FFFF
            imm = (immhi << 2) | immlo
            if imm & (1 << 20):
                imm -= (1 << 21)
            pc = t_va + i
            page = (pc & ~0xFFF) + (imm << 12)
            if page != page_target:
                continue
            # next few insns for ADD imm
            for j in range(4, 20, 4):
                if i + j + 4 > len(text_bytes):
                    break
                w2 = struct.unpack_from("<I", text_bytes, i + j)[0]
                # ADD Xd, Xn, imm12: 1001000100...
                if (w2 & 0xFFC00000) == 0x91000000:
                    rn = (w2 >> 5) & 0x1F
                    if rn != rd:
                        continue
                    imm12 = (w2 >> 10) & 0xFFF
                    sh = (w2 >> 22) & 1
                    addend = imm12 << (12 if sh else 0)
                    target = page + addend
                    if abs(target - getenc_va) < 0x20:
                        refs.append({"pc": hex(pc), "add_pc": hex(pc + j), "target": hex(target)})
                        break
            if len(refs) >= 30:
                break

report = {
    "loads": [{"file": hex(a), "va": hex(b), "filesz": hex(c)} for a,b,c,_,_ in loads],
    "defined_dynsym_count": len(all_defined),
    "interesting_dynsyms": [{"name": n, "va": hex(v), "size": hex(s)} for n,v,s in interesting],
    "all_defined_dynsyms": [{"name": n, "va": hex(v), "size": hex(s)} for n,v,s in all_defined],
    "jni_onload": {
        "va": hex(jni_va),
        "file_off": hex(jni_off) if jni_off is not None else None,
        "first_bytes": code[:32].hex() if code else None,
        "bl_targets_in_first_0x300": [{"from": hex(x[0]), "to": hex(x[1]), "kind": (x[2] if len(x)>2 else "BL")} for x in bls[:40]],
    },
    "needle_hits": needle_hits,
    "getEncodedP": {"file_off": hex(getenc_off) if getenc_off>=0 else None, "va": hex(getenc_va) if getenc_va else None, "code_refs": refs},
}
out = Path("output/direct-search/metasec-static-probe.json")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps({
    "defined": len(all_defined),
    "interesting": interesting,
    "jni_off": hex(jni_off) if jni_off else None,
    "bl_count": len(bls),
    "getEncodedP_va": hex(getenc_va) if getenc_va else None,
    "getEncodedP_refs": len(refs),
    "refs_sample": refs[:10],
    "out": str(out),
}, indent=2))
