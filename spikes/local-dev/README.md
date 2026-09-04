<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# 本地纵向技术 Spike

## 长任务状态与实时命令输出（2026-09-04）

`device_exec` 已支持从客户端 Local Agent 实时回传 stdout/stderr。命令有换行时逐行展示；
没有换行的输出每 250 ms 尝试刷新，超长行拆为小帧。客户端在输入框上方显示常驻执行卡片，
包含工具/程序、工作目录、实时耗时、退出码、截断、失败、中断和断线后状态未知；日志与 Codex
回复分开，不会伪装成模型文本。用户向上滚动日志后不会被强制拉回底部。

Agent WebSocket 的收发和命令任务已解耦，执行期间继续心跳并可接收取消。Turn 中断会通过
`job.cancel` 终止关联的本机进程树。命令默认超时 30 分钟，可用 `timeoutMs` 调整，中央网关和
Agent 均限制在 1 秒到 2 小时。最终工具结果仍限制为每流 64 KiB；界面实时流每流最多 1 MiB，
超出时明确标记截断并继续排空管道，避免子进程因输出无人读取而卡死。

兼容策略：只有声明 `exec-stream/v1` 的 Agent 才显示实时输出；旧 Agent 继续等待最终结果，
客户端明确提示当前版本不支持流式输出。目标程序自身若在管道模式下缓存输出，平台无法强制
它刷新；例如 Python 可由任务显式选择无缓冲模式。

## 统一桌面与 Agent 配置（更新于 2026-09-04）

安装包不再写入固定的 `userId=desktop-user&deviceId=desktop-device`。首次启动时，“设置 → 常规与连接”
自动预填中央网关、用户 ID、设备 ID 和本机工作区，用户确认后点击“保存并应用”。用户 ID 默认取当前
系统账号名；设备 ID 默认由电脑名和持久化安装 UUID 的短段组成，两项都可编辑。桌面端用这些字段分别
组装 `/ws?userId=...&deviceId=...` 与 `/ws/agent?deviceId=...`，再启动 Local Agent 和附件 IPC 并连接 UI。
工作区目录浏览及相对命令 cwd 使用新的本机目录；中央模式不再把此路径作为 App Server cwd。
“工作区与工具”页面显示实际工作区，并可返回原设置入口修改。

本机工作区默认预填为 Windows“文档/Codexia Workspace”或 macOS
`~/Documents/Codexia Workspace`。它是 Local Agent 浏览文件和执行命令时的默认根目录；相对路径以此
为起点，选择或保存它不会自动上传文件，也不会让中央机把该目录当作自己的工作目录。默认目录只在
首次“保存并应用”时创建，显示预填值本身不会改动文件系统；用户填写的其他不存在目录仍按无效配置处理。

配置保存在 Tauri 应用配置目录的 `desktop-runtime-v1.json`；Windows 为
`%APPDATA%/com.centralcodex.localspike/desktop-runtime-v1.json`。升级时保留已有身份和工作区；旧配置中
网关 URL 的 `userId`、`deviceId` 会迁移到独立字段，其他查询参数保留。原“默认工作目录”曾是 App Server
参数，因此不会自动迁移为本机工作区。主题、模型、推理强度、
速度继续使用现有偏好存储。`CODEXIA_GATEWAY_AGENT_URL`、`CODEXIA_WORKSPACE_ROOT`、
`CODEXIA_LOCAL_AGENT_PATH` 覆盖优先，页面显示覆盖来源；移除环境变量并重启后恢复保存配置。

任务、提交状态不明或文件传输期间暂停配置切换。Agent 对在途命令/传输再次校验；配置无效时
保留原进程，启动或原子保存失败时恢复旧配置和 Agent。新地址暂不可达时配置仍保存，页面明确
显示中央连接失败，可重试连接或重新修改地址。进程已启动和设备已在线是两个独立状态。

基础配置验收见[客户端统一配置实施与验收](../../docs/客户端统一配置实施与验收-2026-09-03.md)，
自动身份与默认工作区见[2026-09-04 实施验收](../../docs/客户端首次身份与默认工作区实施验收-2026-09-04.md)。
进程级专项回归（独立测试设备，不触发模型推理）：

```powershell
cargo build -p local-agent
$env:CODEXIA_LOCAL_AGENT_PATH = (Resolve-Path 'target/debug/local-agent.exe').Path
cargo test -p desktop-spike runtime_process_integration -- --ignored --nocapture
Remove-Item Env:CODEXIA_LOCAL_AGENT_PATH
```

