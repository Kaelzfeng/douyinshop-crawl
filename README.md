# 抖音商城 Golden Goose 商品采集工具

## 项目简介

本项目用于在本地模拟器环境中采集抖音商城里的 Golden Goose 相关商品信息。程序通过 Playwright、Android 自动化、接口补全和本地签名调试等方式，把商品名称、店铺名称、价格、销量、分享链接等信息整理成便于查看和二次处理的数据文件。

项目主要用于本地采集、接口分析、签名链路验证和结果整理，不依赖云端服务，运行数据默认保存在本机目录中。

## 使用说明

本项目仅供学习、研究和 CTF 竞赛使用，用于理解本地自动化采集、接口分析、调试注入和签名验证等技术流程。

## 主要功能

- 连接本地 Android 模拟器并检查抖音商城运行状态。
- 在抖音商城内搜索 Golden Goose 相关商品。
- 采集商品卡片、商品详情页和分享链接。
- 对分享页或接口响应进行补全，整理商品名称、店铺、价格、销量和链接。
- 支持断点续跑，减少重复采集。
- 支持访问频率控制、冷却等待和自动重试。
- 支持 WebView 调试、Android 调试、native 签名链路分析和本地签名验证。
- 输出 CSV、JSON、诊断截图和接口响应记录。

## 运行环境

- 系统：Windows 10 或 Windows 11。
- Node.js：20 或更高版本。
- Android 环境：MuMu 模拟器已启动，并且可以通过本地调试端口连接。
- 应用状态：模拟器内已安装并登录抖音商城相关应用。
- 浏览器：Microsoft Edge 或其他 Playwright 支持的浏览器。
- 可选环境：Python、Frida、frida-compile，用于 native 调试和签名验证。

默认 Android 调试设备地址为：

```powershell
127.0.0.1:16384
```

## 首次安装

在项目目录中执行：

```powershell
npm install
npx playwright install android
npm run probe
```

如果环境正常，`npm run probe` 会显示设备已连接，并且目标应用处于可访问状态。

## 常用命令

全量重新采集：

```powershell
npm start -- --all --fresh
```

从上次断点继续全量采集：

```powershell
npm start -- --all
```

重新采集指定数量的商品：

```powershell
npm start -- --limit 20 --fresh
```

从上次断点继续采集指定数量的商品：

```powershell
npm start -- --limit 100
```

指定 Android 调试设备地址：

```powershell
npm start -- --serial 127.0.0.1:16384 --limit 20
```

降低分享操作频率，并在触发访问限制后增加冷却时间：

```powershell
npm start -- --limit 20 --max-shares-per-window 6 --share-window-minutes 20 --access-denied-cooldown-minutes 30 --max-access-denied-retries 3
```

检查本地环境：

```powershell
npm run probe
```

运行测试：

```powershell
npm test
```

## 签名与调试命令

构建 WebView 调试脚本：

```powershell
npm run build:webview-agent
```

捕获 WebView 调试信息：

```powershell
npm run capture:webview
```

构建 native 调用链调试脚本：

```powershell
npm run build:native-chain
```

捕获 native 调用链：

```powershell
npm run capture:native
```

探测 native 环境：

```powershell
npm run probe:native
```

启动本地签名服务：

```powershell
npm run sign:service
```

执行本地签名验证：

```powershell
npm run sign:native
```

验证 H5 接口：

```powershell
npm run verify:h5
```

## 输出文件

默认输出目录为：

```text
output
```

常见输出内容包括：

- 商品结果表：整理后的商品名称、店铺名称、价格、销量和分享链接。
- 运行摘要：记录本次运行数量、错误、状态和断点信息。
- 诊断截图：保存失败现场、页面状态和关键步骤截图。
- 接口响应记录：保存调试过程中捕获到的响应数据。

断点数据默认保存在：

```text
data
```

## 目录说明

```text
src        核心采集逻辑、参数解析、设备连接、剪贴板、输出和限速控制
hook       调试注入脚本、native 调用链捕获、WebView 调试捕获和签名探测脚本
tools      数据整理、接口验证、签名服务和结果合并工具
test       自动化测试用例
reverse    逆向分析资料、样本和中间产物
data       本地断点、临时数据和采集状态
output     采集结果、诊断截图和接口响应记录
```

## 推荐上传内容

上传到 GitHub 时，建议保留源码、测试、文档和配置文件，忽略本地依赖、缓存、采集结果和大型逆向样本。

建议忽略的内容包括：

- 依赖目录。
- 运行输出目录。
- 断点和临时数据目录。
- 调试缓存目录。
- 编译生成的脚本包。
- 反编译产物、APK 样本和大型二进制文件。
- 本地证书、会话、截图和接口响应记录。

## 使用流程

一、启动 MuMu 模拟器，并确认目标应用已经登录。

二、在项目目录安装依赖并执行环境探测。

三、根据采集需求选择全量采集、断点续跑或限制数量采集。

四、采集完成后检查 `output` 目录中的结果表和运行摘要。

五、如果页面结构变化或采集失败，查看诊断截图和接口响应记录，再调整选择器、坐标或接口补全逻辑。

## 常见问题

### 设备无法连接

确认 MuMu 模拟器已经启动，Android 调试端口可用，并且设备地址与命令中的参数一致。

### 应用状态不正确

确认目标应用已经安装、已登录，并且没有停留在弹窗、登录页或权限确认页。

### 分享链接复制失败

确认 MuMu 模拟器和 Windows 剪贴板同步正常，并降低分享操作频率后重试。

### 出现访问受限或操作频繁

减少单位时间内的分享次数，增加冷却时间，并使用断点续跑继续采集。

### 结果字段不完整

检查分享页、接口响应和诊断截图，必要时运行接口验证或结果补全脚本。

## 维护说明

- 页面结构变化时，优先检查界面选择、点击流程和诊断截图。
- 接口返回变化时，优先检查数据整理脚本和字段映射逻辑。
- 签名链路变化时，优先查看 native 调用链文档和签名验证脚本。
- 上传 GitHub 前先确认忽略规则，避免提交本地数据、缓存和大型二进制文件。

