import zipfile, re

z = zipfile.ZipFile('samples/douyin-mall-39.5.0.apk')

# Deep search: find rate limit configuration values
deep_patterns = [
    'freq_limit', 'anchor_window_threshold', 'anchor_panel_limit_frequency',
    'accelerate_limit', 'limitDid', 'limitUid', 'rate_limit', 'freqTime',
    'frequency', 'aweme/homepage/rate_limit', 'api_call_too_frequently',
    'share_type', 'shareActionType', '复制链接', 'copy_link', 'SharePanel',
    'threshold_per_window', 'limit_window', 'share_limit',
]

for name in sorted(z.namelist()):
    if name.endswith('.dex'):
        data = z.read(name)
        for pat in deep_patterns:
            pb = pat.encode('utf-8')
            if pb in data:
                idx = data.find(pb)
                ctx_start = max(0, idx - 200)
                ctx_end = min(len(data), idx + len(pb) + 300)
                ctx = data[ctx_start:ctx_end]
                print(f'=== {name}: "{pat}" ===')
                # Print surrounding text, filtering binary garbage
                txt = ctx.decode('utf-8', errors='replace')
                # Show only readable parts
                readable = ''.join(c if c.isprintable() or c in '\n\r\t' else '.' for c in txt)
                print(readable)
                print()

z.close()
print('Deep search done')