专项测试要求当前 shell 未设置 `CODEXIA_GATEWAY_AGENT_URL` / `CODEXIA_WORKSPACE_ROOT`。
请在独立测试 shell 中运行，避免改变已有开发覆盖。

## 桌面安装包与首次启动（2026-09-03）

在目标系统上运行 `npm run package:desktop`，Windows 生成 x64 NSIS 用户级安装包，macOS
生成当前主机架构的 `.app` 和 `.dmg`。本轮已验证 Windows x64 和 Apple Silicon；Intel Mac
尚未验证。客户端安装后无需 Node、Rust、Codex 或手动启动 Agent；这些只是构建机依赖。

```bash
npm ci
npm run package:desktop
# 需要可调试的打包产物时：npm run package:desktop -- --debug
```

脚本先按 Rust host target 构建 `local-agent`，将它暂存为
`apps/desktop/src-tauri/binaries/local-agent-<target>[.exe]`，再通过
`tauri.bundle.conf.json` 的 `externalBin` 交给 Tauri。最终 Agent 位于 Windows 应用可执行文件
旁边，或 macOS `.app/Contents/MacOS/`。Rust 保留现有匿名管道和生命周期管理，不增加 JS Shell 权限。
暂存二进制被 Git 忽略；干净源码应使用上述入口完成构建，不能单独给 Tauri 指定打包配置而省略 Agent。

默认产物位于 `target/desktop-package/<target>/release/bundle/`；`--debug` 对应 `debug/bundle/`。
可以用 `CARGO_TARGET_DIR` 改变构建缓存根目录。打包与 `dev:desktop` 的运行文件隔离，开发入口不变。
DMG 默认使用 Tauri 的 CI 模式，省略 Finder 窗口图标排版，避免远程构建依赖 AppleEvents 权限。

安装版首次没有保存配置时，自动打开原有“常规与连接”页面，显示自动生成且可编辑的用户 ID、设备 ID，
并预填系统“文档/Codexia Workspace”。用户点击“保存并应用”前不启动 Agent、不自动连接中央，也不创建
默认目录。保存时创建尚不存在的默认目录；其他路径仍可使用系统目录选择器指定。
已有 `desktop-runtime-v1.json` 和设备标识沿用；升级不改应用 identifier。开发调试版本仅在
相对 fixtures 确实存在时沿用它；环境覆盖继续有效。内嵌前端只提供中央网关模式，开发服务器
仍保留协议调试模式。

本轮产物为局域网试用包：Windows 未做发布者签名，Mac 只有链接器生成的 ad-hoc 签名，
没有 Developer ID 签名/公证，也没有自动更新。正式分发前需完成签名、公证及安装/升级验收。
不应通过关闭系统安全检查来替代这些步骤。
详细文件、校验值和验收边界见[桌面打包与首次配置验收](../../docs/客户端打包与首次配置验收-2026-09-03.md)。

## Windows 命令输出编码（2026-09-03）

Local Agent 对命令 stdout/stderr 优先识别 UTF-8 和 BOM；无 BOM 的非法 UTF-8 在 Windows
回退到本机 OEM 代码页（本轮中文系统为 CP936）。带 BOM 的 UTF-16LE/BE 同样可读。
成功与 `COMMAND_FAILED` 共用解码，输出限制仍为每流 64 KiB，截断保留完整 Unicode 字符。
不修改 PowerShell 参数或系统代码页，文件读写继续沿用原有 UTF-8 协议。
混合编码、自定义代码页、无 BOM 的 UTF-16 不保证自动识别；推荐工具显式输出 UTF-8。

在 Windows 客户端独立 shell 中运行真实链路验收（默认中央地址 `192.0.2.10:4510`，
可由 `DEVICE_GATEWAY_URL` 覆盖），不会创建模型 Turn：

```powershell
$env:LOCAL_AGENT_BIN = (Resolve-Path 'target/desktop-package/x86_64-pc-windows-msvc/release/local-agent.exe').Path
npm run encoding:smoke
```

测试生成独立设备及临时中文目录，覆盖 PowerShell/cmd 默认编码、stdout/stderr、非零退出、
UTF-8 emoji、UTF-16 BOM 与长中文截断，完成后清理测试资源。
证据见[命令输出编码修复与验收](../../docs/客户端命令输出编码修复与验收-2026-09-03.md)。

## macOS 原生开发与验证（2026-09-03）

使用 Node 24、npm 11、Rust stable，以及可用的 Apple Command Line Tools。
`rust-toolchain.toml` 使用当前主机目标，不再要求安装 Windows target；Apple Silicon
原生目标为 `aarch64-apple-darwin`。如果全局选中了不兼容的旧 Xcode，而已安装新版
Command Line Tools，可只在构建 shell 设置 `DEVELOPER_DIR=/Library/Developer/CommandLineTools`。

