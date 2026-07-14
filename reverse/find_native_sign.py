"""
Search all DEX files for native method declarations related to signing.
Find the JNI call chain that generates a_bogus.
"""
import zipfile, re

z = zipfile.ZipFile('samples/douyin-mall-39.5.0.apk')

# Step 1: Find classes with "native" keyword AND "sign" or "sec" related names
for name in sorted(z.namelist()):
    if not name.endswith('.dex'):
        continue
    data = z.read(name)

    # Search for native method declarations
    # Pattern: class names mentioning sign/sec/metasec/encrypt
    for pat in [b'sign', b'Sec', b'MetaSec', b'Encrypt', b'bogus', b'Guard', b'ML_']:
        idx = 0
        while True:
            idx = data.find(pat, idx)
            if idx < 0:
                break
            # Get surrounding context
            ctx_start = max(0, idx - 80)
            ctx_end = min(len(data), idx + 200)
            ctx = data[ctx_start:ctx_end]
            try:
                txt = ctx.decode('utf-8', errors='replace')
                # Only print if it looks like a class/method name
                if 'Lcom/' in txt or 'native' in txt.lower():
                    print(f'[{name} offset {idx}] {txt[:250]}')
                    print()
            except:
                pass
            idx += 1

z.close()
