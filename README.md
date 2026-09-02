# Central Codex Platform

中央化 Codex 多用户远程工作平台。

## 核心目标

- Codex 和 OpenAI 凭据只部署在中央 macOS；
- Windows/macOS 客户端不安装 Codex，不直接访问 OpenAI；
- 每位平台用户独立管理自己的账号、对话、设备和工作区；
- Codex 在中央机推理，文件、Git 和命令在指定客户端的 Local Agent 中执行；
- 客户端只建立主动出站连接，默认不开放 SSH 或其他入站端口。

## 当前阶段

项目已进入阶段 2 第一轮：在保留本机纵向 Spike 的前提下，建立最小 AgentRPC V1 合同、Fake App Server Worker/Remote Workspace Bridge、中央 Device Broker 和可重复的本机/真实中央机协议 smoke。真实中央机测试网关现支持可信局域网临时直连；正式认证、WSS/mTLS 和多用户 Worker 仍在开发中。

桌面端当前已提供 Codexia Workspace 正式版工作台 UI，覆盖 Thread 管理、实时对话、Markdown、工作区文件浏览、文件读取、受控版本命令和活动日志；权限与认证仍按局域网 Spike 边界运行。

Spike 客户端 UI 另提供 `Local Codex App Server` 开发模式：用户自行启动本机
`codex app-server --listen ws://127.0.0.1:4500`，再由本地开发代理转发到 UI，即可做真实握手、Thread、流式事件和审批测试；该模式不会改变生产中央化边界。

在 Spike 给出 Go/No-Go 之前，不初始化正式 Rust/Node 产品工程，不引入生产依赖。

## 目录

```text
apps/                         桌面应用与后续管理界面
services/                     中央控制面、Worker、Broker 和 Bridge
crates/                       Local Agent、AgentRPC、IPC、策略和审计
packages/                     App Server Schema、API Client 和 UI 组件
database/                     数据库迁移与种子数据
infra/                        中央 macOS、签名和监控
tests/                        协议、E2E、安全和跨平台测试
docs/                         架构、路线、ADR、威胁模型和 Runbook
```

## 许可证

项目方拥有完整版权的代码计划采用：

```text
AGPL-3.0-only OR Commercial License
```

详细边界见 `LICENSING.md`。商业许可文本、CLA 和商标规则在对外发布或接受外部贡献前必须经过知识产权律师审阅。

第三方代码继续适用其原始许可证，不因进入本仓库而自动变成本项目双许可代码。

## 文档

- `docs/中央化Codex多用户远程工作平台-需求与架构设计-V0.2.md`
- `docs/中央化Codex平台-总体开发路线-V1.0.md`
- `docs/中央化Codex平台-技术选型与开发环境-V1.0.md`
- `docs/B.3-A0-推荐改造方案启动决策清单.md`
- `docs/B.3-B6-阶段验收与Go-No-Go-2026-09-01.md`