在本目录运行：

```bash
npm ci
npm run dev:desktop
```

桌面会自动启动同目录的 `local-agent`，无需在 Mac 客户端安装 Codex 或手动启动 Agent。
检查及生成不依赖 Vite 服务器的调试版可执行文件：

```bash
cargo fmt --check
cargo check --workspace --locked
cargo test --workspace --locked
cargo build -p local-agent --locked
npm run tauri:build --workspace @central-codex-spike/desktop -- --debug
./target/debug/desktop-spike
```

上述命令仍为未打包开发产物。桌面与 Agent 必须相邻；首次启动使用仓库中的
`fixtures/workspace`，随后可在设置中保存自己的目录。关闭唯一窗口会请求退出整个应用，
应用退出事件统一停止 Agent，包含 macOS 应用菜单退出路径。

macOS 配置切换进程专项：

```bash
CODEXIA_LOCAL_AGENT_PATH="$PWD/target/debug/local-agent" \
  cargo test -p desktop-spike runtime_process_integration -- --ignored --nocapture
```

`smoke`、`attachment:smoke`、`output:smoke` 已使用平台对应的可执行文件后缀和本机 shell；
可用 `LOCAL_AGENT_BIN` 指定二进制。`OUTPUT_SKIP_MODEL=1 npm run output:smoke` 只验证
Agent 输出处理及真实中央设备命令，不创建模型 Turn。普通 `smoke` 使用隔离 Fake Central，
不能替代真实中央验收。

实测范围和剩余项见 [macOS 编译与运行验收](../../docs/客户端macOS编译与运行验收-2026-09-03.md)。

## 图片输出与客户端写入（2026-09-03）

生成/编辑图片现在显示为对话图片卡片，并通过 Local Agent 自动保存到本机系统下载目录的
`Codexia` 子目录。已有对话中的 `imageGeneration` 结果也会在恢复历史时补齐；卡片支持
查看大图、打开所在目录，以及保存失败后重试。中央路径不会作为本机路径展示或传给 Agent。

中央模型可调用 `device_write_file` 创建/修改文本、`device_copy_file` 复制文件、
`device_publish_file` 校验并展示由客户端命令生成的文件；`device_output_paths` 查询实际
目录，`device_list_outputs` 返回保存结果。旧对话通过 `device_exec` 的 `codexia.files`
兼容入口使用同一条 Agent 链路，不需要重建对话。

可信局域网模式允许本机绝对路径和绝对命令 cwd，受当前系统用户权限限制；相对路径仍约束在
工作区。文本写入最多 256 KiB，图片/复制/发布最多 20 MiB；分块写入为 256 KiB，提交后
回读校验 SHA-256。图片默认另存，结构化写入覆盖不同内容必须携带 `overwrite=true` 与
`expectedVersion`。同内容重试不会重复创建文件。此覆盖保护不替代普通客户端命令自身的行为。

运行 `npm run output:smoke` 验证真实中央模型写入、兼容入口、客户端绝对 cwd、错误返回及
图片保存重试；设置 `OUTPUT_IMAGE_SMOKE=1` 增加真实图片生成与实时保存事件验收。
需先构建 `local-agent` 和网关，测试默认连接当前真实中央机。
详见[图片输出与客户端写入验收记录](../../docs/图片输出与客户端写入实施验收-2026-09-03.md)。

## 当前附件 MVP（2026-09-03）

正式桌面主链路是中央机 `192.0.2.10:4510` + 桌面自动管理的 Local Agent。
下文 Fake Central / 本机 App Server 命令仅保留为独立开发探针，不是附件运行入口。

在本目录运行 `npm run dev:desktop`，无需另外启动 Agent。点击输入框左下角的加号
选择附件，也支持拖拽和粘贴截图；已移除手动路径输入入口。添加阶段只走 Tauri 与 Agent 的匿名管道，点击发送后
才向中央提交附件引用。图片由 Agent 读取，通过 256 KiB 块交给网关内存，适配
App Server `image.url`；文本/代码通过 `device_read_text` 按需读取，PDF/Office
当前仅附加引用，尚无解析器。

图片限制：PNG/JPEG/WebP/GIF，单张 5 MiB、每回合共 10 MiB，最多 10 个附件；
图像尺寸不超过 8192×8192 且不超过 1600 万像素，解码分配上限 80 MiB。
不缩放原图输入，本机缩略图最大 240×180。已发送消息和历史保留附件卡片。

