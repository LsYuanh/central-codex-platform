<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# 中央化 Codex 平台：技术选型与开发环境

> 版本：V1.0  
> 日期：2026-08-31  
> 状态：阶段 0–1 技术基线  
> 适用范围：中央 macOS、Windows/macOS 桌面客户端、开发与测试环境

---

## 1. 文档目的

本文集中说明本项目当前的技术选型、开发机器要求、工具链准备方式、版本锁定原则和环境验收标准，作为后续技术 Spike、工程初始化和新成员开发环境配置的依据。

本文与以下文档配套使用：

- [需求与架构设计 V0.2](./中央化Codex多用户远程工作平台-需求与架构设计-V0.2.md)
- [总体开发路线 V1.0](./中央化Codex平台-总体开发路线-V1.0.md)

本文不表示所有具体版本已经确定。当前项目仍处于阶段 0–1，在 Codexia、Soromi 和 Codex App Server 技术 Spike 给出 Go/No-Go 结论前，不初始化正式生产工程，也不引入生产依赖。

---

## 2. 当前状态结论

### 2.1 已确定的方向

- 桌面客户端采用 Tauri v2、React 和 TypeScript。
- 客户端本地执行代理采用 Rust 独立进程。
- 中央控制面优先采用 Rust、Axum 和 Tokio。
- 试点和生产数据使用 PostgreSQL。
- 桌面端与中央端通过 HTTPS JSON API 和 WSS 事件流通信。
- 客户端只主动向中央端建立连接，默认不开放 SSH 或其他入站端口。
- 跨设备执行使用强类型 AgentRPC，V1 采用 JSON over mTLS WSS，并保留 HTTP/2 传输抽象。
- 中央端通过本机 `stdio` 或 Unix Domain Socket 连接 Codex App Server。
- 中央服务首版采用模块化单体加独立 Codex Worker，不引入 Kubernetes 和复杂消息队列集群。
- 自有代码采用 `AGPL-3.0-only OR Commercial License` 双许可证。

### 2.2 有条件采用的方向

- Codexia 在许可证核验和技术 Spike 通过后作为桌面产品主 Fork。
- Soromi 只作为 Rust Daemon、设备配对、客户端出站连接、断线恢复和密钥吊销的参考或选择性代码来源。
- 官方 Codex App Server 只有在固定版本完成协议、稳定性和生产边界验证后，才能成为正式运行依赖。

### 2.3 尚未锁定的内容

- Codex CLI/App Server 精确版本和 Commit。
- Codexia、Soromi 的具体 Commit 和依赖版本。
- Rust、Node.js 和前端包管理器精确版本。
- Windows/macOS 最低系统版本和其他 CPU 架构支持范围。
- 中央 macOS 的具体机型、CPU、内存、磁盘和容量上限。
- Codex Worker 按用户、按任务或其他方式隔离的最终实现。
- 平台认证方式、MFA、并发用户数和费用限制。
- 中央服务是否容器化；V1 默认优先使用 `launchd` 和本机服务。

---

## 3. 技术架构基线

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

硬性边界：

- 只有中央 macOS 安装并运行 Codex，保存 OpenAI/ChatGPT 凭据并访问 OpenAI。
- Windows/macOS 客户端不安装 Codex、不保存 OpenAI 凭据、不直接访问 OpenAI。
- Codex 在中央机推理；文件、Git、构建、测试和命令在用户指定客户端的 Local Agent 中执行。
- App Server 不直接暴露到局域网，桌面端不透传 App Server JSON-RPC。
- UI 不直接获得文件系统和 Shell 的完整权限，系统操作由独立 Local Agent 按策略执行。

---

## 4. 技术选型明细

