<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# 技术 Spike 第三方依赖记录

以下依赖仅通过 npm 或 crates.io 包注册表安装，没有把上游源代码复制进产品主线。精确解析结果以 `package-lock.json` 和 `Cargo.lock` 为准。

| 直接依赖 | 版本 | 来源 | 许可证 | 用途 |
|---|---:|---|---|---|
| Tauri CLI | 2.11.4 | npm `@tauri-apps/cli` | Apache-2.0 OR MIT | 桌面开发与构建 |
| Tauri JavaScript API | 2.11.1 | npm `@tauri-apps/api` | Apache-2.0 OR MIT | 桌面运行时信息 |
| React / React DOM | 19.2.8 | npm | MIT | Spike UI |
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

此清单不替代正式 SBOM。进入产品主线前必须重新生成完整传递依赖清单并检查 NOTICE 要求。
