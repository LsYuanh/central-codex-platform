# 测试入口

在仓库根目录执行，先安装依赖、构建相关 workspace 与 Local Agent。

| 目录 | 用途 |
| --- | --- |
| `smoke/` | 协议、原生边界、页面与设备回归；包含按平台和显式条件运行的验收脚本 |
| `fixtures/` | 工作区、页面和更新签名的合成测试数据 |
| `support/` | Fake Central 与早期 App Server 代理，仅供开发验证 |

常用入口：`npm run layout:check`、`npm run protocol:test`、`npm run smoke`、`npm run stream:smoke`。`npm run device:smoke` 需要事先启动可用的开发网关，可通过 `DEVICE_GATEWAY_URL` / `DEVICE_AGENT_URL` 指定地址；`LOCAL_AGENT_BIN` 可指定已构建的 Agent。

`project-gateway-smoke.mjs` 自行启动隔离网关、真实 Local Agent 和中央协议夹具，验证文件与命令来自客户端。它不等同于真实中央模型推理验收。UI、Windows ACL/DPAPI、真实模型与发布验收的前置条件见[验证手册](../docs/验证与已知限制.md)。
