# 开发工具

所有命令在仓库根目录运行，具体参数见各脚本的 usage 和[开发指南](../docs/开发指南.md)。

| 目录 | 用途 | 主要入口 |
| --- | --- | --- |
| `build/` | 原生辅助程序、图标、受信资源装配 | `build-windows-worker-host.ps1`、`generate-brand-icons.mjs`、`stage-central-*.mjs` |
| `release/` | 安装包、更新包和发布清单 | `npm run package:desktop`、`npm run package:webview2`、`publish-client-release.mjs` |
| `maintenance/` | 配置、迁移预检、中央诊断与显式部署 | `migration-preflight.mjs`、`macos-shared-login-deploy.mjs` |

回归脚本位于 `tests/smoke/`，测试服务位于 `tests/support/`。发布和部署工具必须按当次明确授权使用；目录迁移不代表已部署或已发布。
