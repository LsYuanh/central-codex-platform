# AGENTS.md

本文件适用于整个仓库。后续自动化开发代理在修改代码前应先阅读本文件，并遵守其中的架构边界和验收要求。

## 项目目标

本项目是中央化 Codex 多用户远程工作平台。截至 2026-09-20，可信局域网部署已使用 WSS、配对码、设备令牌和按用户 Worker；继续完善客户端、中央管理和生产级隔离。当前状态与验收缺口见 `docs/README.md`，不要把早期 mTLS 方案当作当前默认认证。

必须保持以下核心架构：

- Codex 和 Codex App Server 只运行在中央机；
- 中央机只负责推理、Thread 和工具请求编排；
- 文件读取、文件修改、Git、PowerShell 和其他系统操作必须在目标客户端执行；
- 客户端系统操作统一经 Local Agent 执行；
- Local Agent 主动出站连接中央网关，客户端不开放入站 SSH；
- 客户端不依赖本地 Codex、Codex CLI、Codex helper 或本地 App Server；
- SSH 只用于开发人员配置和诊断中央机，不得成为产品运行链路的一部分。

任何会让中央机直接操作客户端文件系统、让客户端本地 Codex参与推理、或让正式客户端退回 Fake Central 的改动，都属于架构回退，禁止提交。

## 开始工作前

每个新对话在实施前先读 `docs/项目上下文.md`，快速了解当前架构、已完成能力、版本、代码入口和交接事项。随后按任务范围读取：

1. `docs/README.md` 中对应的维护手册
2. `docs/开发指南.md`（开发运行与检查）
3. `AGENTRPC.md`（涉及设备工具或协议时）
4. `docs/中央化Codex多用户远程工作平台-需求与架构设计-V0.2.md`（仅在需要追溯历史需求时；以维护手册说明的后续变更为准）

`docs/项目上下文.md` 是唯一的新对话上下文摘要，固定路径持续更新，不为每次交接复制一份。任务改变架构、关键决定、能力、代码入口、版本、部署、验收结论或接续事项时，在同一提交中更新相关摘要、日期及对应维护手册；未完成工作写明做到哪里、下一步与阻塞。没有变化的事实无需改写。代码已实现、本地已验证与实际已发布必须分开记录，不能保存秘密或将历史授权视为当前部署授权。

当前主要开发目录是仓库根目录，使用根目录的 npm/Cargo workspace。应用在 `apps/`，中央服务在 `services/`，共享原生模块在 `crates/`，测试在 `tests/`。不要为了实现同一功能另建平行代码库、复制一套 UI，或在临时目录中形成第二个产品入口；修改应整合到现有目录。

## 当前运行架构

```text
Tauri + React 客户端
        │ wss://<central>:4510/ws
        ▼
Central Gateway
        │ stdio
        ▼
Codex App Server（中央机）

Local Agent（客户端）
        │ wss://<central>:4510/ws/agent
        ▲
Device Broker / dynamic tools
        │
客户端文件系统、Git、PowerShell、命令
```

当前真实中央机局域网地址：

- UI 网关：`wss://192.0.2.10:4510/ws`
- Agent 网关：`wss://192.0.2.10:4510/ws/agent`，使用已配对设备凭据，不用 URL 查询参数传身份或秘密
- 健康检查：`https://192.0.2.10:4510/healthz`，使用既有公共 CA 验证

这些地址是当前可信局域网部署配置，不代表已取得完整生产发布资格。不得将 4510 端口暴露到互联网，也不得跳过 TLS 验证。

## Local Agent 生命周期

桌面客户端必须管理 Local Agent 生命周期：

- 桌面程序配置就绪后自动启动 Local Agent（首次配置未保存时不启动）；
- 桌面窗口关闭时自动停止 Local Agent；
- `dev:desktop` 在启动 Tauri 前先构建 `local-agent`；
- 默认从桌面可执行文件同目录寻找 `local-agent.exe`；
- 安装包已通过 Tauri `externalBin` 内置 Local Agent，继续使用现有生命周期管理。

相关实现：

- `apps/desktop/src-tauri/src/main.rs`
- `package.json`

支持的开发覆盖变量：

- `CODEXIA_LOCAL_AGENT_PATH`
- `CODEXIA_WORKSPACE_ROOT`
- `CODEXIA_GATEWAY_AGENT_URL`

不要重新要求用户手动启动 Local Agent，也不要要求用户保持本地 Codex 桌面程序运行。

## UI 开发原则

下一阶段以完善现有 Codexia Workspace UI 为主。优先级如下：

1. 连接、重连、错误和设备在线状态；
2. Thread 创建、恢复、选择、重命名、归档和删除；
3. 消息发送、流式输出、完成、失败和中断；
4. 客户端工作区目录、文件读取和命令执行结果；
5. loading、空状态、错误状态、toast 和响应式布局；
6. 维护已有设置持久化、设备配对、版本更新及权限 UI。

