<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# 远舟中央管理图标

2026-09-20 用户确认的第二版：深青色 `#286967`、等高对称双帆，与客户端高低双帆共用相同船身和圆角底板。

矢量源为 `../../src/assets/logo.svg`，同时用于中央侧栏品牌区及浏览器图标。`tauri.conf.json` 指向本目录的 PNG、ICO、ICNS，不能改回客户端图标。

在 `spikes/local-dev/` 执行 `node scripts/generate-brand-icons.mjs` 可同时重生成两端资源；生成方式、格式约束和验证范围见[客户端图标说明](../../../desktop/src-tauri/icons/README.md)。此资源变更尚未打包或部署至真实中央。
