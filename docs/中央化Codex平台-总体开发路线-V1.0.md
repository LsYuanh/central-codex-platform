# 中央化 Codex 多用户远程工作平台：总体开发路线

> 版本：V1.0  
> 日期：2026-08-31  
> 状态：开发规划稿  
> 依据：《中央化 Codex 多用户远程工作平台需求与架构设计 V0.2》及 GitHub 开源项目调研结论

---

## 1. 路线结论

本项目不从零开发，也不直接部署某一个开源项目。总体采用以下组合路线：

1. **Fork Codexia 作为产品主框架。**复用 Tauri、Rust、React 桌面工程，复用对话、流式事件、审批、diff、终端和 Codex App Server 适配能力。
2. **参考或选择性移植 Soromi 的本地代理与连接架构。**重点复用 Rust Daemon、协议类型生成、设备配对、客户端主动出站连接、断线恢复和密钥吊销思路；不保留其在客户端启动 Codex/Claude CLI 的模式。
3. **以固定版本的 OpenAI Codex App Server Schema 为协议基线。**每次升级 Codex 都重新生成 TypeScript/JSON Schema，并执行兼容性测试。
4. **自研多用户与跨设备安全层。**平台账号、租户隔离、Thread 所有权、Worker Manager、Device Broker、AgentRPC、本地权限沙箱、审批、审计和运维系统必须掌握在本项目中。
5. **先完成纵向闭环，再横向补齐功能。**优先让一个真实请求从桌面客户端进入中央 Codex，并在指定客户端完成文件读取或命令执行；闭环稳定后再增加更多文件、Git、构建和管理能力。
6. **自有代码保留双许可证。**采用 `AGPL-3.0-only OR Commercial License`；第三方代码仍按各自原许可证授权，外部贡献必须满足商业再许可要求。

最终运行链路为：

```text
Windows/macOS Desktop UI
        │ 本地最小权限 IPC
        ▼
Local Rust Agent
        │ 客户端主动建立 mTLS WSS/HTTP2 连接
        ▼
Central Device Broker ── Remote Workspace Bridge
        │                         ▲
        ▼                         │ 强类型工具调用
Conversation Service ── Codex Worker Manager
        │                         │ stdio/Unix Socket
        ▼                         ▼
PostgreSQL / Audit         Codex App Server
                                  │
                                  ▼
                                OpenAI
```

硬性边界：客户端不安装或启动 Codex，不保存 OpenAI 凭据，不直接与 OpenAI/ChatGPT 通信；App Server 不直接暴露到局域网；客户端默认不开放 SSH 或其他入站端口。

---

## 2. 开源项目使用方式

### 2.1 Codexia：主 Fork

复用范围：

- Tauri v2 桌面壳、React/TypeScript 前端及 Rust Command/IPC 结构；
- Thread/Turn/Item 对话模型和流式事件渲染；
- 新建、继续、归档、审批、diff、终端状态等交互；
- Codex App Server JSON-RPC 适配及无头服务相关代码；
- Windows/macOS 构建配置和基础发布流程。

改造原则：

- 将上游仓库配置为 `upstream`，项目 Fork 配置为 `origin`；
- 固定首个采用的 Commit 和 Release，不跟随 `main` 自动更新；
- 尽量在适配层扩展，不直接大面积修改上游 UI 核心；
- 将“启动本地 Codex”“访问本地文件系统”“本地终端”拆成可替换 Provider；
- 客户端构建中彻底关闭本地 Codex 启动和 OpenAI 登录入口；
- 每次同步上游前执行协议、IPC、权限和跨平台回归测试。
- Fork 前固定具体 Commit 并归档对应 LICENSE/NOTICE；Codexia 当前公开许可证信号不一致，必须完成作者确认或法律审查后才能进入商业版本。

### 2.2 Soromi：架构参考和选择性移植

重点评估：

- Rust Daemon 生命周期管理；
- UI 与高权限本地执行进程分离；
- 协议单一事实源以及 Rust/TypeScript 类型生成；
- 出站连接、设备配对、独立设备密钥和撤销；
- Relay/Broker、消息加密、断线重连和无开放端口模式。

不直接复用：

- Electron 桌面壳，因为产品主框架选用 Codexia/Tauri；
- 在客户端启动 Codex、Claude 或其他模型 CLI 的 Provider；
- 与本项目平台账号、Thread 所有权不兼容的账号和会话模型。

移植任何源代码时必须保留 MIT 许可证和版权声明，并在 `THIRD_PARTY_NOTICES.md` 中记录来源 Commit、修改范围和用途。

### 2.3 官方 Codex：协议事实来源

每个支持的 Codex 版本都必须生成并提交：

- App Server TypeScript Schema；
- App Server JSON Schema；
- 生成命令、Codex 版本和 Commit 信息；
- 本项目兼容性测试结果；
- 已知不支持或被网关屏蔽的方法列表。

