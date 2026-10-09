// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
export const IMAGEGEN_ID = 'yuan-zhou-imagegen';
export const IMAGEGEN_VERSION = 1;
export const IMAGEGEN_DESCRIPTION = '生成图片、插画、海报或根据已附图片进行修改，使用远舟原生图片工具并保存到当前客户端。';
export const IMAGEGEN_MAIN = `---
name: ${IMAGEGEN_ID}
description: "${IMAGEGEN_DESCRIPTION}"
---
# 图片生成 · 远舟内置

使用 image_gen.imagegen。根据用户要求组织主题、构图、风格及画面文字；明确的生成请求直接执行，只在关键输入缺失时追问。

新图只传 prompt，不附参考图参数。修改已附图片或刚生成的图片时，使用 num_last_images_to_include，选择包含目标图片的最小数量（1–5）。若对话中缺少目标图片，请用户添加附件；不得传 referenced_image_paths，不读取中央路径。这个固定版本的透明背景要求写在 prompt 中，不传未支持的参数。

生成结果由中央返回图片数据，Local Agent 自动保存到当前客户端默认输出目录。通过 device_list_outputs 核实保存状态和真实路径；旧对话使用 device_exec，program=codexia.files，args=["list_outputs","{}"]。生成成功和保存成功分开说明。用户指定其他位置时，取得已验证的客户端路径后用 device_copy_file 保存到目的位置。

保存失败时使用图片卡片的「重试保存」，不要为了保存而重新生成。生成失败、额度不足或结果不确定时说明原因，不自动反复调用生图；不得声称已生成或已保存。计划模式先完成方案，开始实施后才生成。
`;
