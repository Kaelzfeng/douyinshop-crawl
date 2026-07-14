# 抖音商城进程内 MetaSec signer

## 已打通的调用链

```text
Python NativeMetaSecSigner
  -> Frida native realm / Java bridge
  -> NetworkParams.LJIILLIIL(url, headers)
  -> ms.bd.c.f3.a(0x03000001, 0, nativeHandle, url, headerPairs)
  -> String[]
  -> Map<String, String>
```

39.5.0 当前实测返回：

```json
{"X-Neptune":"-8|30:40:47:50:51:59:49:39"}
```

该值是 MetaSec security factor。它不是 H5 `a_bogus`，也不覆盖 body MD5、Cookie、
设备公共参数以及 TTNet 在更后阶段写入的其他 headers。

## 环境

- App：`com.ss.android.ugc.livelite` 39.5.0
- MuMu ADB：`127.0.0.1:16384`
- Frida：17.15.4
- App ABI：ARM64；Java RPC 从 x86_64 native realm 进入 ART，`f3.a` 再经 native bridge
  执行 ARM64 MetaSec。

## 构建

```powershell
npm run build:native-signer
```

## Python API

```python
from native_sign import NativeMetaSecSigner

url = "https://ecom.ecombdapi.com/aweme/v2/shop/promotion/pack/?device_platform=android"

with NativeMetaSecSigner() as signer:
    security_headers = signer.sign(url, {"accept": "application/json"})
```

对象会复用同一 Frida session，进程断开时执行一次重连。

## JSONL 服务

```powershell
npm run sign:native
```

请求：

```json
{"id":1,"op":"sign","url":"https://ecom.ecombdapi.com/aweme/v2/shop/promotion/pack/?device_platform=android","headers":{"accept":"application/json"}}
```

响应：

```json
{"id":1,"ok":true,"result":{"X-Neptune":"-8|30:40:47:50:51:59:49:39"}}
```

支持 `status`、`sign`、`close`。

## 诊断捕获

```powershell
python hook/capture-native-sign.py `
  --schema-from-capture output/playwright/sign-capture-2026-07-13T15-03-06-187Z.json `
  --seconds 30
```

已验证事件：

```json
{
  "event": "f3-sign",
  "op": 50331649,
  "text": "https://ecom.ecombdapi.com/aweme/v2/shop/promotion/pack/?native_signer_probe=1",
  "values": ["X-Neptune", "-8|30:40:47:50:51:59:49:39"]
}
```

## 下一层

完整原生请求还要继续捕获：

1. `X-SS-STUB`：body 的 MD5 stub。
2. TTNet/Cronet 发出前的最终 URL 与 headers。
3. Cookie、设备公共参数及会话字段。
4. `/pack/` 请求体和服务器响应。

因此当前 signer 已完成 MetaSec security-factor RPC；下一阶段产物是 App 内完整请求代理或
最终请求 headers 生成器。

