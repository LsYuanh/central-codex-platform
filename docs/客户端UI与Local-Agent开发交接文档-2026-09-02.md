# 客户端 UI 与 Local Agent 开发交接文档

更新时间：2026-09-02  
适用目录：`C:\Workplace\central-codex-platform`  
当前阶段：局域网真实中央网关 Spike，下一步重点完善客户端页面 UI。

## 1. 当前结论

核心链路已经打通：中央机只负责 Codex/App Server 推理，客户端的文件、Git、PowerShell 和其他系统操作由客户端 Local Agent 执行。

Local Agent 已纳入桌面客户端生命周期：

- 启动 `desktop-spike.exe` 时自动启动同目录的 `local-agent.exe`；
- 关闭桌面窗口时自动停止 Local Agent；
- 客户端不需要另外启动本地 Codex、Codex CLI 或 helper；
- 已在真实中央机上验证启动注册、关闭注销和 PowerShell 执行。

## 2. 架构与数据边界

```text
React/Tauri 客户端
        │  WebSocket /ws
        ▼
中央测试网关（中央机 192.0.2.10:4510）
        │  stdio
        ▼
Codex App Server（中央机，只推理）

客户端 Local Agent
        │  WebSocket /ws/agent（主动出站）
        ▲
中央测试网关转发 device.* 请求
        │
本机文件系统 / Git / PowerShell / 命令执行
```

重要边界：中央 App Server 不应直接读取客户端文件，也不应在中央机执行客户端命令。中央侧只产生推理结果和工具请求；网关将设备工具请求转交给目标客户端的 Local Agent，由 Local Agent 在本机执行并回传结果。

## 3. 真实中央机连接参数

当前中央机：`operator@192.0.2.10`  
中央网关 UI 地址：

```text
ws://192.0.2.10:4510/ws
```

Local Agent 地址：

```text
ws://192.0.2.10:4510/ws/agent?deviceId=desktop-device
```

当前是可信局域网临时模式，使用明文 WebSocket 和 `--allow-insecure-lan`。暂未实现正式认证、WSS/mTLS、细粒度权限和多用户隔离，不要将 4510 暴露到互联网。

网关健康检查：

```powershell
Invoke-RestMethod http://192.0.2.10:4510/healthz
```

启动后预期 `devices` 为 `1`；关闭客户端后预期 `devices` 为 `0`。

## 4. Local Agent 自动生命周期实现

实现文件：

- [Tauri 生命周期代码](../spikes/local-dev/apps/desktop/src-tauri/src/main.rs)
- [开发启动脚本](../spikes/local-dev/package.json)

`main.rs` 中的 `LocalAgentSupervisor` 保存子进程句柄：

1. `main()` 启动时调用 `LocalAgentSupervisor::start()`；
2. 通过 `Command` 启动 Local Agent，标准输入输出隐藏；
3. Tauri `CloseRequested` 事件触发 `stop()`；
4. Supervisor 的 `Drop` 作为兜底，再次停止子进程。

默认路径约定：

- Local Agent：桌面可执行文件同目录的 `local-agent.exe`；
- 工作目录：`target/debug/../../fixtures/workspace`；
- 网关：`ws://192.0.2.10:4510/ws/agent?deviceId=desktop-device`。

可用环境变量覆盖默认值：

```powershell
$env:CODEXIA_LOCAL_AGENT_PATH = 'C:\path\to\local-agent.exe'
$env:CODEXIA_WORKSPACE_ROOT = 'C:\path\to\workspace'
$env:CODEXIA_GATEWAY_AGENT_URL = 'ws://192.0.2.10:4510/ws/agent?deviceId=my-device'
```

## 5. 启动与测试

在原项目目录执行：

```powershell
cd C:\Workplace\central-codex-platform\spikes\local-dev
npm install
npm run dev:desktop
```

`dev:desktop` 现在会先执行 `cargo build -p local-agent`，再启动 Tauri 开发窗口；Tauri 的 `beforeDevCommand` 会自动启动 Vite。

