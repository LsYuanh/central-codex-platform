# B.3-A0 推荐改造方案启动决策清单

> 状态：Conditional Go（允许启动技术 Spike，不允许直接进入生产 Fork）  
> 更新时间：2026-09-01  
> 关联需求：[中央化 Codex 多用户远程工作平台-需求与架构设计-V0.2.md](./中央化Codex多用户远程工作平台-需求与架构设计-V0.2.md)  
> 关联路线：[中央化 Codex 平台-总体开发路线-V1.0.md](./中央化Codex平台-总体开发路线-V1.0.md)

## 1. 决策结论

现在可以开始 B.3 的方案验证和五个工作日技术 Spike，但不能把当前本地 UI/App Server 联调链路直接升级为生产架构，也不能在 Go/No-Go 之前全面 Fork Codexia 并开始功能开发。

本次启动的范围是：

- 核验 Codexia 的可构建性、模块边界、固定 Commit 和许可证；
- 验证桌面 UI 经中央测试网关访问中央 App Server；
- 验证中央 Worker、Remote Workspace Bridge、Device Broker 和 Local Agent 的最小纵向闭环；
- 形成可审计的改造清单、复用清单和 Go/No-Go 结论。

以下边界在 Spike 期间也必须保持不变：

1. 只有中央机运行 Codex 并访问 OpenAI。
2. 客户端不安装或启动 Codex，不保存 OpenAI/ChatGPT 凭据或中央 Codex 登录态。
3. 生产桌面端只访问平台自有稳定 API/Event Stream，不直接连接或透传 Codex App Server JSON-RPC。
4. 生产 App Server 只由中央网关通过本机 `stdio` 或 Unix Socket 驱动，不开放局域网端口。
5. 客户端执行能力只能经 Local Agent、Device Broker 和 AgentRPC 受控调用，客户端默认只建立出站连接。

## 2. 当前仓库证据

| 能力 | 当前状态 | 证据和限制 |
|---|---|---|
| Tauri/Rust/React UI | 已有本地 Spike | `spikes/local-dev/apps/desktop` 已具备 Thread、流式事件、审批等测试界面；尚未证明可直接复用 Codexia。 |
| App Server 协议 | 已完成本地真实握手验证 | `services/app-server-proxy` 将浏览器开发请求转到本机 `codex app-server`；这是开发桥接，仅用于协议和 UI 测试。 |
| AgentRPC V1 | 已有最小合同和校验 | `packages/agentrpc-types`、`crates/local-agent`、Fake Central/Bridge 可做协议 smoke；尚未包含生产 mTLS、设备证书和审计。 |
| 中央 Worker/`CODEX_HOME` 隔离 | 未开始生产实现 | 当前 Worker 为 Fake/本地验证实现，尚未接入真实中央 macOS 生命周期、配额和故障恢复。 |
| 中央网关稳定 API | 未开始 | 当前 UI 仍可选择 Local App Server 开发模式；正式模式必须改为网关资源模型，不暴露 App Server 地址。 |
| 多用户/租户/Thread 所有权 | 未开始 | 需要平台账号、Session、MFA、服务端强制过滤和跨用户测试。 |
| Device Broker 安全链路 | 部分验证 | 已有版本化消息和出站方向的 Spike；尚未完成 mTLS、配对、吊销、重放保护、取消、重连和降级阻断。 |
| Codexia Fork 准备度 | 法务待复核 | 当前观察点已固定到 Commit，但仍需归档依赖许可证、确认商业再许可边界，并由团队法务做最终结论。 |

当前 `ws://127.0.0.1:4501`（本地桥接）和 `ws://127.0.0.1:4500`（本机 App Server）只能标记为 `dev-only`，不得出现在生产配置、安装包或正式验收链路中。

## 2.1 Day 1 初步核验记录（2026-09-01）

来源：`https://github.com/milisp/codexia`，临时副本目录为系统 Temp，不纳入本仓库。

