<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# 第三方依赖记录

以下表格记录通过 npm 或 crates.io 安装的直接依赖；另有已引入的 Codex 与 Tauri 源码，详见 THIRD_PARTY_NOTICES.md。精确解析结果以 `package-lock.json` 和 `Cargo.lock` 为准。

| 直接依赖 | 版本 | 来源 | 许可证 | 用途 |
|---|---:|---|---|---|
| i18next | 26.4.2 | npm | MIT | 工作客户端内置中英文词条、插值和复数 |
| react-i18next | 17.0.15 | npm | MIT | React 界面语言变化订阅 |
| Tauri CLI | 2.11.4 | npm `@tauri-apps/cli` | Apache-2.0 OR MIT | 桌面开发与构建 |
| Tauri JavaScript API | 2.11.1 | npm `@tauri-apps/api` | Apache-2.0 OR MIT | 桌面运行时信息 |
| React / React DOM | 19.2.8 | npm | MIT | Spike UI |
| react-markdown | 10.1.0 | npm | MIT | CommonMark 消息与技能预览 |
| rehype-raw / rehype-sanitize | 7.0.0 / 6.0.0 | npm | MIT | Markdown 内 HTML 解析与允许列表过滤 |
| @types/hast | 3.0.5 | npm | MIT | HTML 语法树 TypeScript 类型 |
| remark-gfm / remark-breaks / remark-math | 4.0.1 / 4.0.0 / 6.0.0 | npm | MIT | 表格、脚注、清单、聊天换行与公式语法 |
| KaTeX | 0.18.7 | npm | MIT | 按需公式展示及随包字体 |
| Mermaid | 11.17.2 | npm | MIT | 按需图表展示，严格模式 |
| highlight.js | 11.12.0 | npm | BSD-3-Clause | 按需代码语法高亮 |
| @types/katex | 0.16.8 | npm | MIT | 公式渲染 TypeScript 类型 |
| Vite | 8.2.2 | npm | MIT | 前端开发服务器与构建 |
| React Vite Plugin | 6.1.1 | npm `@vitejs/plugin-react` | MIT | React 转换 |
| TypeScript | 7.0.2 | npm | Apache-2.0 | 前端与 Fake Central 类型检查 |
| ws | 8.21.3 | npm | MIT | Fake Central WebSocket |
| tsx | 4.23.13 | npm | MIT | Fake Central 开发运行器 |
| concurrently | 10.0.5 | npm | MIT | 本地多进程启动 |
| Tauri | 2.11.5 | crates.io `tauri` | Apache-2.0 OR MIT | Windows 桌面壳 |
| Tauri Build | 2.6.3 | crates.io `tauri-build` | Apache-2.0 OR MIT | Tauri 构建脚本 |
| Tokio | 1.53.1 | crates.io `tokio` | MIT | Local Agent 异步运行时 |
| tokio-tungstenite | 0.30.0 | crates.io | MIT | Agent 主动 WebSocket 连接 |
| futures-util | 0.3.34 | crates.io | MIT OR Apache-2.0 | WebSocket 流处理 |
| Serde / serde_json | 1.0.229 / 1.0.151 | crates.io | MIT OR Apache-2.0 | AgentRPC Spike 消息 |

此清单不替代正式 SBOM。发布二进制前须核对完整传递依赖与实际随包 NOTICE。

开发测试另使用 Playwright 1.64.0（Apache-2.0），仅作为根工作区 devDependency；浏览器按测试需求单独安装。