如果中央网关已经在中央机运行，客户端启动后在 UI 选择 Central Gateway，并填写上面的 `ws://192.0.2.10:4510/ws` 地址即可。连接 UI 和设备在线是两个状态：网关连接成功不代表 Local Agent 已连接，需同时看到设备在线。

快速验证：

```powershell
Get-Process desktop-spike,local-agent
Invoke-RestMethod http://192.0.2.10:4510/healthz
```

验证关闭行为：关闭桌面窗口后执行上述命令，应看不到两个进程，且网关 `devices` 为 `0`。

## 6. 当前已完成的功能

- Codexia Workspace 基础正式版布局；
- Central Gateway 连接、Thread 创建/恢复/重命名/归档/删除；
- 流式对话、Markdown 消息和中断；
- 工作区目录浏览和文件读取；
- 客户端 `device_exec`，支持本机 PowerShell；
- 中央侧自动拒绝不应由中央处理的系统审批；
- Local Agent 主动出站连接；
- Local Agent 随 Tauri 客户端自动启动/停止；
- 真实中央机网关连通和设备工具调用验证。

## 7. 下一步 UI 工作建议

按优先级继续：

### P0：让主流程稳定可用

- 连接状态统一：`未连接 / 连接中 / 已连接 / 重连中 / 错误`；
- 首次连接、断线重连、网关不可达时给出明确错误和重试按钮；
- Thread 创建后自动选中并正确恢复历史消息；
- 对话发送中的 loading、流式增量、完成、失败和中断状态；
- 防止重复发送、重复创建 Thread 和页面一直 loading。

### P1：完善工作台交互

- Thread 搜索、排序、重命名、归档和删除确认；
- 消息气泡、Markdown、代码块复制和长输出折叠；
- Local Workspace 面板的目录导航、刷新、返回上级和路径提示；
- 文件读取和命令执行结果的统一结果卡片；
- 活动日志按时间、类型和成功/失败过滤。

### P2：页面质量

- 窗口缩放和窄屏布局；
- 统一空状态、错误状态、骨架屏和 toast；
- 连接设置持久化，但不要把凭据写入前端；
- 将中央网关地址、设备 ID、工作区和模型从硬编码改成可配置设置；
- 为核心状态机增加 React/协议 smoke 测试。

## 8. 已知限制与注意事项

- 这是 Spike，不是正式生产客户端；
- 当前默认网关地址写在 Tauri 启动代码中，后续应迁移到设置或受控配置文件；
- 当前通过相邻 `local-agent.exe` 启动，正式打包时应改为 Tauri sidecar/安装包资源；
- Local Agent 的工作区仍受路径边界和命令策略限制，但局域网模式暂不提供完整权限审批；
- Vite 开发服务器是前端开发依赖，关闭 Tauri 不会自动停止由外部命令启动的 Vite 进程；
- 正式版本仍需认证、WSS/mTLS、用户/设备隔离、审批、审计和稳定的 Worker 管理。

## 9. 最近提交

```text
d6f1e75 style: format Local Agent lifecycle code
030a5b7 build: prepare Local Agent before desktop dev
6554ef0 feat: manage Local Agent with desktop lifecycle
7f8751d fix: execute dynamic device tools in broker
```

原项目当前工作区已清理。之前用户已有的未提交修改曾保存为 Git stash，恢复前请先检查：

```powershell
git -C C:\Workplace\central-codex-platform stash list
```

不要直接覆盖或删除该 stash。

## 10. UI 验收清单

- [ ] 能启动客户端并看到中央网关连接状态；
- [ ] Local Agent 自动在线，无需手动启动本地 Codex；
- [ ] 新建 Thread 并发送普通问题；
- [ ] 能看到流式回答和完成状态；
- [ ] 让中央推理请求读取本机文件，结果来自客户端工作区；
- [ ] 让中央推理请求执行 PowerShell，命令实际在客户端执行；
- [ ] 断开网关后页面能提示错误并支持重连；
- [ ] 关闭窗口后 Local Agent 自动退出；
- [ ] 重新打开后 Local Agent 自动重新上线。
