# 远舟 · Central Codex Platform

中央化 Codex 多用户远程工作平台。Codex/App Server 在中央机推理，文件、Git、PowerShell 和其他系统操作由目标客户端 Local Agent 执行。客户端主动出站连接中央，不依赖本地 Codex，也不开放入站 SSH。

**新对话或首次接手：先读[项目上下文](docs/项目上下文.md)。** 该文档持续维护项目全貌、当前状态、代码入口与接续事项；开发约束见 [AGENTS.md](AGENTS.md)。

## 当前维护基线

中央 Mac 已使用 WSS、一次性配对码、设备令牌、按用户 Worker 和共享模型登录续期。源码版本、已发布版本和中央部署记录统一见[项目上下文](docs/项目上下文.md)。Windows 中央实现及独立安装 QA 已具备，完整发布资格和跨平台验收仍有缺口，见[验证与已知限制](docs/验证与已知限制.md)。

正式局域网入口为 `wss://192.0.2.10:4510/ws`，禁止暴露到互联网。部署版本、备份及回退见[发布手册](docs/发布与回退手册.md)；文档中的在线数量是历史观测，不代表实时状态。

## 开发入口

仓库根目录是唯一的 npm/Cargo 工作区。以下命令在仓库根目录运行：

```powershell
npm ci
npm run dev
```

`dev` 等同于 `dev:desktop`，自动构建和管理 Local Agent，首次启动按客户端设置完成配对与默认目录配置。中央管理开发入口为 `npm run dev:central-app`。环境要求、旧目录迁移注意事项和检查命令见[开发指南](docs/开发指南.md)。

| 目录 | 内容 |
| --- | --- |
| `apps/desktop` | Tauri + React 工作客户端 |
| `apps/central` | 中央管理 App |
| `services/central-gateway` | 中央网关、Worker 管理和设备路由 |
| `crates` | Local Agent、原生安全和运行支撑 |
| `packages` | AgentRPC 类型等共享模块 |
| `harness` | 固定上游、补丁、隔离和验收摘要 |
| `docs` | 维护手册与设计参考 |
| `scripts/build`、`scripts/release`、`scripts/maintenance` | 构建资源、打包发布和运维工具 |
| `tests/smoke`、`tests/fixtures`、`tests/support` | 回归脚本、夹具与开发探针 |
| `legacy` | 早期数据库 PoC 和阶段参考；不进入正常启动链路 |

## 文档与许可

从[文档导航](docs/README.md)查阅维护手册，开发代理先读 [AGENTS.md](AGENTS.md)。日常改动按风险验证并本地提交；打包和发布仅在当次明确要求时进行。

自有代码的双许可计划及边界见 [LICENSING.md](LICENSING.md)，第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
