import zipfile, os

apk_path = os.path.join(os.path.dirname(__file__), 'samples', 'douyin-mall-39.5.0.apk')
z = zipfile.ZipFile(apk_path)
patterns = [
    '操作过于频繁', '访问被拒绝', '频', '复制链接', '分享',
    '频率', 'limit', 'share', 'denied', 'access_denied',
    'rate_limit', 'throttle', 'too_frequent'
]

for name in sorted(z.namelist()):
    if name.endswith('.dex'):
        data = z.read(name)
        for pat in patterns:
            pb = pat.encode('utf-8')
            if pb in data:
                idx = data.find(pb)
                ctx_start = max(0, idx - 30)
                ctx_end = min(len(data), idx + len(pb) + 80)
                ctx = data[ctx_start:ctx_end]
                print(f'{name}: "{pat}" at offset {idx}')
                try:
                    ctx_str = ctx.decode('utf-8', errors='replace')
                    print(f'  context: ...{ctx_str}...')
                except:
                    pass
                print()

z.close()
print('Done')
