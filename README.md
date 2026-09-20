# 远舟 · Central Codex Platform

中央化 Codex 多用户远程工作平台。Codex/App Server 在中央机推理，文件、Git、PowerShell 和其他系统操作由目标客户端 Local Agent 执行。客户端主动出站连接中央，不依赖本地 Codex，也不开放入站 SSH。

**新对话或首次接手：先读[项目上下文](docs/项目上下文.md)。** 该文档持续维护项目全貌、当前状态、代码入口与接续事项；开发约束见 [AGENTS.md](AGENTS.md)。

## 当前维护基线

截至 2026-09-20 的仓库及部署记录：工作客户端 0.2.2，中央管理 App 0.1.1；中央 Mac 已使用 WSS、一次性配对码、设备令牌、按用户 Worker 和共享模型登录续期。Windows 中央实现及独立安装 QA 已具备，完整发布资格和跨平台验收仍有缺口，见[验证与已知限制](docs/验证与已知限制.md)。

正式局域网入口为 `wss://192.0.2.10:4510/ws`，禁止暴露到互联网。部署版本、备份及回退见[发布手册](docs/发布与回退手册.md)；文档中的在线数量是历史观测，不代表实时状态。

## 开发入口

实现集中在 [spikes/local-dev](spikes/local-dev/README.md)，继续在现有工程开发。

```powershell
cd spikes/local-dev
npm ci
npm run dev:desktop
```

`dev:desktop` 自动构建和管理 Local Agent，首次启动按客户端设置完成配对与默认目录配置。中央管理开发入口为 `npm run dev:central-app`。环境要求和检查命令见[开发说明](spikes/local-dev/README.md)。

| 目录 | 内容 |
| --- | --- |
| `spikes/local-dev/apps/desktop` | Tauri + React 工作客户端 |
| `spikes/local-dev/apps/central` | 中央管理 App |
| `spikes/local-dev/services/test-gateway` | 中央网关、Worker 管理和设备路由 |
| `spikes/local-dev/crates` | Local Agent、原生安全和运行支撑 |
| `spikes/local-dev/packages` | AgentRPC 类型等共享模块 |
| `spikes/local-dev/harness` | 固定上游、补丁、隔离和验收摘要 |
| `docs` | 维护手册与设计参考 |
| `database` | 早期数据库 PoC；不是正式中央数据迁移入口 |

## 文档与许可

从[文档导航](docs/README.md)查阅维护手册，开发代理先读 [AGENTS.md](AGENTS.md)。日常改动按风险验证并本地提交；打包和发布仅在当次明确要求时进行。

自有代码的双许可计划及边界见 [LICENSING.md](LICENSING.md)，第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
