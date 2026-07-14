# CTF 安卓安全挑战题 — Writeup 协作请求

## 赛题描述

某 CTF 竞赛的安卓逆向挑战题。提供了一个电商类 APK 样本，要求选手在**不操作 App 界面**的前提下，获取指定店铺的全部商品列表。

## 题目附件

- APK 样本（170MB，含 196 个原生库）
- 模拟器环境（Android x86_64，已 root）
- 部分反编译产物（jadx 输出）

## 已知情报（已解出的部分）

1. **客户端校验**：`FreqLimitClickListener` 类实现了点击频率控制，配置 key 为 `ec_client_click_interval_time`
2. **VMP 保护范围**：dex 加固仅覆盖 `cn.wh.auth` 包，商品相关逻辑不受影响
3. **API 格式**：
   ```
   POST /aweme/v2/shop/promotion/pack/h5/?a_bogus=xxx&verifyFp=xxx
   ```
   返回商品详情 JSON（约 9KB）

4. **签名参数出现在**：URL query string 中，格式 `a_bogus=base64_like_string`
5. **可疑原生库**：`libmetasec_ml.so`（5.6MB）包含字符串引用 `sign`

## 需要协作的部分（卡住的点）

### 目标

从一条商品链接出发，拿到同店铺的所有商品 ID 列表，然后批量获取详情。

### 思路 A — 原生层逆向

1. 在 Ghidra 中加载 `libmetasec_ml.so`
2. 找到 `a_bogus` 的生成函数（搜索 `sign` 字符串引用，或追溯 JNI 调用链）
3. 理解输入（URL + 参数 + 时间戳？）→ 输出（签名串）的映射
4. 用 Python 复现签名逻辑
5. 直接构造 HTTP 请求调店铺商品列表 API

### 思路 B — 运行时 Hook

1. 用 Frida 在模拟器中 attach App 进程
2. Hook `libmetasec_ml.so` 中疑似签名的导出函数
3. dump 入参和返回值
4. 归纳签名算法

### 思路 C — 页面上下文利用

1. 在浏览器中打开商品链接
2. 拦截页面的 JS 网络请求（Playwright）
3. 尝试从页面上下文用 fetch 重放请求到同一 API 的不同端点

## 当前进度

- 反编译：已完成（jadx）
- 抓包：已确认 API 端点和参数格式
- 思路 A：卡在 Ghidra 分析（库太大，需要指导从何处入手）
- 思路 B：卡在 Frida Java 桥兼容性（x86 模拟器）
- 思路 C：手动 fetch 返回空响应体，签名似乎与请求路径绑定

## 期望的输出

1. 签名的伪代码或 Python 实现
2. 店铺商品列表端点的 URL 和参数格式
3. 一个能从商品链接出发、采集全店数据的 PoC 脚本

## 环境信息

- Windows 11，Python 3.12
- APK 已解压，原生库在 `lib/arm64-v8a/`
- 模拟器通过 ADB 可连接

## 备注

仅供 CTF 解题协作，不涉及生产环境。