App Server 与本项目服务只通过本机 `stdio` 或 Unix Socket 通信，不将实验性 App Server WebSocket 直接作为桌面客户端生产入口。

### 2.4 其他项目：只作为参考或测试夹具

- CodexHarbor：参考 App Server 事件处理、审批和远端 UI PoC。
- simple-codex-client：作为 Thread/Turn/审批协议测试夹具。
- PI-Desktop、Juggler、Xum：参考交互和 Host/UI 分层，不作为主 Fork。
- Happy：参考配对和端到端加密同步思路。

### 2.5 本项目双许可证

项目方拥有完整版权的中央服务、桌面客户端、本地 Agent、AgentRPC、策略、管理和审计代码采用：

```text
AGPL-3.0-only OR Commercial License
```

- AGPL-3.0 是开源授权路径，也允许商业使用；使用者必须遵守其分发和网络交互相关义务。
- 商业许可证是替代授权，面向闭源、SaaS、托管、OEM、白标、再分发以及需要商业支持、质保或赔偿条款的客户。
- 商业许可证只授权项目方有权再许可的代码；MIT、Apache-2.0、LGPL 等第三方部分继续保留原始版权和许可证。
- 外部贡献在合并前必须签署 CLA，授予项目方以 AGPL 和商业许可证发布、再许可及维护许可模式的必要权利。
- 商标与代码许可证分离，产品名称、Logo、图标和域名不随 AGPL 自动授权。
- 商业合同、CLA、版权归属和商标政策在正式发布前由知识产权律师审阅。

仓库从创建时即提供：

```text
LICENSES/AGPL-3.0-only.txt
LICENSING.md
COMMERCIAL-LICENSE.md
CLA.md
TRADEMARKS.md
THIRD_PARTY_NOTICES.md
```

自有源文件使用 `SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial`。第三方文件不得机械替换为本项目 SPDX 标识。

---

## 3. 推荐技术基线

| 层级 | 推荐方案 | 说明 |
|---|---|---|
| 桌面 UI | React + TypeScript，沿用 Codexia | 最大化复用对话、diff 和审批 UI |
| 桌面容器 | Tauri v2 | Windows/macOS 双平台，Rust 能与本地代理共享类型和库 |
| 本地执行代理 | Rust 独立进程 | 文件、Git、PTY/进程和系统凭据由独立最小权限进程管理 |
| 中央控制面 | Rust + Axum/Tokio | 与 Codexia/Soromi 技术栈一致，方便复用协议与异步连接代码 |
| 数据库 | PostgreSQL | 保存平台用户、设备、会话映射、任务、审批和审计索引；开发环境可提供容器化实例 |
| 桌面业务 API | HTTPS JSON API + WSS 事件流 | 登录、对话、设备和任务状态 |
| AgentRPC V1 | 强类型 JSON 消息 over mTLS WSS | 易抓包、易调试；保留切换 HTTP/2 的传输抽象 |
| 本地 IPC | Windows Named Pipe / macOS Unix Domain Socket | 只允许同一用户会话和受信任签名应用连接 |
| Codex 连接 | App Server `stdio` 或 Unix Socket | 不直接向局域网暴露 App Server |
| 中央部署 | macOS `launchd` + 本机服务 | 先单中央机；后续再决定容器化或高可用 |
| 密钥保存 | macOS Keychain / Windows Credential Manager 或 DPAPI | 不把设备私钥和令牌存入普通配置文件 |

首版不引入 Kubernetes、复杂微服务、消息队列集群和多中央节点。服务可以按逻辑模块设计，但先以可拆分的模块化单体加独立 Codex Worker、本地 Agent 运行，降低首版运维成本。

---

## 4. 推荐代码仓库结构

建议使用一个主仓库，便于同步修改协议、桌面端、中央端和测试：

```text
central-codex-platform/
├─ apps/
│  ├─ desktop/                  # Codexia Fork 后的 Tauri/React 桌面端
│  └─ admin-console/            # 后续管理界面；首版可并入 desktop
├─ services/
│  ├─ control-plane/            # 登录、RBAC、对话 API、BFF
│  ├─ worker-manager/           # Codex App Server Worker 生命周期
│  ├─ device-broker/            # Agent 长连接、路由、心跳和吊销
│  └─ remote-workspace-bridge/  # Codex 工具调用到 AgentRPC 的转换
├─ crates/
│  ├─ local-agent/              # Windows/macOS 客户端本地执行代理
│  ├─ agentrpc-types/           # AgentRPC 唯一类型定义
│  ├─ local-ipc/                # Named Pipe / Unix Socket
│  ├─ policy-engine/            # 路径、命令和风险策略
│  └─ audit-events/             # 统一审计事件定义
├─ packages/
│  ├─ app-server-schema/        # 固定版本生成的官方 Schema
│  ├─ api-client/               # 桌面 API TypeScript Client
│  └─ ui-components/            # 可复用对话、审批、diff 组件
├─ database/
│  ├─ migrations/
│  └─ seeds/
├─ infra/
│  ├─ macos-central/
│  ├─ signing/
│  └─ monitoring/
├─ tests/
│  ├─ protocol/
│  ├─ e2e/
│  ├─ security/
│  └─ cross-platform/
├─ docs/
│  ├─ adr/
│  ├─ threat-model/
│  └─ runbooks/
├─ LICENSES/
│  └─ AGPL-3.0-only.txt
├─ LICENSING.md
├─ COMMERCIAL-LICENSE.md
├─ CLA.md
├─ TRADEMARKS.md
└─ THIRD_PARTY_NOTICES.md
```

