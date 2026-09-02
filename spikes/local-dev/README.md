<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# 本地纵向技术 Spike

该目录用于阶段 1 的本地开发验证，不是正式产品工程，也不代表生产版本已经锁定。

当前桌面端已采用 Codexia Workspace 正式工作台界面：左侧提供连接模式、Thread
管理和设备工作区，中央提供对话、流式状态、审批和活动日志；底层仍连接本目录的
中央测试网关与 Local Agent，便于在局域网环境持续验证核心流程。

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

阶段 2 第一轮增加了版本化 AgentRPC V1 和中央侧的 Fake App Server Worker /
Remote Workspace Bridge。UI 的 `app.request` 会经过
`worker → bridge → AgentRPC → Local Agent`，而旧的 `agent.request` 仅作为
UI 兼容入口；设备链路不会发送旧格式。协议类型与 JSON Schema 位于
`packages/agentrpc-types/`，详见 [`AGENTRPC.md`](AGENTRPC.md)。

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

如果本机 WebView2 被终端安全软件拦截，可先使用浏览器开发模式继续 UI 与本机 App Server 代理开发：

```powershell
npm run dev:browser
```

然后访问 `http://127.0.0.1:1420/`。该模式不启动 Tauri 窗口；桌面运行时问题修复后再恢复 `npm run dev`。
`npm run dev` 与 `npm run dev:browser` 都会启动 App Server 代理；若要运行旧的 Fake Central + Local Agent 闭环，请使用 `npm run dev:fake` 或 `npm run dev:browser:fake`。

要验证 B.6 Day 3 的“客户端经中央测试网关访问 App Server stdio”链路，使用：

```powershell
npm run dev:central
```

该命令启动 `services/test-gateway` 和浏览器 UI。测试网关监听
`ws://127.0.0.1:4510/ws`，由网关进程在服务端本地启动 `codex app-server`（stdio），
对客户端只暴露版本化的 `central-gateway-v1` 请求/响应/事件封装，不透传 App Server 原始
WebSocket。客户端 UI 选择 `Central Test Gateway`，地址保持上述 `4510/ws`。网关默认将
Thread 所有权和摘要保存到 `data/test-gateway-state.json`（可用 `TEST_GATEWAY_STATE_FILE`
覆盖）；重启后同一用户可以继续看到并恢复自己的 Thread。

### 局域网核心功能模式（当前优先支持）

如果中央机和客户端在同一可信局域网，可以暂时跳过正式账号、TLS/mTLS 和细粒度权限，直接验证核心工作流：

1. 在中央 macOS 机启动网关（网关监听局域网接口，并在本地通过 stdio 启动 Codex App Server）：

   ```bash
   TEST_GATEWAY_HOST=0.0.0.0 TEST_GATEWAY_PORT=4510 \
   CODEX_BIN=/Users/operator/Applications/ChatGPT.app/Contents/Resources/codex \
   npm run dev:test-gateway
   ```

2. 在客户端启动 Local Agent，增加临时直连开关：

   ```powershell
   cargo run -p local-agent -- --workspace-root C:\work\project `
     --gateway-url ws://192.0.2.10:4510/ws/agent --allow-insecure-lan
   ```

3. 启动桌面端，在“中央测试网关”模式填写
   `ws://192.0.2.10:4510/ws?userId=<用户标识>&deviceId=<设备标识>`，连接后即可使用：
   Thread 创建/恢复/重命名/归档/删除、实时对话、Markdown 消息、工作区目录浏览、文件读取和白名单版本命令。

当前版本按“可信局域网内部使用”处理身份和权限；4510 仅允许在隔离局域网临时开放，禁止暴露到互联网。正式认证、TLS/mTLS、细粒度权限、审批和审计仍列为后续工作。

### 连接本机 Codex App Server 做真实 UI 测试

桌面 UI 另保留 `Local Codex App Server` 模式。它只在本地开发时让浏览器/Tauri
通过 `127.0.0.1:4501` 的本地桥接代理连接你启动的 Codex App Server；生产中央网关链路不受影响。
代理只负责去掉浏览器的 `Origin` 握手头，再转发到 `127.0.0.1:4500`，不会读取或存储对话内容。

先开一个终端启动本地监听器：

```powershell
codex app-server --listen ws://127.0.0.1:4500
```

另一个终端运行 `npm run dev:browser`（或 `npm run dev`），打开客户端后确认：