| 层级 | 当前方案 | 用途和说明 | 状态 |
|---|---|---|---|
| 桌面 UI | React + TypeScript | 对话、任务状态、审批、diff、终端输出和设备管理 | 已确定 |
| 桌面容器 | Tauri v2 | Windows/macOS 桌面壳、Rust Command 和本地 IPC | 已确定 |
| 桌面产品基础 | Codexia Fork | 复用对话、事件、审批、diff 和打包基础 | Spike/许可证通过后采用 |
| 客户端执行代理 | Rust 独立进程 | 文件、Git、PTY、进程、凭据和工作区权限 | 已确定 |
| 中央控制面 | Rust + Axum + Tokio | 登录、RBAC、对话 API、Worker、Broker 和 Bridge | 已确定 |
| 数据库 | PostgreSQL | 用户、设备、会话映射、任务、审批和审计索引 | 已确定 |
| 开发数据库 | SQLite（PoC 默认），PostgreSQL（多人/集成测试） | 本地纵向 Spike 使用仓库内 SQLite 文件；多人长期运行和生产仍使用 PostgreSQL | 已确定 |
| 桌面业务 API | HTTPS JSON API | 登录、对话、设备和管理请求 | 已确定 |
| 事件传输 | WSS 事件流 | 对话流式输出、任务、审批和设备状态 | 已确定 |
| AgentRPC V1 | 强类型 JSON over mTLS WSS | 客户端主动连接、路由、审批和流式执行 | 已确定 |
| AgentRPC 后续传输 | HTTP/2 | 通过传输抽象保留切换能力 | 预留 |
| Windows 本地 IPC | Named Pipe | UI 与同一用户会话中的 Local Agent 通信 | 已确定 |
| macOS 本地 IPC | Unix Domain Socket | UI 与同一用户会话中的 Local Agent 通信 | 已确定 |
| Codex 接入 | 固定版本 App Server | Thread、Turn、Item、审批和流式事件 | Spike 后锁定 |
| App Server 传输 | 本机 `stdio` 或 Unix Socket | 不对局域网暴露实验性传输 | 已确定 |
| 中央服务管理 | macOS `launchd` | 自启动、崩溃重启、依赖顺序和日志 | 已确定 |
| macOS 密钥 | Keychain | 中央凭据、设备密钥和令牌 | 已确定 |
| Windows 密钥 | Credential Manager/DPAPI | 设备私钥和本地令牌 | 已确定 |
| 源码许可证 | AGPL-3.0-only OR Commercial License | 保留开源和闭源商业授权路径 | 已确定 |

### 4.1 首版中央服务形态

首版中央服务允许以一个 Rust 进程实现以下逻辑模块，但模块接口和数据所有权必须分离：

- Control Plane：身份、RBAC、对话 API 和管理员能力。
- Conversation Service：平台 Conversation 与 Codex Thread 的映射。
- Worker Manager：Codex App Server 生命周期、健康检查和隔离。
- Device Broker：设备长连接、心跳、路由、版本和吊销。
- Remote Workspace Bridge：把 Codex 工具请求转换为 AgentRPC。
- Audit：统一审计事件、脱敏和检索索引。

### 4.2 不采用的主方案

- 不让用户通过终端 SSH 登录中央机使用 Codex CLI。
- 不在客户端安装 Codex 或保存中央账号。
- 不在客户端开放系统 SSH Server 或嵌入式通用 SSH Server 作为默认链路。
- 不把 App Server WebSocket 直接暴露给桌面客户端。
- 不让 Codex 通过裸 `ssh client 'command'` 执行生产任务。
- 首版不使用 Kubernetes、多中央节点和复杂消息队列集群。

---

## 5. 开发和测试机器矩阵

至少准备三类实机环境：

| 角色 | 必需系统 | 主要用途 | 是否安装 Codex |
|---|---|---|---|
| 中央开发/测试机 | macOS，首选 Apple Silicon | Codex/App Server、中央服务、PostgreSQL、Keychain 和 `launchd` | 是 |
| Windows 客户端开发机 | Windows x64 | Tauri 桌面端、Local Agent、Named Pipe、DPAPI 和安装包测试 | 否 |
| macOS 客户端开发机 | macOS Apple Silicon | Tauri 桌面端、Local Agent、Unix Socket、Keychain 和安装包测试 | 否 |

技术 Spike 至少使用两名平台测试用户，并各绑定一台客户端，以验证用户、对话、设备和工作区隔离。

推荐为 CI 准备以下原生 Runner：

- macOS Apple Silicon Runner：Rust 中央服务、macOS 客户端和集成测试。
- Windows x64 Runner：Windows 客户端、MSI/NSIS 和跨平台测试。
- PostgreSQL 服务容器：Migration、协议和后端集成测试。

---

## 6. 公共开发环境

所有开发机器建议安装：