初期允许 `control-plane`、`worker-manager`、`device-broker` 和 `remote-workspace-bridge` 在一个中央服务进程中实现，但模块接口必须独立，避免未来拆分时重新设计协议。

---

## 5. 阶段总览

以下工期是假设 3–4 名开发人员，包括至少一名 Rust/后端、一名前端/桌面、一名全栈或测试工程师，并有兼职安全与运维支持。工期用于路线安排，不是承诺；单人开发通常需要明显更长时间。

| 阶段 | 目标 | 参考工期 | 关键结果 |
|---|---|---:|---|
| 0 | 固定边界、版本和验收口径 | 3–5 天 | 决策记录、威胁模型、测试设备就绪 |
| 1 | 开源项目技术 Spike | 5 个工作日 | Codexia 可改造性和远程执行方案 Go/No-Go |
| 2 | 工程基础和协议基线 | 1–2 周 | 主仓库、CI、Schema、模块骨架 |
| 3 | 中央单用户对话闭环 | 1.5–2 周 | 桌面经中央 App Server 完成对话，只有中央访问 OpenAI |
| 4 | 桌面客户端与本地 Agent | 2 周 | 安装、登录、配对、工作区授权、本地 IPC |
| 5 | Device Broker 与 AgentRPC | 2 周 | 客户端出站长连接、设备路由、心跳和吊销 |
| 6 | 远程工作纵向闭环 | 2–3 周 | Codex 在指定客户端完成读文件、修改、命令和 Git 检查 |
| 7 | 多用户与完整对话管理 | 2 周 | 用户/对话/设备隔离，搜索、归档和删除 |
| 8 | 工具补齐、审批、安全和审计 | 2–3 周 | P0 工具、风险分级、审批闭环和安全测试 |
| 9 | 安装、更新和中央运维 | 2 周 | 签名安装包、更新回滚、监控和备份恢复 |
| 10 | 小范围试点和生产准备 | 2–4 周 | 试点验收、阻断问题清零、发布与运维手册 |

完整串行预计约 16–22 周。阶段 3 之后，桌面 UI、中央服务、本地 Agent 和测试可以部分并行；团队稳定后可把日历周期压缩到约 12–16 周。范围增加、账号模式调整或远程执行方案验证失败会改变估算。

---

## 6. 分阶段开发说明

## 6.1 阶段 0：固定边界与准备环境

### 目标

在写产品代码前消除会导致整体返工的决策不确定性。

### 怎么开发

本阶段以 ADR、威胁建模和可重复开发环境为主，不追求产品功能。所有关键约束写入自动化测试或构建检查，避免只停留在文档中。

### 要开发和准备什么

- 固定首版中央机：macOS 版本、CPU、内存、磁盘和网络地址；
- 固定测试客户端：Windows x64、macOS Apple Silicon，准备至少两名平台测试用户；
- 确认中央 OpenAI/Codex 认证方式、账号授权边界和费用限制；
- 固定 Codex CLI/App Server 版本并生成 Schema；
- 固定 Codexia、Soromi 参考 Commit 和许可证清单；对 Codexia 的 MIT 与 AGPL/商业双许可公开信号差异取得书面结论；
- 确定平台用户数量、预计并发、对话保留期限和工作区规模；
- 确定 V1 禁止项：GUI 自动化、管理员提权、客户端本地 Codex、直接 OpenAI 通信、默认 SSH 入站；
- 编写首版威胁模型和数据流图；
- 定义 P0 验收场景、测试数据和抓包方法；
- 建立 ADR-001 至 ADR-007：认证方式、Fork 方案、桌面框架、AgentRPC、数据存储、Shell 策略和双许可证策略。

### 验证和退出条件

- 核心约束得到书面确认；
- 测试设备和中央机可用；
- Codex 版本、开源 Commit、许可证和验收用例均已固定；
- 账号或合规边界不存在未接受的阻断项。

### 交付物

- ADR、威胁模型、测试矩阵、第三方软件清单、许可证/CLA 草案和 P0 验收表。

---

## 6.2 阶段 1：开源项目技术 Spike

### 目标

用五个工作日证明 Codexia 是否适合作为主 Fork，并选择远程执行的生产方向。

### 怎么开发