1. 保持 WebSocket 地址为 `ws://127.0.0.1:4501`，需要时填写工作目录和模型；
2. 点击“连接并创建 Thread”；
3. 在对话框输入任务，客户端会发送 `initialize` → `thread/start` → `turn/start`，并实时显示
   `item/agentMessage/delta`、`turn/completed` 和审批请求；
4. 需要时用“中断”调用 `turn/interrupt`，或在审批卡片中允许/拒绝/取消。

如果只想验证工作区权限与 AgentRPC，可切换到 `Fake Central / AgentRPC` 模式。浏览器预览与
Tauri 桌面窗口共用这套本地 App Server 客户端；当前实现没有把 OpenAI 凭据放进 UI。

启动后，桌面窗口可执行以下验证：

- 列出测试工作区；
- 读取测试工作区内的 `README.md`；
- 通过 Local Agent 执行严格白名单中的 `git --version`。

`npm run smoke` 会自动启动 Fake Central 和已编译的 Local Agent，验证目录列表、文件读取、白名单命令、路径逃逸拒绝和非白名单命令拒绝，并在完成后停止测试进程。

要只验证 Day 4 Device Broker（包含 Rust Local Agent 出站连接），使用：

```powershell
npm run device:smoke
```

默认连接 `ws://127.0.0.1:4510/ws` 和 `/ws/agent`。验证真实中央机时，可设置
`DEVICE_GATEWAY_URL=ws://192.0.2.10:4510/ws` 走局域网直连；测试会依次调用
`workspace/list`、`read_file` 和受控 `exec`，成功时输出 `DEVICE_BROKER_SMOKE_OK`。

要运行 Day 5 的双用户/双设备隔离、掉线恢复、审批边界和审计验收探针，使用：

```powershell
npm run day5:acceptance
```

该脚本默认连接 `ws://127.0.0.1:4510/ws`，对当前 Spike 尚未实现的能力输出
`BLOCKED` 及证据；设置 `DAY5_STRICT=1` 可让阻断项以退出码 2 失败，详见
[`docs/day5-acceptance-matrix.md`](docs/day5-acceptance-matrix.md)。

Central Gateway 模式的“工作区验证”面板也会使用同一组 `device.*` 操作；连接级
Thread 隔离由网关强制执行，客户端不能通过 payload 自行指定其他设备或工作区。

Local Agent 拒绝绝对路径、`..`、符号链接逃逸、超过 1 MiB 的文件，以及不在白名单中的命令。Fake Central 只监听 `127.0.0.1`，不会连接 OpenAI。

开发模式使用单独的 CSP，仅额外允许 Vite React Refresh 的内联启动脚本和本机
`1420/4310/4501/4510` WebSocket；App Server 与桥接代理连接仍限制在 localhost。

### Windows 桌面白屏排查

如果 `http://127.0.0.1:1420/` 在普通浏览器中正常，但 Tauri 窗口持续白屏，先确认 WebView2 是否创建了 renderer 进程，并检查 Windows 事件查看器中的 `Microsoft-Windows-CodeIntegrity/Operational` 日志。

当前开发机上的排查记录显示，WebView2 renderer 被 Code Integrity 事件 3033 阻止：`C:\Windows\System32\winhafnt64.dll` 和 `winncap364.dll` 属于 TEC Solutions 的 OCular Agent，但不满足 WebView2 要求的 Microsoft 签名级别。退出搜狗输入法、使用全新 profile，以及改用已知可工作的 WebView2 Fixed Runtime 133 均未改变结果，因此需要升级、卸载或由管理员为 OCular Agent 配置兼容/白名单后再启动桌面应用。

不要把 `--no-sandbox` 或 `--disable-features=RendererCodeIntegrity` 作为产品修复；它们会削弱 WebView2 的进程隔离或完整性保护，也不能解决本机的 OCular Agent 注入冲突。

## 边界

- 不内置 Codex、OpenAI 凭据或 App Server 进程；Local 模式依赖你在本机自行启动 `codex app-server`，Central Test Gateway 模式由测试网关以 stdio 启动；
- 不复制 Codexia 或 Soromi 源代码；
- 不提供登录、数据库、生产认证或完整审计；
- 当前 `services/test-gateway` 是 Day 3/Day 4 的本地 Spike 和中央机测试网关，仍需补齐固定版本 Codex App Server 管理、平台认证、Worker 隔离、正式 WSS/mTLS、审批/审计和多用户路由。