- 观察点：`master` HEAD `c8c9e65803596b02480da100560309f265bc7526`，提交时间 `2026-09-01T06:54:11-04:00`，提交说明为 `docs: update release note for 0.49.0`。
- 上游版本：`package.json` 为 `0.49.0`，Canonical 包管理器为 Bun（存在 `bun.lock` 和 `AGENTS.md` 说明）。
- 许可证：当前 Commit 的根目录 `LICENSE` 为 MIT，README 的 License 部分也声明 MIT；未发现 `COMMERCIAL.md`。这与需求文档中对旧快照的 AGPL/商业双许可信号不同，不能据此替代依赖许可证和法务核验。
- Windows 环境：本机没有 Bun；使用 `npm install --legacy-peer-deps --ignore-scripts` 完成临时依赖安装。普通 `npm install` 会因 `typescript@7.0.2` 与 `react-i18next` 的 peer 范围冲突而失败，这个兼容性风险需在正式构建环境确认。
- 构建结果：`npm run typecheck` 通过；`npm run build` 通过。Vite 报告动态导入未拆分和大 chunk 警告，另有 `xterm`、`uuid` 等依赖弃用警告，均不是当前构建阻断项。
- 尚未完成：macOS 中央机/客户端构建、Tauri 原生打包、签名、依赖许可证扫描和法律意见。这些仍是 Day 1 的未关闭事项。

外部来源：