只实现最薄的纵向原型，不做正式 UI、美化、完整数据库和兼容处理。每项结论必须来自可运行代码、抓包或源码定位。

### 要开发什么

1. 在中央 macOS、Windows 和 macOS 客户端分别构建 Codexia，记录依赖和打包问题。
2. 标出 Codexia 中 App Server Adapter、Thread Store、事件归一化、审批 UI、文件、Git 和终端模块的边界。
3. 改造桌面端，使其能够调用一个中央测试网关，而不是在本机启动 Codex。
4. 启动中央 Codex App Server，通过 `stdio` 完成 `initialize`、`thread/start`、`turn/start`、流式事件和 `turn/interrupt`。
5. 从 Soromi 构建最小 Rust Daemon，保留出站连接、心跳和请求/响应框架，删除本地 Codex Provider。
6. 实现最小 `read_file` 和受控 `exec`，由中央测试 Broker 调用客户端 Daemon。
7. 对比两种远程工作实现：
   - 路线 A：官方实验性 Remote Code Mode Host；
   - 路线 B：本项目 AgentRPC + Remote Workspace Bridge/MCP 工具。
8. 验证 Remote Code Mode Host 的限制：同一 App Server 进程所有 Thread 共享一个 Host、远程 WebSocket 属于实验能力且当前不支持生产；判断是否只能作为测试或未来优化。
9. 抓包确认客户端未访问 OpenAI/ChatGPT，也未保存中央 Codex 登录态。

### 选择标准

默认生产路线为 AgentRPC + Remote Workspace Bridge。只有当 Remote Code Mode Host 在固定版本中满足生产支持、每用户/设备隔离、客户端主动出站和审计要求时，才允许通过 ADR 切换。

### 验证和退出条件

- Windows/macOS 客户端均能启动 PoC；
- 一个桌面请求可经中央 Codex 返回流式答案；
- 一个中央请求可在指定客户端执行 `read_file` 或安全测试命令；
- 客户端没有 OpenAI 网络流量和凭据；
- 形成 Codexia 改造清单、可复用代码清单和 Go/No-Go 结论。

### 失败回退

若 Codexia 核心模块耦合过高，则新建 Tauri 项目，选择性移植其 UI 和 App Server 事件处理；不因保留 Fork 而破坏中央独占通信和本地最小权限边界。

---

## 6.3 阶段 2：工程基础和协议基线

### 目标

建立可持续开发、测试、升级和追踪第三方变更的工程骨架。

### 怎么开发

采用 Monorepo、Schema First 和 Contract Test。所有跨进程消息先定义类型和状态机，再写业务处理代码。

### 要开发什么

- 创建主仓库和目录结构；
- 建立 Codexia Fork、上游同步说明和补丁分层；
- 引入固定版本 App Server Schema 生成脚本；
- 定义 Desktop API、Event Stream、AgentRPC 和 Local IPC V1；
- 定义统一错误码、请求 ID、Trace ID、幂等键和版本协商；
- 建立 PostgreSQL Migration 框架；
- 建立中央服务、桌面端和 Local Agent 的配置加载方式；
- 建立 Windows/macOS/中央 macOS CI 构建；
- 添加格式化、Lint、单元测试、依赖许可证和敏感信息扫描；
- 建立第三方 NOTICE、SBOM 和依赖锁定；
- 建立 AGPL/商业双许可文件、CLA、商标政策、源文件 SPDX 规则和贡献检查；
- 提供一键开发环境启动和假 App Server/Fake Agent。

### 验证和退出条件

- 一次提交能触发中央、桌面和 Agent 构建；
- Rust/TypeScript 协议类型来自同一个 Schema；
- Fake Agent 和 Fake App Server 能运行协议测试；
- 不兼容 Schema 变更会使 CI 明确失败。

### 交付物

- 可构建主仓库、CI、Schema 包、数据库基线、开发手册、双许可基础文件和第三方 NOTICE。

---

## 6.4 阶段 3：中央单用户对话闭环

### 目标

先完成不涉及客户端文件操作的中央对话闭环，验证 App Server 的稳定托管方式。

### 怎么开发

从 Codexia 中保留 UI 和事件模型，把 App Server 进程托管移动到中央 Worker Manager。桌面端只调用平台 API，不感知 App Server 的真实地址和凭据。

### 要开发什么

- TLS 接入层和 Desktop Gateway/BFF；
- 临时单用户登录，仅用于阶段内测试；
- Codex Worker Manager：启动、初始化、健康检查、重启、退出和日志；
- App Server Adapter：请求 ID 映射、超时、取消、Schema 验证和事件归一化；
- Conversation Service：内部 Conversation ID 与 Codex Thread ID 映射；
- Thread 新建、列表、读取、继续、归档和中断；
- WSS/SSE 流式事件转发及断线后重连；
- 对话和任务最小数据库表；
- 中央 Codex/OpenAI 凭据只由 Worker 启动环境读取；
- 屏蔽 `thread/shellCommand` 等不允许普通客户端调用的方法；
- 中央日志和基础指标。

