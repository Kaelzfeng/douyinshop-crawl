# 安卓逆向工程项目——电商平台商品数据采集（CTF 竞赛/安全研究用途）

## 项目背景

本次任务为**CTF 安全竞赛**中的安卓逆向工程挑战。目标平台为国内某电商 App（包名 `com.ss.android.ugc.livelite`，版本 39.5.0），参赛者需在不使用 App 自动化操作的前提下，通过逆向分析获取指定店铺的全部商品数据。

## 授权范围

- 竞赛靶场环境，App 安装在模拟器中
- 允许静态分析 APK、动态调试原生库
- 允许抓包分析 API 协议
- 允许复现签名算法以构造合法的 API 请求
- 采集速率限制：每秒不超过 5 个请求
- 仅供竞赛验证使用，不得用于生产环境

## 已知信息

### 已完成的工作

1. **APK 解包与反编译**
   - 使用 jadx 反编译了关键 DEX 文件
   - 定位到客户端频控实现 `FreqLimitClickListener`
   - 确认配置 key `ec_client_click_interval_time`
   - 分析结果位于 `reverse/partial_src/`

2. **VMP 保护分析**
   - `libdexvmp.so` 仅保护 `cn.wh.auth` 授权 SDK
   - 商品搜索/详情/分享链路不受 VMP 影响
   - 分析脚本位于 `reverse/analyze_vmp.py`

3. **API 端点发现**
   - 商品详情 API：`POST /aweme/v2/shop/promotion/pack/h5/`
   - 需要参数：`a_bogus`、`verifyFp`
   - 该 API 返回商品标题、价格、店铺等完整数据

4. **签名参数格式**
   ```
   a_bogus=mJsm6OZpMsR1UWY%2FGwkw99RzU160YW4AgZEzLUtEB0wd
   verifyFp=verify_mrj7x4h0_QdTuvQc3_gz9R_4Uft_BuRD_Rc9ggsP2jFOT
   ```

### 关键原生库

APK 包含 196 个 `.so` 库，其中与签名相关的重点目标：

| 库文件 | 大小 | 疑似功能 |
|--------|------|----------|
| `libmetasec_ml.so` | 5.6 MB | 主安全库，包含 `sign` 引用 |
| `libEncryptor.so` | 84 KB | 加密模块 |
| `libsgmain.so` | 314 KB | Security Guard |
| `libkrypton.so` | 1.7 MB | 加密库，包含 `sign` 引用 |
| `libsheo.so` | 477 KB | 安全相关 |
| `libttcrypto.so` | 1.2 MB | 字节跳动加密库 |

所有库均为 ARM64-v8a 架构。

## 任务目标

### 核心目标

**复现 `a_bogus` 签名算法**，使得可以从任意环境（Python/Node.js）直接调用电商 API，完全脱离 App。

### 具体步骤

#### 第 1 步：定位签名函数的调用链

在反编译的 Java 代码中搜索：

```
关键词：a_bogus, X-Bogus, sign, signature, getSignature, 
       genBogus, URLSigner, RequestSigner
```

找到 Java 层调用 native 方法的入口（`native` 关键字声明的 JNI 函数），确定是哪个类、哪个方法调用了 `libmetasec_ml.so` 中的签名函数。

#### 第 2 步：分析原生签名库

使用 Ghidra 或 IDA Pro 加载 `libmetasec_ml.so`：

a) 列出所有导出函数，找到 JNI 注册函数（`JNI_OnLoad` 或 `RegisterNatives`）
b) 根据第 1 步找到的 JNI 方法签名，在原生层定位对应的 C/C++ 函数
c) 分析签名函数的输入参数和输出格式
d) 追踪签名算法的核心逻辑（MD5/SHA/HMAC/自定义算法）

预期的 JNI 函数签名可能类似：
```c
JNIEXPORT jstring JNICALL
Java_com_bytedance_xxx_Xxx_sign(JNIEnv *env, jobject thiz, 
                                 jstring url, jbyteArray params)
```

#### 第 3 步：确定输入参数和输出格式

抓取一个完整的签名请求，记录：
- 签名前的原始 URL 和参数
- `a_bogus` 的完整值
- `verifyFp` 的完整值
- 请求的时间戳和其他元数据

分析签名算法需要哪些输入（时间戳？URL？请求体？设备指纹？）。

#### 第 4 步：复现签名算法

一旦理解了签名逻辑，用 Python 或 Node.js 实现：

```python
def generate_a_bogus(url: str, params: dict, timestamp: int) -> str:
    """复现抖音电商 a_bogus 签名算法"""
    # TODO: 实现签名逻辑
    pass

def generate_verify_fp(device_info: dict) -> str:
    """复现 verifyFp 设备指纹"""
    # TODO: 实现设备指纹
    pass
```

#### 第 5 步：发现店铺商品列表 API

有了签名能力后，尝试发现或推断店铺商品列表端点：

a) 抓取 App 内"进店逛逛"操作时的网络请求
b) 在反编译代码中搜索店铺商品列表的 API 路径
c) 可能的端点格式：
   - `/aweme/v2/shop/product/list/`
   - `/aweme/v2/shop/goods/search/`
   - `/ecom/shop/{shop_id}/products/`

#### 第 6 步：构建完整的采集流程

```
输入：任意商品分享链接（v.douyin.com/xxx）
  │
  ├─ 解析 product_id 和 sec_shop_id
  │
  ├─ 调用签名算法生成 a_bogus
  │
  ├─ 调店铺商品列表 API → 获取全部 product_id 列表
  │
  ├─ 对每个 product_id：
  │   ├─ 构造商品详情页 URL
  │   └─ 提取：商品品名、店铺名、价格、销量、分享链接
  │
  └─ 输出 CSV
```

## 技术约束

- 开发语言：Python 3.12（已有 frida 16.5.9）
- 运行环境：Windows 11，MuMu 模拟器（Android x86_64）
- 现有工具链：jadx（Java反编译）、Python（自动化脚本）
- 需额外安装：Ghidra 或 IDA Pro（原生库分析）
- APK 路径：`reverse/samples/douyin-mall-39.5.0.apk`

## 输出要求

1. `sign.py` — 签名算法复现模块
2. `shop_api.py` — 店铺商品列表 API 调用模块
3. `crawler.py` — 完整采集脚本
4. `README.md` — 使用说明和逆向分析文档

## 验证标准

1. 给定任一 v.douyin.com 链接，能获取同店铺全部商品
2. 输出 CSV 包含 5 个字段：商品品名、店铺名、价格、销量、分享的链接
3. 采集 100 件商品时间 < 30 秒
4. 不触发任何频控或封禁

## 现有代码上下文

- 项目路径：`E:\douyin-golden-goose-crawler`
- 已有反推链路：`src/enrich.mjs`（浏览器端提取商品数据，已验证可用）
- 已有 APK 分析：`reverse/` 目录
- 已有数据结构：`data/checkpoint.json`（24 件已采集商品样例）