- [Codexia 仓库](https://github.com/milisp/codexia)
- [本次固定 Commit](https://github.com/milisp/codexia/commit/c8c9e65803596b02480da100560309f265bc7526)

## 2.2 Day 2 模块边界初步定位（2026-09-01）

| 上游模块 | 关键文件 | B.3 处理结论 |
|---|---|---|
| App Server Adapter | `crates/codex/src/app_server.rs`、`protocol.rs` | 可作为中央 Adapter 的协议参考；其中 `connect_codex()` 当前由桌面 Rust 进程执行 `codex app-server`，必须迁移到中央 Worker，并补充版本锁定、超时、租户上下文和审计。 |
| Server Request/审批 | `crates/codex/src/server_request.rs`、`src-tauri/src/commands/codex/approval.rs` | 保留请求分类和 UI 状态映射思路；审批响应必须改为平台 API + AgentRPC 双层策略，不允许客户端绕过网关直接回 App Server。 |
| Thread/Turn 命令边界 | `src-tauri/src/commands/codex/thread.rs`、`turn.rs`、`src/services/apiAdapt/codex.ts` | `threadStart/threadResume/turnStart/turnInterrupt` 已有清晰调用面；将 Tauri invoke/本地命令替换为 Desktop API，保留前端业务服务的资源模型。 |
| 前端业务状态 | `src/services/codexService.ts`、`src/components/codex/stores/threadsSlice.ts`、`eventsSlice.ts` | Thread/事件归一化和 UI store 具有较高复用价值；需删除依赖本机 `cwd`、本机 Thread 列表和本机 Codex 登录态的分支。 |
| 事件流与历史转换 | `src/components/codex/hooks/useCodexEvents.ts`、`src/utils/threadHistoryConverter.ts` | 可复用展示层和事件到 Item 的转换；生产事件必须由中央网关重新编号、去重并注入用户/Thread 所有权。 |
| 本地 DB/会话 | `crates/db/src/conn.rs`、`acp_sessions.rs`、`automation_runs.rs` | 只能作为本地缓存/测试参考；正式 Thread Store、审计和租户索引必须由中央数据库掌握，客户端不得保存中央会话凭据。 |
| 本地文件/终端/Git | `src/services/apiAdapt/filesystem.ts`、`git.ts`、`terminal.ts` 及对应 Tauri commands | 从中央运行时拆出，经 Device Broker/AgentRPC 调用客户端 Executor；路径、命令策略和二次确认不复用为生产安全边界。 |

关键发现：Codexia 的 `apiAdapt/shared.ts` 已提供 Tauri 与 Web API 的 `dual()` 分流模式，说明前端调用面可以迁移到平台 API；但其 Tauri 分支仍会直接调用本地 `codex app-server`，因此只能复用“接口形状和 UI 状态”，不能原样复用运行时边界。

## 2.3 Day 3 最小中央网关验证（2026-09-01）

已新增 `spikes/local-dev/services/test-gateway`，作为本地中央测试网关替身：

- 网关监听 `ws://127.0.0.1:4510/ws`，内部通过子进程 `codex app-server` 的 stdio 通信；
- 客户端使用 `central-gateway-v1` 封装（`session.initialize`、`conversation.create`、`conversation.turn.create`、`conversation.turn.cancel`）；
- App Server 的通知被转为版本化事件；审批请求映射为网关请求 ID，客户端只能向网关回传审批结果；
- UI 新增 `Central Test Gateway` 模式，保留原 `Local Codex App Server` 作为开发专用模式；
- Node 协议 smoke 已完成网关 `initialize` 和 Thread 创建，返回真实 Codex CLI `0.151.0-alpha.7.2` 的响应；
- 已补充并验证 App Server 单进程初始化缓存：同一网关连续两个客户端连接均能成功 `initialize`，不会重复发送导致 `-32600 Already initialized`；
- 已部署到真实中央 macOS 的 `/Users/operator/central-codex-platform/services/test-gateway`，由中央机实际 Codex 可执行文件通过 stdio 启动 App Server；本机通过 SSH 隧道验证中央机返回的 macOS 运行信息。
- 当前中央网关仅回环监听，客户端经 SSH 隧道访问；尚未完成正式 WSS/mTLS、认证和多用户 Worker 隔离，因此 Day 3 仍为“Spike 完成、生产能力未完成”。

## 2.4 Day 4 最小 Device Broker 验证（2026-09-01）

`services/test-gateway` 已增加 `/ws/agent` 出站 AgentRPC 入口和中央 Device Broker 路由：

- Local Agent 先发送版本化 `agent.hello`，中央返回 `agent.hello_ack`，并维护心跳/在线状态；
- 客户端稳定网关操作 `device.workspace.list`、`device.read_file`、`device.exec` 不透传 App Server，也不允许客户端自行指定 `deviceId`、`workspaceId` 或 `workspaceRoot`；
- 中央网关为每个 Agent 请求生成 `requestId`、`operationId` 和 `idempotencyKey`，将响应映射回 UI；超时、断线和离线状态会返回明确错误码；
- Rust Local Agent 仅允许工作区内路径、1 MiB 内文件、以及 `git --version` / `node --version` 两个受控命令；
- `npm run device:smoke` 已在本机通过 SSH 隧道连接真实中央网关，完成三项调用闭环。
- 客户端 UI 已接入中央 Device Broker 面板；真实中央机回归显示 Agent 在线时可直接列目录、读文件和执行白名单命令。
- Thread 所有权已从进程级收紧为客户端连接级：`thread/list` 只返回当前连接创建的 Thread，`thread/resume`、`turn/start`、`turn/interrupt` 拒绝跨连接 Thread ID；双连接冒烟已验证拒绝跨用户操作。
- Codexia 风格的 Thread/Turn 调用已收敛到客户端 `CodexiaGatewayAdapter`；网关断线会清理挂起请求、停止 UI 回合并允许重新连接。

## 3. B.6 五天 Spike 执行清单

### Day 1：构建与许可证

- [x] 固定 Codexia 目标 Commit，并保存仓库根目录 LICENSE 观察结果；依赖许可证快照和 NOTICE 仍待归档。
- [ ] 在中央 macOS、Windows x64、客户端 macOS Apple Silicon 完成构建尝试；当前仅完成 Windows 临时副本构建。
- [ ] 记录 Rust/Node/WebView2/Xcode/签名/打包依赖和失败原因。
- [ ] 输出 Codexia Fork 许可证和商业再许可书面结论；当前仍保持 No-Go，直到法务和依赖扫描完成。

### Day 2：模块边界

- [x] 定位 App Server Adapter、Thread Store、事件归一化、审批、文件树、终端和 Git 模块。
- [x] 标记“保留/替换/新增”文件级改造清单，记录上游 Commit 和补丁边界。
- [ ] 确认固定 Codex/App Server Schema 的生成和兼容性测试入口。
- [x] 初步定义中央网关 API 与前端调用面，禁止把 App Server JSON-RPC 作为客户端公共协议；具体 Schema 和错误码仍待 ADR 固化。

### Day 3：中央对话闭环

- [x] 桌面 Tauri UI 已通过中央测试网关完成 `initialize`、Thread 创建/恢复；真实中央机窗口已验证在线、Thread 创建和恢复。Turn 流式事件/中断仍需真实模型回合专项验证。
- [x] 中央测试网关通过本机 `stdio` 驱动 App Server；正式中央 macOS 运行环境和 Unix Socket 仍待验证。
- [ ] 抓包确认客户端没有 OpenAI/ChatGPT 流量、凭据或中央 App Server 原始连接。
- [x] 网关协议 smoke 验证客户端连接的是 `4510/ws` 稳定封装，未连接 `4500`；客户端进程树/抓包验证仍待完成。

### Day 4：远程执行闭环

- [x] 移植最小 Rust Local Agent，只实现 `workspace/list`、`read_file` 和受控 `exec`。
- [x] Local Agent 通过客户端主动出站的 AgentRPC WebSocket 连接中央 Device Broker（当前 Spike 使用 SSH 隧道承载，生产仍需 WSS/mTLS）。
- [x] 网关拒绝客户端自带的 `deviceId`、`workspaceId`、`workspaceRoot`，工作区和设备选择保留在中央路由边界；正式 `user_id`/设备证书/允许目录策略仍待接入。
- [x] 网关已实现审批请求路由、accept/reject/timeout、客户端断线拒绝/同用户 rehome，并通过门控 synthetic approval 黑盒验证；真实 App Server 工具审批仍需模型回合专项验证。

### Day 5：隔离、审计和 Go/No-Go

- [x] 使用两名 Spike 用户连接和两个独立 AgentRPC `deviceId` 完成 Thread/Device 隔离；Workspace 仍为单台 Windows 客户端的双设备模拟，跨操作系统实机复验待补。
- [x] 已验证用户 A 无法读取、续聊或操作用户 B 的 Thread；网关按 `userId` 保存进程级 Thread 所有权并支持重连恢复。
- [x] `/audit` 已返回用户、设备、请求 ID、操作状态、审批状态和错误码；验收脚本完成相关性检查。
- [x] 已输出阶段性结论：Spike 条件通过，可进入正式安全/认证设计；生产 Fork 仍 No-Go，需完成 WSS/mTLS、平台账号、持久化租户库、真实双 OS、抓包与许可证/依赖法务核验。

## 4. 硬性退出条件

以下任一条件未满足，结论只能是 No-Go 或“有条件继续 Spike”，不得进入生产 Fork：

- 中央机是唯一 OpenAI 通信方；
- 客户端无 Codex/OpenAI 账号、Token、API Key 和登录态；
- App Server 不对局域网监听，客户端不能取得其地址、凭据或原始本地 Socket；
- 用户、Thread、Device、Workspace 的所有权由服务端重新查询并强制过滤；
- 中央任务能在指定 Windows/macOS 客户端读取文件并执行受控命令；
- 客户端只建立出站连接，默认无需开放 SSH 或其他入站端口；
- 审批、拒绝、取消、超时、掉线、重试和恢复都有明确状态与审计事件；
- Codexia Commit、许可证、依赖和商业再许可边界已归档并通过审查。

## 5. 下一步交付顺序

1. 完成 Day 1 的 Codexia Commit/许可证/构建核验。
2. 同步建立 ADR-001 至 ADR-007：认证、Fork、桌面框架、AgentRPC、数据存储、Shell 策略和双许可证策略。
3. 将当前本地 App Server 模式在配置和文档中保持 `dev-only` 标记，新增生产配置校验，禁止填写本地 App Server 地址作为正式网关地址。
4. Day 2 起再决定是正式 Fork Codexia，还是新建 Tauri 项目后选择性移植 UI 和协议层。