### 验证和退出条件

- 客户端可以新建、继续和中断一段真实 Codex 对话；
- 流式文本和任务状态不乱序、不重复；
- App Server 崩溃后平台能报告故障并恢复新任务；
- 浏览器/桌面客户端无法取得 App Server Token、OpenAI Token 或原始本地 Socket；
- 抓包确认只有中央机连接 OpenAI。

### 交付物

- 单用户中央对话 Alpha、Worker 运行手册和 App Server 兼容性测试。

---

## 6.5 阶段 4：桌面客户端与本地 Agent

### 目标

形成可安装的 Windows/macOS 桌面应用，并建立安全的本地执行边界。

### 怎么开发

桌面 UI 和 Local Agent 分进程。UI 负责交互，Agent 负责文件、Git 和进程；UI 不直接获得任意系统 Shell 权限。

### 要开发什么

桌面 UI：

- 登录、退出和会话过期处理；
- 对话列表、消息流、任务状态、断线和错误界面；
- 设备配对引导和工作区目录选择器；
- 本机 Agent 状态、版本和日志导出；
- 客户端不显示 OpenAI 登录、API Key 或本地 Codex 设置。

Local Agent：

- Rust 独立进程和 Tauri 生命周期管理；
- Windows Named Pipe、macOS Unix Domain Socket；
- IPC 调用者校验和协议版本协商；
- macOS Keychain、Windows Credential Manager/DPAPI 存储设备私钥；
- 工作区授权记录、规范化路径和文件系统标识；
- Agent 自检、健康状态、日志脱敏和安全退出；
- 首版不安装特权 Service、LaunchDaemon 或管理员 Helper。

### 验证和退出条件

- Windows/macOS 均可安装、启动、登录和卸载；
- UI 不能绕过 Agent 直接访问任意文件或命令；
- 非同一用户会话或非授权进程无法连接本地 IPC；
- 客户端磁盘中不存在 OpenAI/Codex 凭据；
- 工作区必须经系统目录选择器授权。

### 交付物

- Windows/macOS 内测安装包、Local Agent、IPC 安全测试和安装说明。

---

## 6.6 阶段 5：Device Broker 与 AgentRPC

### 目标

建立中央机与多台客户端之间可认证、可路由、可撤销、可恢复的双向执行通道。

### 怎么开发

V1 使用强类型 JSON over mTLS WSS。连接始终由客户端主动建立，中央 Broker 不主动连接客户端，不依赖客户端开放 22 端口。

### 要开发什么

- 一次性配对码、设备注册和证书签发；
- 每设备独立密钥、证书轮换、吊销和重新配对；
- Agent 出站连接、指数退避、心跳和离线检测；
- Broker 连接注册表：`user_id + device_id + session_id`；
- AgentRPC Envelope：版本、请求 ID、任务 ID、时间戳、Nonce 和 Trace ID；
- 请求/响应、流式输出、取消、超时和最大消息限制；
- 重放保护、幂等、过期请求拒绝和协议降级拒绝；
- 设备在线状态和客户端版本策略；
- Broker 指标、限流和结构化日志；
- Fake Agent 压测和网络故障注入。

### 验证和退出条件

- 两名用户、两台客户端同时在线时，消息只路由到绑定设备；
- 设备吊销后旧连接立即失效且不能重连；
- 客户端换网、休眠、重启后可以安全恢复；
- 重复、过期、乱序和伪造请求会被拒绝；
- 局域网防火墙无需为客户端增加入站规则。

### 交付物

- Device Broker、AgentRPC V1、配对/吊销流程和网络故障测试报告。

---

## 6.7 阶段 6：远程工作纵向闭环

### 目标

让中央 Codex 真正作用于客户端工作目录，完成第一个可用版本的核心价值。

### 怎么开发

在中央实现 Remote Workspace Bridge。Codex 只能看到强类型远程工具；设备和工作区绑定由服务端根据 Thread 所有权注入，模型和桌面客户端不能自行指定任意 `device_id` 或根目录。

### 要开发什么

首批 AgentRPC 工具：

- `workspace/list`、`workspace/stat`；
- `fs/list_dir`、`fs/read_file`、`fs/search`；
- `fs/apply_patch`，支持预览、原子写入和冲突检测；
- `process/exec`，使用参数数组而不是拼接 Shell 字符串；
- `process/cancel`、输出流和退出码；
- `git/status`、`git/diff`。

中央桥接：

- 远程工具 Schema 和 Codex 工具注册；
- Thread 到用户、设备、工作区的服务端绑定；
- 工具调用到 AgentRPC 的转换；
- 工具结果大小限制、分页、截断和文件编码处理；
- 客户端离线、超时、取消和重试语义；
- 所有调用写入统一任务状态机和审计事件；
- 禁止把 `thread/shellCommand` 当成客户端执行通道。

