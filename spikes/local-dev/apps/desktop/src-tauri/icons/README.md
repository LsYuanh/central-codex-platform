<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# 临时 Spike 图标

`icon.png`、`icon.ico` 与 `icon.icns` 仅用于满足 Tauri macOS / Windows 资源构建要求，不是正式产品 Logo 或商标资产。

`icon.png` 使用 RGBA 编码：macOS 的 Tauri 上下文生成不接受 RGB PNG。转换只补充全不透明 alpha 通道，保留原图像素及尺寸；不要重新保存为 RGB 或调色板格式。

生成方式：Codex 内置 ImageGen。最终提示词要求“安全中央节点连接一台本地工作站”的无文字、无现有品牌相似性、深蓝/青色/琥珀色扁平几何图标；`icon.ico` 由生成的 PNG 机械转换而来。

`icon.icns` 使用 Pillow 从同一 RGBA PNG 机械转换，包含 macOS 图标所需尺寸，未重新生成画面。