| 工具 | 用途 | 当前版本策略 |
|---|---|---|
| Git | 源码管理 | 使用受支持稳定版 |
| OpenSSH Client | 通过 SSH 访问 GitHub | 使用系统版本 |
| Rustup | Rust 工具链管理 | 安装后由仓库锁定 toolchain |
| Cargo | Rust 构建和测试 | 跟随锁定的 Rust toolchain |
| rustfmt | Rust 格式化 | 跟随锁定的 Rust toolchain |
| Clippy | Rust Lint | 跟随锁定的 Rust toolchain |
| Node.js | React/TypeScript 构建 | 使用 LTS，工程初始化时锁定具体版本 |
| Corepack | 前端包管理器管理 | 工程初始化时启用 |
| SQLite | 单机 PoC 数据库 | 使用 Node.js 24 `node:sqlite`，无需单独服务 |
| PostgreSQL | 多人/集成测试数据库 | 需要时锁定主版本 |
| Docker Desktop、OrbStack 或本机 PostgreSQL | PostgreSQL 本地运行方式 | 需要 PostgreSQL 时三选一 |
| IDE | Rust/TypeScript 开发 | VS Code、RustRover/WebStorm 等均可 |

当前 GitHub 远程仓库使用 SSH：

```text
git@github.com:LsYuanh/central-codex-platform.git
```

当前阶段不要求每台机器安装所有基础设施。Windows/macOS 客户端开发机只需运行桌面端、Local Agent、Fake Gateway/Fake App Server 和测试数据库客户端；真实 Codex 始终只在中央 macOS 运行。

---

## 7. Windows 开发环境

### 7.1 必需组件

- Windows 10/11 x64；最终最低版本由 Spike 决定。
- Microsoft C++ Build Tools。
- Visual Studio Installer 中的 `Desktop development with C++` 工作负载。
- Windows SDK。
- Microsoft Edge WebView2 Runtime。
- Rust MSVC 工具链，目标为 `x86_64-pc-windows-msvc`。
- Node.js LTS 和 Corepack。
- Git 和 OpenSSH Client。
- Windows Credential Manager/DPAPI 可用。

如果需要构建 MSI，还必须验证 MSI 工具链以及系统 VBSCRIPT 可选组件。也可以评估 NSIS，但最终安装包格式应通过 ADR 固定。

### 7.2 Windows 特有测试

- Named Pipe 仅允许同一用户会话和受信任应用连接。
- DPAPI 数据不能被其他 Windows 用户解密。
- Windows 盘符、UNC 路径、反斜杠、大小写和 `..` 不得绕过工作区限制。
- PowerShell 命令参数必须结构化传递，不能通过字符串拼接扩大权限。
- 安装、升级、回滚和卸载不能遗留长期凭据或高权限服务。

---

## 8. macOS 客户端开发环境

### 8.1 必需组件

- macOS Apple Silicon；最终最低版本由 Spike 决定。
- Xcode Command Line Tools；普通桌面编译通常不要求完整 Xcode。
- Rust Apple Silicon 工具链。
- Node.js LTS 和 Corepack。
- Git 和 OpenSSH Client。
- macOS Keychain 可用。
- LaunchAgent 测试环境。

发布阶段还需要：

- 完整 Xcode。
- Apple Developer Program 账号。
- Developer ID Application 证书。
- Hardened Runtime、签名、公证和 DMG 构建配置。
- 自动更新包签名和回滚验证环境。

### 8.2 macOS 特有测试

- Unix Domain Socket 的路径、文件权限和调用者身份校验。
- Keychain 项目访问控制和用户隔离。
- 符号链接、挂载点和大小写敏感/不敏感卷不得绕过工作区边界。
- LaunchAgent 登录启动、异常重启和卸载清理。
- 系统隐私权限提示不能造成静默扩大授权。

---

## 9. 中央 macOS 开发与运行环境

中央机既是开发/测试基础设施，也是未来首版生产运行节点，需要安装：

- 固定版本 macOS，首选 Apple Silicon。
- Git、OpenSSH Client 和 Xcode Command Line Tools。
- Rust toolchain，用于中央服务构建。
- 固定版本 Codex CLI/App Server。
- 中央 OpenAI/ChatGPT 登录凭据或经确认的其他认证方式。
- PostgreSQL。
- macOS Keychain。
- `launchd` 服务定义和日志归集能力。
- TLS 证书、固定局域网地址或稳定主机名。
- 监控、备份和恢复所需磁盘空间。

只有中央机可以持有：