客户端 Agent：

- Windows/macOS 路径规范化；
- 阻止 `..`、符号链接、Junction 和大小写差异导致的根目录逃逸；
- 文件读写冲突、临时文件、原子替换和回滚；
- 进程树追踪、超时、取消和子进程清理；
- 环境变量最小化和敏感变量过滤。

### 验证和退出条件

- 用户发送“分析这个项目并运行测试”后，读取和命令实际发生在指定客户端；
- 修改前显示 diff，批准后文件原子写入；
- 任务不能访问授权根目录以外的路径；
- 切换设备或工作区必须显式操作，不能由模型擅自完成；
- 断线时任务进入明确状态，重连后不会重复执行副作用操作；
- 中央机不会误把自己的文件系统当作客户端工作区。

### 交付物

- 单用户 Remote Workspace MVP、跨平台 E2E 测试和演示脚本。

---

## 6.8 阶段 7：多用户与完整对话管理

### 目标

把单用户 MVP 变成真正的多用户平台，确保每人只能看到和操作自己的对话、设备和工作区。

### 怎么开发

所有对象都以平台用户作为所有权根。客户端提交的 Thread ID、Device ID 和 Workspace ID 不直接可信，服务端必须重新查询并验证所有权。

### 要开发什么

- 本地平台账号、密码策略、Argon2id 哈希、登录限流和安全 Session；
- 管理员、普通用户和只读审计角色；
- 用户启用、停用、密码重置和会话撤销；
- 用户与 Codex Worker/`CODEX_HOME` 隔离模型；
- Conversation、Thread、Turn、Device、Workspace 和 Task 所有权；
- 对话新建、重命名、搜索、置顶、归档、恢复和删除；
- 设备列表、解绑、工作区新增/移除和默认工作区；
- 每用户并发、队列和资源配额；
- 管理员只看元数据，默认不直接读取用户对话内容；
- 数据库唯一约束、外键和必要的 Row-Level Security 或等效服务端强制过滤；
- 跨租户负向测试套件。

### 验证和退出条件

- 用户 A 无法通过修改 URL、JSON、WebSocket 消息或重放请求访问用户 B 数据；
- 用户 A 的任务不能发送到用户 B 的设备；
- 用户停用后，平台 Session、设备连接和进行中任务均按策略终止；
- 两名用户可以并发流式对话，事件不会串线；
- 删除、归档和恢复语义与 Codex Thread 状态一致。

### 交付物

- 多用户 Beta、权限矩阵、数据迁移和跨租户安全测试报告。

---

## 6.9 阶段 8：工具补齐、审批、安全和审计

### 目标

补齐真实开发工作需要的工具，并把远程执行控制在可理解、可确认、可追踪的安全边界内。

### 怎么开发

先设计风险等级，再增加工具。任何新工具必须同时实现 Schema、权限策略、审批 UI、审计事件、超时取消和跨平台测试，不能只增加执行代码。

### 要开发什么

扩展工具：

- 文件创建、移动、复制和删除；
- Git 分支、暂存和提交；V1 默认不开放强制推送；
- 构建、测试、包管理器和受控后台进程；
- 大文件、二进制文件和长输出处理；
- 按需增加只读系统信息，不增加 GUI 自动化。

审批系统：

- 只读、写入、执行、高风险四级策略；
- 显示目标设备、工作区、路径、命令、参数、风险和预计影响；
- 单次允许、会话级允许、拒绝和管理员策略禁用；
- 删除、依赖安装、服务控制、网络访问等二次确认；
- 审批超时、取消、重复请求合并和状态恢复；
- App Server 审批与 AgentRPC 本地审批形成一致状态机。

审计与安全：

- 登录、配对、设备吊销、对话、工具调用、审批和管理员操作事件；
- 日志脱敏、完整性校验、留存和导出；
- `thread/shellCommand` 只作为受控管理员维护能力，首版隔离不达标则保持关闭；
- Prompt Injection、路径逃逸、命令注入、IPC 越权、跨租户和协议降级测试；
- 依赖漏洞、SBOM、安装包和更新链路扫描；
- MFA 和管理员高风险操作再认证。

### 验证和退出条件

- P0 工具全部完成风险分类和审批；
- 高风险操作无法通过改写参数、编码、符号链接或重放绕过；
- 每次执行可从用户请求追踪到 Codex Turn、审批、Agent 请求和最终结果；
- 阻断级安全问题为零；
- 安全测试回归进入 CI。

### 交付物

- Feature Complete 候选版、审批策略、威胁模型 V2、审计说明和安全测试报告。

---

## 6.10 阶段 9：安装、更新和中央运维

### 目标

让系统可以重复安装、安全升级、监控和恢复，而不是只能在开发电脑上运行。

### 怎么开发

把发布、签名、备份和回滚作为产品功能开发，并在与生产相同的中央 macOS 环境演练。