UI 必须明确区分：

- 中央网关是否连接；
- Local Agent/设备是否在线；
- 当前 Turn 是否正在运行；
- 工具请求是在中央侧编排还是已经在客户端执行。

禁止用无限 loading 掩盖协议错误。每个异步操作必须有成功、失败、超时或可重试的终态。不要在客户端展示中央机工作目录、中央磁盘或中央系统信息作为本机信息。

继续修改现有组件和样式，不要恢复最初的 `Central Codex Platform / Phase 1` 演示页面。

## 设备工具边界

中央网关通过动态设备工具调用 Local Agent。当前核心工具包括：

- `device_workspace_list`
- `device_read_file`
- `device_exec`

`device_exec` 可调用本机 PowerShell，例如：

```text
powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem"
```

新增工具时应遵循：

- 中央侧只生成和路由请求；
- Local Agent 负责实际执行；
- 返回值通过网关回传中央 App Server；
- 按用户 2026-09-14 确认的需求，配置目录仅作为默认输出目录，不再作为文件访问边界；文件路径和命令 cwd 可指向本机系统账号有权访问的其他目录；
- 不能把中央机执行结果伪装成客户端执行结果；
- 中央 App Server 发出的系统命令/文件审批不得在中央机直接放行执行。

## 常用命令

在仓库根目录运行：

```powershell
npm install
npm run dev:desktop
npm run check
npm run smoke
npm run device:smoke
cargo check --workspace
cargo test --workspace
```

前端单独检查：

```powershell
npm run check --workspace @central-codex-spike/desktop
npm run build --workspace @central-codex-spike/desktop
```

网关检查：

```powershell
npm run build --workspace @central-codex-spike/central-gateway
curl.exe --fail --cacert 'C:\path\to\existing-public-ca.pem' https://192.0.2.10:4510/healthz
```

不要在已有 Tauri/Cargo 进程占用 `target` 构建锁时反复并行启动构建；先确认运行进程和端口占用。

## 验证要求

按改动风险执行最小充分验证：

- UI 改动：TypeScript check、Vite build，并实际查看 Tauri 页面；
- Tauri/Rust 改动：`cargo fmt --check`、`cargo check -p desktop-spike`；
- Local Agent 改动：`cargo check/test`，再运行设备 smoke；
- 网关改动：TypeScript build、协议 smoke，并验证真实中央连接；
- 生命周期改动：实际启动客户端，确认 Local Agent 出现；关闭窗口，确认 Local Agent 退出；
- 系统工具改动：确认结果来自客户端机器，而不是中央机。

真实生命周期验收预期：

```text
客户端启动：desktop-spike=1，local-agent=1，healthz devices=1
客户端关闭：desktop-spike=0，local-agent=0，healthz devices=0
```

如果真实中央机不可用，应明确记录未验证项，不得用 Fake Central 的成功代替真实链路验收。

## 代码与 Git 约束

- 优先使用 `rg`/`rg --files` 搜索；
- 使用小范围补丁，保留用户已有改动；
- 不执行 `git reset --hard`、`git checkout --` 或未经确认的递归删除；
- 不覆盖原有代码库，不创建平行产品目录；
- 修改完成后保持原项目目录可运行，并在交接中列出文件、命令和验证结果；
- 提交前检查 `git status --short`，不要把构建产物、日志、数据库和密钥提交；
- 每次任务的修改完成并通过相关验证后，提交到本地 Git，并在交接中说明提交哈希；只提交本次任务相关改动，保留其他已有改动，未经明确要求不推送远程；
- 仓库可能保留用户之前的 Git stash。恢复或删除前先运行 `git stash list`，不得擅自清理。

## 打包与发布约定

- 日常修改完成后执行必要的检查、测试和本地 Git 提交，不自动打包或发布；
- 只有用户明确要求发新版、打包或发布时，才执行相应的版本号更新、安装包构建、签名和发布操作；发布授权仅适用于当次指定版本，不延续到后续日常修改；
- TypeScript/Vite 构建、`cargo check/test` 等必要验证可照常执行，不等同于生成安装包或发布；
- 不因修改完成就自动同步安装包、替换已安装客户端、切换中央版本清单或部署正式服务。

## 完成定义

一个功能只有在以下条件都满足时才算完成：

1. 修改已经进入现有项目目录；
2. 没有违反“中央推理、客户端执行”的核心边界；
3. 相关静态检查和构建通过；
4. 风险较高的链路经过真实运行验证；
5. 页面有明确的成功、失败和恢复状态；
6. 运行方式变化时同步维护手册或 README；项目上下文中的相关事实或接续事项变化时同步更新 `docs/项目上下文.md`；
7. 本次相关修改已经提交到本地 Git；是否打包发布按用户当次明确要求执行。