- Codex 登录态和配置目录。
- OpenAI/ChatGPT 账号凭据。
- App Server Worker 数据。
- 中央 TLS 私钥和内部签发凭据。
- 数据库管理凭据和备份密钥。

开发时也不能为了方便把以上内容复制到 Windows/macOS 客户端测试机。

### 9.1 中央服务进程

首版预计运行：

```text
central-control-plane
codex-worker-manager
codex app-server worker(s)
postgresql
monitoring/logging helper(s)
```

Control Plane、Worker Manager、Device Broker 和 Bridge 初期可以编译进同一中央二进制；Codex App Server Worker 保持独立进程并接受生命周期监督。

---

## 10. 版本和依赖锁定

### 10.1 锁定原则

- 不在生产中使用 `latest`、跟随 `main` 或无锁文件依赖。
- 技术 Spike 完成后固定 Codex、Codexia 和 Soromi 的版本或 Commit。
- Codex 升级必须与 App Server Schema 重新生成和兼容性测试一起进行。
- Rust 和 Node.js 版本必须由仓库文件声明，不能只依赖开发者机器当前环境。
- 所有第三方源码和二进制依赖记录许可证、来源、版本、Commit 和修改范围。
- 更新依赖时同步更新 SBOM 和 `THIRD_PARTY_NOTICES.md`。

### 10.2 正式工程应提供的锁定文件

```text
rust-toolchain.toml
Cargo.lock
package.json              # engines + packageManager
前端包管理器锁文件
.codex-version 或等效清单
packages/app-server-schema/metadata.json
docker-compose.yml 或等效开发服务定义
.env.example              # 只放变量名和安全示例，不放真实密钥
```

`packages/app-server-schema/metadata.json` 至少记录：

- Codex 版本。
- Codex Commit 或发行来源。
- Schema 生成时间和命令。
- TypeScript Schema 哈希。
- JSON Schema 哈希。
- 本项目兼容性测试结果。
- 禁用或不支持的实验性方法。

### 10.3 App Server Schema 生成

固定 Codex 版本后，在中央开发机执行对应版本提供的 Schema 生成命令：

```bash
codex app-server generate-ts --out ./packages/app-server-schema/generated
codex app-server generate-json-schema --out ./packages/app-server-schema/generated
```

生成物只能与生成它的 Codex 版本一起升级。任何不兼容变化必须使 CI 明确失败。

---

## 11. 开发环境验收

### 11.1 公共检查

```text
git --version
ssh -V
rustup --version
rustc --version
cargo --version
cargo fmt --version
cargo clippy --version
node --version
corepack --version
```

SQLite PoC 需要确认 `DATABASE_URL=sqlite://./data/central.db` 且初始化迁移成功；如果使用容器化 PostgreSQL，还需确认容器运行时和数据库健康检查通过。

### 11.2 Windows 检查

```text
rustup show
rustup target list --installed
node --version
git ls-remote origin
```

验收结果必须确认默认 Rust Host 使用 MSVC，而不是 GNU 工具链，并成功构建最小 Tauri v2 应用和 Rust Local Agent。

### 11.3 macOS 检查

```text
xcode-select -p
rustup show
node --version
git ls-remote origin
```

验收结果必须确认能够构建并启动最小 Tauri v2 应用和 Rust Local Agent。

### 11.4 中央 macOS 专有检查

```text
codex --version
codex app-server generate-ts --out <临时目录>
codex app-server generate-json-schema --out <临时目录>
psql --version
```

还必须完成：

- Codex App Server 的 `initialize`、`thread/start`、`turn/start` 和 `turn/interrupt` 冒烟测试。
- 客户端抓包，确认客户端没有 OpenAI/ChatGPT 网络流量。
- 中央机抓包，确认 OpenAI 通信只从中央机发出。
- App Server 只监听本机 `stdio` 或 Unix Socket，不暴露到局域网。

---

## 12. 分阶段环境建设

### 12.1 阶段 0：准备和固定

- 准备中央 macOS、Windows x64、macOS Apple Silicon 实机。
- 准备至少两名平台测试用户。
- 确认中央账号授权、费用和合规边界。
- 固定 Codex/Codexia/Soromi 候选版本与 Commit。
- 记录每台机器的 OS、CPU、内存、磁盘和网络信息。
- 配置 GitHub SSH、分支保护和第三方许可证台账。

