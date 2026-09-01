<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# 本地纵向技术 Spike

该目录用于阶段 1 的本地开发验证，不是正式产品工程，也不代表生产版本已经锁定。

当前闭环：

```text
Tauri/React Desktop
        │ ws://127.0.0.1:4310/ws/ui
        ▼
Fake Central Gateway
        ▲ ws://127.0.0.1:4310/ws/agent（Agent 主动出站）
        │
Rust Local Agent
        │ 仅允许 ./fixtures/workspace
        ▼
workspace/list、read_file、受控版本查询
```

## 前置条件

- Windows x64；
- Node.js 24.x 和 npm 11.x；
- Rust stable（本机验证版本为 1.98.0），目标 `x86_64-pc-windows-msvc`；
- Microsoft C++ Build Tools、Windows SDK 和 WebView2 Runtime。

这些版本只服务本 Spike。由于 rustup 获取精确版本元数据时发生 TLS 中断，当前临时使用本机已安装的 `stable` 通道并记录实测版本 1.98.0；阶段 1 Go/No-Go 之前，不把它们提升为生产基线。

## 安装与运行

在本目录执行：

```powershell
npm install
npm run setup:env
npm run db:init
npm run check
npm run smoke
npm run dev
```

`setup:env` 会创建未纳入版本控制的 `.env` 和 `data/` 目录；本地 PoC 默认使用 `data/central.db` SQLite 文件，不需要启动 PostgreSQL。数据库表由仓库根目录的 `database/migrations/001_initial.sql` 初始化。多人长期运行或生产部署仍需切换到 PostgreSQL，届时替换 `DATABASE_URL` 并使用对应迁移流程。

如果本机 WebView2 被终端安全软件拦截，可先使用浏览器开发模式继续前端、网关与 Local Agent 闭环开发：

```powershell
npm run dev:browser
```

然后访问 `http://127.0.0.1:1420/`。该模式不启动 Tauri 窗口；桌面运行时问题修复后再恢复 `npm run dev`。

启动后，桌面窗口可执行以下验证：

- 列出测试工作区；
- 读取测试工作区内的 `README.md`；
- 通过 Local Agent 执行严格白名单中的 `git --version`。

`npm run smoke` 会自动启动 Fake Central 和已编译的 Local Agent，验证目录列表、文件读取、白名单命令、路径逃逸拒绝和非白名单命令拒绝，并在完成后停止测试进程。

Local Agent 拒绝绝对路径、`..`、符号链接逃逸、超过 1 MiB 的文件，以及不在白名单中的命令。Fake Central 只监听 `127.0.0.1`，不会连接 OpenAI。

开发模式使用单独的 CSP，仅额外允许 Vite React Refresh 的内联启动脚本和本机 `1420/4310` WebSocket；生产 CSP 不包含该开发例外。

### Windows 桌面白屏排查

如果 `http://127.0.0.1:1420/` 在普通浏览器中正常，但 Tauri 窗口持续白屏，先确认 WebView2 是否创建了 renderer 进程，并检查 Windows 事件查看器中的 `Microsoft-Windows-CodeIntegrity/Operational` 日志。

当前开发机上的排查记录显示，WebView2 renderer 被 Code Integrity 事件 3033 阻止：`C:\Windows\System32\winhafnt64.dll` 和 `winncap364.dll` 属于 TEC Solutions 的 OCular Agent，但不满足 WebView2 要求的 Microsoft 签名级别。退出搜狗输入法、使用全新 profile，以及改用已知可工作的 WebView2 Fixed Runtime 133 均未改变结果，因此需要升级、卸载或由管理员为 OCular Agent 配置兼容/白名单后再启动桌面应用。

不要把 `--no-sandbox` 或 `--disable-features=RendererCodeIntegrity` 作为产品修复；它们会削弱 WebView2 的进程隔离或完整性保护，也不能解决本机的 OCular Agent 注入冲突。

## 边界

- 不包含 Codex、OpenAI 凭据或真实 App Server；
- 不复制 Codexia 或 Soromi 源代码；
- 不提供登录、数据库、生产认证或完整审计；
- 下一阶段需要把 Fake Central 替换成部署在中央 macOS 的测试网关，并单独验证固定版本 Codex App Server。
