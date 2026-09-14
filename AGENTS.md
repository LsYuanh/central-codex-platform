# AGENTS.md

本文件适用于整个仓库。后续自动化开发代理在修改代码前应先阅读本文件，并遵守其中的架构边界和验收要求。

## 项目目标

本项目是中央化 Codex 多用户远程工作平台。当前优先完成可信局域网内的核心功能和客户端正式 UI，权限、认证、WSS/mTLS 和生产级多用户隔离后续再完善。

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

按顺序阅读与任务相关的文档：

1. `docs/客户端UI与Local-Agent开发交接文档-2026-09-02.md`
2. `docs/中央化Codex多用户远程工作平台-需求与架构设计-V0.2.md`
3. `spikes/local-dev/README.md`
4. `spikes/local-dev/AGENTRPC.md`

当前主要开发目录是 `spikes/local-dev/`。不要为了实现同一功能另建平行代码库、复制一套 UI，或在临时目录中形成第二个产品入口；修改应整合到现有目录。

## 当前运行架构

```text
Tauri + React 客户端
        │ ws://<central>:4510/ws
        ▼
Central Test Gateway
        │ stdio
        ▼
Codex App Server（中央机）

Local Agent（客户端）
        │ ws://<central>:4510/ws/agent
        ▲
Device Broker / dynamic tools
        │
客户端文件系统、Git、PowerShell、命令
```

当前真实中央机局域网地址：

- UI 网关：`ws://192.0.2.10:4510/ws`
- Agent 网关：`ws://192.0.2.10:4510/ws/agent?deviceId=desktop-device`
- 健康检查：`http://192.0.2.10:4510/healthz`

这些地址是当前可信局域网 Spike 配置，不代表生产配置。不得将 4510 端口暴露到互联网。

## Local Agent 生命周期

桌面客户端必须管理 Local Agent 生命周期：

- 桌面程序启动时自动启动 Local Agent；
- 桌面窗口关闭时自动停止 Local Agent；
- `dev:desktop` 在启动 Tauri 前先构建 `local-agent`；
- 默认从桌面可执行文件同目录寻找 `local-agent.exe`；
- 正式打包阶段再迁移为 Tauri sidecar 或安装包资源。

相关实现：

- `spikes/local-dev/apps/desktop/src-tauri/src/main.rs`
- `spikes/local-dev/package.json`

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
6. 设置持久化、正式认证和权限 UI。

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
- 默认工作目录受客户端工作区边界约束；
- 不能把中央机执行结果伪装成客户端执行结果；
- 中央 App Server 发出的系统命令/文件审批不得在中央机直接放行执行。

## 常用命令

在 `spikes/local-dev/` 中运行：

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
npm run build --workspace @central-codex-spike/test-gateway
Invoke-RestMethod http://192.0.2.10:4510/healthz
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
6. 交接文档或 README 在运行方式发生变化时同步更新；
7. 本次相关修改已经提交到本地 Git；是否打包发布按用户当次明确要求执行。