桌面首次启动时，Agent 在 Windows `%LOCALAPPDATA%/Codexia/device-id-v1`
（macOS `$HOME/.local/share/Codexia/device-id-v1`）登记随机设备标识。
旧的默认 `desktop-device` 会自动解析为 `desktop-<设备标识>`，避免多机争用同名
设备；UI 在连接前通过本机 IPC 获取实际标识。显式设置的其他 `deviceId` 保持原值，
但必须与 Agent 一致。Thread 会保留来源设备；已绑定其他设备的 Thread 不能用新设备
发送附件，应连接原设备或新建对话。已有 `CODEXIA_*` 开发覆盖变量继续支持。

剪贴板图片仅在点击发送时由 Agent 落盘到系统临时目录的 `codexia-attachments-v1`；
随机命名并登记，容量上限 100 MiB，登记后保留 7 天，下次导入时清理过期登记文件。
发送失败的临时图片也保留 7 天用于重试。移除附件只移除引用，不删除用户原文件。
应用不会自动安装文档解析器或执行宏。

附件失败保留草稿；未知提交结果先用“核对历史”确认，不自动重发。平台记录消息 ID、
Turn、设备和附件元数据，中央不新增原文件仓库；App Server 自己的历史可能保存内容。
未完成的图片传输空闲 60 秒过期，显式取消/完成时主动关闭。

验证命令：

```powershell
npm run check
npm run build --workspace @central-codex-spike/desktop
npm run build --workspace @central-codex-spike/test-gateway
npm run history:smoke
npm run multi-session:smoke
npm run attachment:smoke
node scripts/attachment-contract-smoke.mjs
```

`attachment:smoke` 默认访问真实局域网中央，自动启动独立测试设备、在 workspace 外
生成图片/文本并测试视觉识别、文本读取、历史和重复提交；可用 `ATTACHMENT_GATEWAY_URL`
及 `LOCAL_AGENT_BIN` 覆盖地址/二进制。需先构建 `local-agent`。负向协议探针使用真实
网关和合成设备测试离线、旧版本、错误设备和取消，不把合成设备当作真实视觉验收。
详见 [附件 MVP 实施与验收记录](../../docs/客户端附件MVP实施与验收-2026-09-03.md)。

该目录用于阶段 1 的本地开发验证，不是正式产品工程，也不代表生产版本已经锁定。

当前桌面端已采用 Codexia Workspace 正式工作台界面：左侧提供连接模式、Thread
管理和设备工作区，中央提供对话、流式状态、审批和活动日志；底层仍连接本目录的
中央测试网关与 Local Agent，便于在局域网环境持续验证核心流程。

单个桌面窗口支持多个 Thread 同时运行，每个 Thread 仍限制一个活动 Turn。左侧列表分别显示
“进行中 / 待确认 / 待核对”；切换或新建对话不会中断后台 Turn。消息增量、Turn ID、执行日志、
审批队列、未确认提交以及文本/附件草稿均按 Thread 隔离，停止按钮只中断当前 Thread。后台完成、
失败或请求审批时显示可点击提醒。任一 Thread 仍在运行时继续禁止重配 Agent 工作区，运行中的
Thread 不能归档或删除。

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

2. 桌面模式运行 `npm run dev:desktop` 自动管理 Agent。仅独立设备诊断时可运行：

   ```powershell
   cargo run -p local-agent -- --workspace-root C:\work\project `
     --gateway-url ws://192.0.2.10:4510/ws/agent --allow-insecure-lan
   ```

3. 启动桌面端，在“中央测试网关”模式填写
   `ws://192.0.2.10:4510/ws?userId=<用户标识>&deviceId=<设备标识>`，连接后即可使用：
   Thread 创建/恢复/重命名/归档/删除、实时对话、Markdown 消息、工作区目录浏览、文件读取和白名单版本命令。
   连接成功后客户端还会调用中央 App Server 的 `model/list`，在对话输入框提供中央可用模型、推理强度和速度切换；中央网关需部署支持 `model.list` 的版本。

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

旧 `read_file` 仍限制 workspace 相对路径；相对命令 cwd 拒绝 `..` 和符号链接逃逸。
新增 `file/*` 附件方法在 `--allow-insecure-lan` 下允许本机绝对路径；文本按页读取，
图片有单独大小/像素限制。当前 `exec` 支持普通客户端命令及 PowerShell，可信局域网模式
也允许客户端绝对 cwd。Fake Central 只监听 `127.0.0.1`，不会连接 OpenAI。

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
