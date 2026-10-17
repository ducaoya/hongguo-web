<div align="center">

# 红果短剧 · 深夜剧场

**本地网页版红果短剧客户端 —— 为电脑大屏与 NAS 而生**

最高 1080P · 短视频式刷剧流 · 断点续播 · 零广告 · 数据本地化

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-fnOS%20%7C%20Docker%20%7C%20Node.js-green.svg)]()

</div>

> [!WARNING]
> **免责声明**：本项目为非官方第三方客户端，与红果短剧官方无关。数据来自红果官网公开页面与社区逆向的接口，平台变更可能失效。仅供个人学习研究使用，**严禁商用**；内容的版权归原作者所有。如权利人提出要求，本项目将停止维护。

## ✨ 功能

- **播放**：最高 1080P（preload 接口活性探测 + CENC 分段解密代理），官网 360P 兜底通道自适应切换
- **推荐刷剧流**：短视频交互——滚轮 / ↑↓ 切换下一部剧，←→ 切换集数，自动连播，自动有声播放，后续集数与剧集预加载
- **分类 / 榜单 / 搜索**：真人剧 / 漫剧 / AI 剧 + 官网 24 类题材筛选，四张热播榜，搜索联想，触底无限加载
- **详情与选集**：评分热度主演、全集网格（50 集分组）、看了又看、标签直达分类
- **播放器**：断点续播（本地存储）、倍速 0.75–3x、适应/铺满、点击暂停、双击全屏、全套快捷键
- **本地化**：无账号、无上报、无追踪；观看进度全部存本机浏览器

## 🚀 部署

### 飞牛 fnOS（原生 .fpk 应用）

```sh
git clone https://github.com/ducaoya/hongguo-web.git
cd hongguo-web
bash deploy/fpk/build-fpk.sh "$PWD"   # 需在 fnOS 的终端中执行（fnpack 为 Linux 二进制）
```

然后「应用中心 → 手动安装」上传生成的 `hongguo.fpk`。原生模式自动发现 fnOS 的
`nodejs_v22/v24` 运行时，由系统托管启停，桌面带图标。

### Docker Compose

```sh
docker compose up -d --build   # 访问 http://<NAS_IP>:8630
```

> NAS 拉不动 `node:22-alpine` 时：`docker pull dockerproxy.net/library/node:22-alpine && docker tag dockerproxy.net/library/node:22-alpine node:22-alpine`

### Node 直跑（任意机器）

```sh
npm install
npm start        # http://127.0.0.1:8630，HOST=0.0.0.0 开放局域网
```

### 一键部署到飞牛

```sh
bash deploy/deploy-fnos.sh <NAS地址> <SSH用户名>
```

## 📦 版本发布（自动构建 .fpk）

在 `master` 分支提交且**提交信息包含 `【release】`** 时，GitHub Actions 会自动：

1. 安装依赖 → 下载 fnpack → 打出 `hongguo.fpk`
2. 按 `package.json` 版本号创建 Release 并上传附件

## 🧱 架构

```
浏览器 SPA ──本地 Node 服务──┬─→ 红果官网 SSR _ROUTER_DATA（分类/榜单/搜索/详情，免签名）
                            └─→ 番茄 preload 接口（免完整签名）→ spade 解密
                                                     → CENC 分段解密 → /stream Range 代理（1080P）
```

- `server.js` — 零框架 Node 服务：官网数据解析（排队限速 + 壳页重试 + 缓存）、播放解析、图片代理
- `vendor/hongguo.cjs` — 未修改的 [drpys](https://github.com/woshishiq1/drpys) 红果源（签名/解密能力，GPL-3.0，见 `vendor/NOTICE.md`）
- `public/` — 原创前端 SPA（无构建步骤、无 CDN 依赖、无追踪脚本）

## 📄 许可证

本项目以 [GPL-3.0](LICENSE) 发布，与 vendored 的 drpys 源许可证保持兼容。

## 🙏 致谢

- [woshishiq1/drpys](https://github.com/woshishiq1/drpys) — 红果接口签名与解密实现
- [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) — 接口调研与工程范式
- [zhenyong97/hongguo-downloader](https://github.com/zhenyong97/hongguo-downloader) — preload 接口线索