### 要开发什么

桌面发布：

- Windows 安装包、代码签名和卸载清理；
- macOS Universal 或目标架构 DMG、签名和 Notarization；
- 自动更新、更新签名、灰度通道、最低版本和回滚；
- Agent 与 UI 版本兼容矩阵；
- 设备解绑和本地凭据安全删除。

中央运维：

- `launchd` 服务、自启动、健康检查和依赖顺序；
- 数据库备份、会话数据备份和恢复；
- Codex Worker 卡死检测、资源限制和自动恢复；
- 指标：在线设备、活跃用户、任务延迟、失败率、队列、Worker 和磁盘；
- 告警、日志轮换、容量水位和费用监控；
- 证书轮换、用户停用、设备退役和应急处理；
- Codex 升级前的 Schema Diff、兼容测试和回滚；
- 中央机故障恢复与重新配对策略。

### 验证和退出条件

- Windows/macOS 安装、升级、降级、回滚和卸载通过；
- 篡改的更新包无法安装；
- 从空白中央机可按 Runbook 恢复数据库、配置和服务；
- Worker、Broker 或数据库异常会产生明确告警；
- Codex 升级失败可以恢复到上一固定版本。

### 交付物

- Release Candidate、签名安装包、部署脚本、监控面板、备份恢复和升级回滚手册。

---

## 6.11 阶段 10：小范围试点和生产准备

### 目标

在少量真实用户和真实项目中发现性能、兼容性、权限和交互问题，达到生产发布门槛。

### 怎么开发

先选择 2–5 名用户、Windows/macOS 各至少一台设备和可恢复的非关键项目。按周迭代，不在试点期间无计划扩大权限或加入 GUI 自动化。

### 要开发和执行什么

- 首次安装、登录、配对和目录授权可用性测试；
- 新建、续聊、搜索、归档、删除和跨设备切换；
- 文件修改、测试命令、Git diff、审批和任务取消；
- 休眠、换网、中央重启、客户端升级和设备吊销；
- 记录失败类型、用户等待时间、审批频率和资源占用；
- 调整默认策略、错误提示、超时、并发和日志；
- 完成管理员、用户和应急运维手册；
- 完成发布清单、支持流程和已知限制。

### 验证和退出条件

- P0 验收用例全部通过；
- 阻断级和高危安全问题清零；
- 无跨用户数据或事件串线；
- 客户端无 OpenAI 网络流量和凭据；
- 备份恢复、证书吊销、升级回滚和 Codex 版本回退演练通过；
- 负责人签署 Go-Live 清单。

### 交付物

- V1.0、试点报告、生产部署包、用户手册、管理员手册和运维 Runbook。

---

## 7. 并行开发安排

阶段 0–2 应由全员共同完成。阶段 3 之后可以按以下工作流并行：

| 工作流 | 主要职责 | 前置依赖 |
|---|---|---|
| 桌面 UI | Codexia 改造、对话、设备、审批、diff 和安装体验 | Desktop API 和事件 Schema |
| 中央控制面 | 身份、Conversation、Worker、RBAC、数据库和运维 | App Server Schema |
| Local Agent | IPC、工作区、文件、进程、Git 和本机密钥 | AgentRPC Schema |
| Device Broker/Bridge | 长连接、路由、工具转换、状态机和审计 | AgentRPC、任务模型 |
| QA/安全 | Fake Server/Agent、跨平台 E2E、越权、路径和网络验证 | 每阶段可测试构建 |

建议每周合并一次可运行的纵向版本，避免几个团队各自开发数周后才进行第一次联调。

---

## 8. 功能优先级

### P0：没有这些能力不能进入试点

- 平台登录、退出、会话撤销；
- 设备配对、在线状态、吊销和重新配对；
- 工作区授权和目录边界；
- 对话新建、列表、继续、重命名、归档、删除和中断；
- 流式消息、任务状态和错误恢复；
- `read_file`、`list_dir`、`search`、`apply_patch`、`exec`、`cancel`、`git status/diff`；
- 审批、diff、风险提示和审计；
- Windows/macOS 安装、更新和回滚；
- 多用户隔离、抓包验证和备份恢复。

### P1：试点稳定后增加

- Git 分支、暂存和提交；
- 构建/测试模板和受控后台进程；
- 管理员仪表盘、配额和更完整搜索；
- OIDC/LDAP、MFA 策略细化；
- 一位用户绑定多台设备的高级路由；
- 审计导出和更长周期指标。

### P2：V1 不做或单独立项

- GUI/鼠标键盘自动化；
- 管理员提权、系统服务修改和驱动安装；
- 客户端开放 SSH Server；
- 无审批软件安装、任意网络访问和 Git 强制推送；
- 多中央节点、高可用集群和公网服务；
- 移动端客户端。

---

## 9. 每阶段统一完成标准

任何阶段只有同时满足以下条件才可结束：

