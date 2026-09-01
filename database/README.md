# 本地数据库

当前 PoC/Spike 默认使用 SQLite，数据库文件位于 `data/central.db`，该目录和数据库文件已加入 `.gitignore`，不会提交到仓库。

```text
DATABASE_URL=sqlite://./data/central.db
```

在 `spikes/local-dev` 中执行以下命令可创建本地配置并初始化数据库：

```powershell
npm run setup:env
npm run db:init
```

初始化器使用 Node.js 24 自带的 `node:sqlite`，不需要额外安装 SQLite 服务或下载数据库驱动。若 Node.js 版本低于 24，请先按 Spike README 安装 Node.js 24.x。

SQLite 仅用于单机 PoC 和开发验证。多人长期运行、备份恢复和生产部署仍应切换到 PostgreSQL；切换时只替换 `DATABASE_URL` 并使用对应迁移/驱动，不要把 SQLite 文件复制到生产环境。
