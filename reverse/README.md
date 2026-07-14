# 抖音商城 39.5.0 DexVMP 静态定位

## 结论

APK 中的 VMP 是 Fort/AndJni 风格的 `libdexvmp.so`。它只接管 `cn.wh.auth`
命名空间内 30 个方法，方法末尾把参数和一个连续的 VM ID（0 到 29）装入
`Object[]`，再调用 `JniLib1755042153.cV/cL/cZ`。

全 APK 静态调用扫描没有发现 `cn.wh.auth` 之外的代码直接调用这套 SDK，Manifest
也没有注册它的 Activity、Service、Receiver 或 Provider。因此，目前证据不支持把
它认定为抖音商城搜索、商品详情或网络签名的主保护层；更像是随包打入但未接入当前
业务路径的第三方鉴权 SDK。

`libdexvmp.so` 的 `.text` 为 414,312 字节，其中最大单一导出函数为 205,196
字节（约 49.5%），同时存在 `JNI_OnLoad`、十种 `Object[]` JNI 网关以及大量混淆
符号。这与“一个大型解释器/分发器 + VM 方法表”的结构一致。

## 复现

```powershell
python -m venv reverse\.venv
reverse\.venv\Scripts\python -m pip install -r reverse\requirements.txt
reverse\.venv\Scripts\python reverse\analyze_vmp.py `
  reverse\samples\douyin-mall-39.5.0.apk `
  -o reverse\vmp-analysis.json
```

样本由本机 MuMu 中已安装的 `com.ss.android.ugc.livelite` 提取：

- versionName: `39.5.0`
- versionCode: `390501`
- ABI: `arm64-v8a`
- APK SHA-256: `6ea722364e006b8e246d94d32b41755528ff8e6d7d368d3c0c5f49defff50bf2`

## 后续分析入口

如果目标是还原这 30 个鉴权方法，可从 VM ID 到 Java 方法的映射入手，对
`cV/cL/cZ` 的 native 注册目标做动态跟踪，再记录最大分发函数的基本块覆盖率。
当前模拟器未启用 root，`shell` 无权读取目标进程 `/proc/<pid>/maps`，所以本轮只给出
可复现的静态证据，没有把“APK 内存在”误写成“运行时已加载”。

如果目标是商城采集链路，应改为先对实际搜索/商品详情动作采集调用栈或网络请求，
再从真实调用点反查对应的 DEX/SO；继续深挖这套 `cn.wh.auth` VMP 很可能走偏。