- 功能代码、Schema、Migration 和配置已进入主分支；
- 单元测试、协议测试和相应 E2E 测试通过；
- 新增权限和攻击面已更新威胁模型；
- 日志中不包含密码、Token、设备私钥和文件敏感正文；
- Windows/macOS 或中央 macOS 的适用构建通过；
- 文档、运行方式、失败恢复和已知限制已更新；
- 没有未说明的高危安全问题；
- 上一阶段的退出条件有可复核证据，而不是口头确认。

---

## 10. 关键风险和暂停条件

遇到以下情况应暂停扩大开发范围，先完成决策或技术验证：

1. 中央账号授权方式不能覆盖计划中的多用户使用方式。
2. Codexia 无法稳定拆分本地 Codex 与桌面 UI，未能确认目标 Commit 的许可证，或上游许可证发生不兼容变化。
3. App Server 固定版本缺少关键 Thread/Turn/审批能力，或 Schema 频繁发生破坏性变化。
4. 远程执行不能可靠绑定到指定用户、设备和工作区。
5. Local Agent 无法在不使用管理员权限的情况下完成 P0 能力。
6. 客户端仍存在 OpenAI 直接流量或可读取中央凭据。
7. 路径逃逸、跨租户访问、设备冒用或更新包篡改测试无法通过。
8. 为满足功能被迫开放 App Server、SSH 或客户端通用 Shell 到局域网。

这些情况不能通过降低安全标准直接绕过，应形成 ADR、替代方案和新的验收条件后再继续。

---

## 11. 开发启动后的前十个工作日

### 第 1–2 天

- 固定 Codex/Codexia/Soromi 版本和 Commit；
- 创建主仓库、双许可文件、CLA、商标政策、第三方 NOTICE 和 ADR 目录；
- 中央、Windows、macOS 开发环境就绪。

### 第 3–5 天

- 构建 Codexia；
- 定位 App Server、对话、审批、文件和终端模块；
- 生成官方 App Server Schema；
- 完成中央 `stdio` App Server 最小客户端。

### 第 6–8 天

- 桌面 UI 改连中央测试网关；
- 构建最小 Rust Local Agent；
- 建立出站 WSS 和 `read_file`/测试 `exec`。

### 第 9–10 天

- Windows/macOS 实机联调；
- 对比 Remote Code Mode Host 与 AgentRPC Bridge；
- 抓包、权限和故障测试；
- 形成 Go/No-Go、正式模块拆分和修订工期。

第十个工作日结束时，必须能够回答三个问题：Codexia 是否继续作为主 Fork、远程执行采用哪条生产路线、从 MVP 到试点需要多少实际工作量。

---

## 12. 最终交付清单

产品代码：

- 中央控制面、Worker Manager、Device Broker 和 Remote Workspace Bridge；
- Windows/macOS Tauri 桌面应用；
- Windows/macOS Rust Local Agent；
- PostgreSQL Schema/Migration；
- App Server Schema、Desktop API、AgentRPC 和 IPC 协议包。

测试和安全：

- Fake App Server、Fake Agent、协议兼容和网络故障测试；
- Windows/macOS E2E；
- 跨租户、路径逃逸、命令注入、IPC、凭据和更新安全测试；
- SBOM、第三方许可证和安全测试报告。
- AGPL 开源发布材料、商业许可模板、CLA 记录和商标使用规则。

发布和运维：

- Windows/macOS 签名安装包；
- 自动更新、灰度、最低版本和回滚；
- 中央 macOS 部署、自启动、监控、告警和日志；
- 数据、配置和会话备份恢复；
- 用户、管理员、发布、升级和应急 Runbook。

---

## 13. 当前推荐的第一步

不要立即全面 Fork 并开始补功能。先正式执行“阶段 0 + 阶段 1”：固定版本和验收口径，在五个工作日内完成 Codexia/Soromi/官方 App Server 的纵向 Spike。

Spike 通过后，按阶段 2 建立正式仓库和协议基线；随后严格按“中央对话闭环 → 桌面与 Local Agent → Device Broker → 远程工作闭环 → 多用户隔离 → 审批安全 → 发布运维”的顺序推进。这个顺序优先消除架构风险，避免先做大量 UI 后才发现远程执行、账号隔离或 App Server 托管方式不可行。

---

## 14. 参考项目与官方资料

- [Codexia](https://github.com/milisp/codexia)
- [Soromi](https://github.com/soromi/soromi)
- [OpenAI Codex](https://github.com/openai/codex)
- [CodexHarbor](https://github.com/adondada/codexharbor)
- [simple-codex-client](https://github.com/bebebebebebebebebebebebebebebe/simple-codex-client)
- [OpenAI Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)

官方当前说明 Remote Code Mode Host 和 App Server WebSocket 传输属于实验能力，且不支持生产工作负载。因此路线将它作为 Spike 候选和未来优化方向，而不是 V1 生产依赖。
