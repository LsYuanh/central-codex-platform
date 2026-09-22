// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Kept in the compiled gateway so runtime packaging cannot omit the skill asset.
export const CREATOR_ID = 'yuan-zhou-skill-creator';
export const CREATOR_VERSION = 1;
export const CREATOR_DESCRIPTION = '创建或修改远舟个人技能，将用户明确要求复用的对话流程整理为技能包。仅在用户要求创建、修改技能或把流程保存为技能时使用，普通任务执行不触发。';
export const CREATOR_MAIN = `---
name: yuan-zhou-skill-creator
description: "${CREATOR_DESCRIPTION}"
---
# 创建技能 · 远舟内置

这是远舟个人技能创建流程，与中央 Codex 自带的 skill-creator 独立。不要调用或修改中央系统技能、扫描中央文件，或把中央路径当成客户端路径。

## 理解和确认

结合当前对话与用户已经明确的选择，确定用途、触发条件、输入、输出和依赖。只追问缺失的关键信息，一次一个问题。用户仅要求完成普通任务时，不将它擅自转换成技能创建。
给出简短方案，用户确认后生成；对已经确认的方案直接继续，不重复索取确认。修改现有个人技能时使用其 ID，保留无关内容。

## 申请客户端草稿

确认后调用 device_skill_draft。requestKey 使用本次创建任务的稳定短标识（英文、数字、连字符，8–80 字符），失败重试保持同一个值；独立的新建任务使用新值。修改时同时传 skillId。
工具会返回 draft.id 和当前绑定客户端的 draft.path。只使用返回的目录，通过 device 工具在该目录创建或修改文件；不要自行猜路径，也不要在技能加载缓存目录里生成成品。
若用户提供的是已登记草稿，继续使用其明确的目录，不重复申请。若当前对话没有 device_skill_draft，解释该旧对话缺少工具，并提示在新对话选择「创建技能」继续；不要用其他命令绕过草稿登记。

## 生成完整技能包

必须提供 SKILL.md，YAML frontmatter 的 name 使用小写英文字母开头及数字、连字符，最多 64 字符；description 使用单行双引号字符串，清楚说明用途与触发时机。不要使用保留名称 yuan-zhou-skill-creator。
正文写实际需要的操作知识和边界，避免泛泛说明。按需添加 references/、assets/、scripts/，不用为了凑目录生成空文件。正文说明资源何时使用，使用相对路径；脚本写清输入、输出、参数和失败处理。不要依赖当前机器的绝对路径。
有系统或命令依赖时添加 runtime.json，例如 {"platforms":["windows"],"programs":["powershell"]}；platforms 仅接受 windows、macos、linux，programs 填命令名，没有限制使用空数组。
最多 64 个文件、共 8 MiB，SKILL.md 不超过 64 KiB。文件路径必须可跨平台，不使用路径穿越、符号链接或系统保留文件名。
远舟当前不支持插件、MCP、子代理、原生图片生成，不能将这些能力作为技能执行前提。不要复制凭据、登录信息或本机私有数据到技能包。

## 预览和保存

生成后核对文件确实位于返回的客户端草稿目录，并说明生成内容。提醒用户打开「我的技能」→「本机草稿」→「预览并保存」。只有用户在预览中保存后，它才进入跨客户端共享的个人技能库；不要声称生成草稿已经保存或发布。
生成脚本不等于执行脚本。仅在用户明确要求试运行时，通过当前客户端设备工具执行，并遵守脚本实际影响所需的授权。失败时说明已完成部分与恢复方式，继续使用原草稿，不无限重试。
`;