### 12.2 阶段 1：技术 Spike

- 在 Windows 和 macOS 上分别构建 Codexia。
- 在中央 macOS 上启动固定版本 Codex App Server。
- 完成桌面 UI 经中央测试网关访问 App Server 的最小闭环。
- 完成 Rust Local Agent 的 `workspace/list`、`read_file` 和受控 `exec`。
- 完成客户端主动出站 WSS、心跳和最小设备身份验证。
- 输出技术可行性、许可证结论、版本清单和 Go/No-Go 决策。

### 12.3 阶段 2：正式工程初始化

只有阶段 1 通过后才执行：

- 初始化 Rust Workspace 和前端 Workspace。
- 写入 `rust-toolchain.toml`、Node.js 和包管理器版本。
- 建立 PostgreSQL Migration。
- 建立 Fake App Server、Fake Agent 和一键开发环境。
- 建立 Windows/macOS/中央 macOS CI。
- 建立格式化、Lint、单元测试、协议测试、许可证扫描和敏感信息扫描。

---

## 13. 关键风险和约束

### 13.1 Codex App Server 生产边界

OpenAI 官方文档说明：

- App Server 使用双向 JSON-RPC 风格协议。
- 默认传输是 `stdio`，也支持 Unix Socket。
- App Server Schema 生成物与执行生成命令的 Codex 版本一一对应。
- App Server 命令和 WebSocket 相关能力当前仍存在实验性及生产支持边界。

因此本项目必须：

- 把 App Server 可用性作为阶段 1 的 Go/No-Go 条件。
- 固定版本，不自动跟随升级。
- 只通过中央本机 `stdio` 或 Unix Socket 使用 App Server。
- 在其前面设置自研网关，不让桌面客户端直接依赖 App Server 协议。
- 为 App Server 不可用于生产的情况保留重新评估 Codex SDK 或其他受支持集成面的决策点。

### 13.2 Codexia 许可证和耦合度

正式 Fork 前必须固定具体 Commit，归档该 Commit 的 LICENSE/NOTICE，检查贡献历史并确认商业再许可边界。许可证不明确或核心模块无法安全拆分时，回退为“新建 Tauri v2 工程并选择性移植交互和协议思路”。

### 13.3 跨平台原生依赖

Tauri、Named Pipe、Unix Socket、Keychain、DPAPI、代码签名和安装包均需要原生实机测试。不能只在中央 macOS 上交叉编译后宣布 Windows 客户端可用，也不能只依赖模拟器验证权限和凭据隔离。

### 13.4 单一中央账号

客户端平台账号与中央 OpenAI/ChatGPT 账号不是同一个身份体系。平台必须自己实现用户、设备、对话和工作区所有权；不能依赖中央账号自动提供多用户隔离。

---

## 14. 开发环境完成标准

在进入正式产品开发前，以下项目必须全部通过：

- [ ] 中央 macOS、Windows x64 和 macOS Apple Silicon 实机可用。
- [ ] 三类机器可以通过 SSH 拉取 GitHub 仓库。
- [ ] Windows/macOS 可以构建最小 Tauri v2 应用和 Rust Local Agent。
- [ ] 中央 macOS 可以运行固定版本 Codex App Server 并生成匹配 Schema。
- [ ] SQLite PoC Migration 流程可用；需要多人/集成测试时 PostgreSQL 实例和 Migration 流程可用。
- [ ] 客户端不安装 Codex、不保存 OpenAI 凭据。
- [ ] 客户端抓包不存在 OpenAI/ChatGPT 直连流量。
- [ ] 中央 App Server 没有局域网监听入口。
- [ ] Codexia/Soromi Commit 和许可证台账已固定。
- [ ] Rust、Node.js、包管理器和数据库（SQLite PoC/可选 PostgreSQL）版本策略已写入仓库。
- [ ] Windows/macOS/中央 macOS CI 可以构建并运行基础测试。
- [ ] 技术 Spike 已形成 Go/No-Go 结论。

---

## 15. 官方参考资料

- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Tauri v2 Prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Rust Installation](https://www.rust-lang.org/tools/install)
- [Node.js Downloads](https://nodejs.org/en/download)

外部文档可能更新。正式实现必须以固定版本源码、生成 Schema、仓库锁文件和本项目兼容性测试为准，不能只依赖在线文档的当前内容。
