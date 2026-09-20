<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# 远舟开发入口

这里是工作客户端、中央管理 App、中央网关和 Local Agent 的现有主工程。维护基线为 2026-09-20；功能、部署状态和操作说明见[文档导航](../../docs/README.md)。

## 架构

```text
工作客户端 UI ── WSS /ws ── 中央网关 ── stdio ── 按用户 Codex App Server
                               │ 工具请求编排
客户端 Local Agent ── 出站 WSS /ws/agent
       └─ 本机文件、Git、PowerShell、命令
中央管理 App ── 原生层 ── 本机中央配置、模型认证与受管服务
```

中央系统操作只用于中央自身管理。模型任务所需的客户端文件与命令必须经目标 Agent 执行；客户端不依赖本地 Codex，SSH 不进入产品链路。

## 环境与运行

- Node.js 24.x、npm 11.x（以本目录 package.json 为准）。
- Rust 工具链按 rust-toolchain.toml；固定上游编译信息另见 harness/upstream.json。
- Windows：MSVC C++ Build Tools、Windows SDK、WebView2；macOS：可用的 Apple Command Line Tools。
- macOS 可在构建 shell 设置 `DEVELOPER_DIR=/Library/Developer/CommandLineTools`，不修改全局工具链。

以下命令在本目录运行：

```powershell
npm ci
# 工作客户端，自动构建/启动 Local Agent：
npm run dev:desktop
# 中央管理 App（按任务择一启动）：
npm run dev:central-app
# 仅中央页面预览：
npm run dev:central-ui
```

中央原生与浏览器入口共用 1422，不要同时占用。只预览工作客户端可运行 `npm run web:dev --workspace @central-codex-spike/desktop`，浏览器不具备原生配对和 Agent 生命周期，不能当作完整桌面验收。

当前中央 `wss://192.0.2.10:4510/ws` 使用一体配对码。具体配置、默认输出目录和开发覆盖见[客户端手册](../../docs/客户端维护手册.md)。首次配置就绪前不启动正常业务连接。中央开发需要受信完整运行包、TLS 和专用数据目录，见[中央管理手册](../../docs/中央管理维护手册.md)。

## 检查

```powershell
npm run check --workspace @central-codex-spike/desktop
npm run build --workspace @central-codex-spike/desktop
npm run check --workspace @central-codex-spike/central
npm run build --workspace @central-codex-spike/central
npm run build --workspace @central-codex-spike/test-gateway
cargo fmt --all -- --check
cargo check --workspace --locked
cargo test -p local-agent --locked
```

按修改范围选用，不要求每次全跑。UI 改动须实际看 Tauri 页面；生命周期改动须验证 App 与 Agent 同启同退；网关/工具高风险改动须验证真实中央和实际客户端执行位置。专项命令、证据和缺口见[验证与已知限制](../../docs/验证与已知限制.md)。

## 协议探针与旧开发入口

`npm run smoke`、`npm run protocol:test` 使用 Fake Central/协议夹具，只作开发回归。先按脚本要求构建 Agent 和类型包；协议成功不能代替真实模型或原生 UI。

`dev`、`dev:browser` 和 `dev:app-proxy` 保留早期本机 App Server 代理探针，`dev:fake` 为 Fake Central。它们不是正常客户端启动入口。`dev:central` 在运行该命令的机器启动测试网关和浏览器，应仅用于指定的中央开发环境。

`setup:env`/`db:init` 仅初始化早期 SQLite PoC，不是受管中央启动、正式数据库升级或历史导入步骤。旧明文模式、Day5 和 mTLS 探针按各自夹具使用，不能替代当前 WSS + device-token-v1 链路。

## 维护资料

- [AgentRPC](AGENTRPC.md)：设备协议、能力协商和兼容行为。
- [Harness](harness/README.md)：固定源码、补丁、构建与隔离探针。
- [模型认证](../../docs/模型认证维护手册.md)：共享登录、独立登录和失效恢复。
- [发布与回退](../../docs/发布与回退手册.md)：sidecar、更新签名、中央切换与备份。
- [第三方依赖](THIRD_PARTY.md)：许可声明；测试夹具及各模块 README 保持原用途。

日常修改验证后只做本地 Git 提交，不自动生成安装包、替换已安装 App 或切换中央服务。
