<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# 远舟客户端图标

2026-09-20 用户确认的第二版：蓝色 `#5279A6`、高低双帆、简化船身；中央管理使用深青色对称双帆及独立图标目录。

矢量源为 `../../src/assets/logo.svg`，同时用于客户端欢迎区及浏览器图标。PNG、ICO 和 ICNS 均由这份 SVG 生成，不从 AI 预览图裁切，不手工编辑派生文件。

在 `spikes/local-dev/` 安装现有 npm 依赖后执行 `node scripts/generate-brand-icons.mjs`。脚本使用项目锁定的 Tauri CLI，为客户端与中央端分别生成图标；中间文件在忽略目录 `target/brand-icons/`，只复制 `icon.png`、`icon.ico`、`icon.icns` 到各自的 `src-tauri/icons/`。

PNG 为 RGBA，保留圆角外透明区域。ICO 包含 16、24、32、48、64、256px；ICNS 包含常用 1x/2x 尺寸。开发配置与安装配置均应指向本应用的图标，不再让中央端引用客户端资源。

本次只更新源码资源，不代表已打包、安装或发布；macOS Dock 外观需在后续 Mac 原生验收中确认。
