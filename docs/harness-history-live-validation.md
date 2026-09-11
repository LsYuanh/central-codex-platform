# P4 历史兼容真实链路验收

本验收使用隔离中央 4529 的真实 fork App Server 和 Windows Local Agent。客户端不运行 Codex，不连接 4510，不读取生产私人对话。样本是明确标记的 QA 迁移 fixture：真实原生 Thread 配置固定旧三工具表，平台 summary 使用缺少 `remoteWorkspace` 的旧 v1 形态；它不是从生产旧会话抽样取得的数据。

## 运行条件

中央网关同时开启 `TEST_GATEWAY_ENABLE_CONTROLS=1` 和 `TEST_GATEWAY_ENABLE_HISTORY_FIXTURES=1`。QA hook `test.history.legacy_create` 只接受空 payload，拒绝 4510 和非 `harness-` 用户/设备，固定工具为 `device_workspace_list`、`device_read_file`、`device_exec`，不接受模型/工具/策略覆盖。只在隔离运行环境认证保护就绪后运行。

在 `spikes/local-dev` 执行：

```powershell
$env:HARNESS_HISTORY_GATEWAY_URL = 'ws://192.0.2.10:4529/ws'
node scripts/harness-history-live-smoke.mjs
```

脚本为每次运行生成随机 QA 用户、设备、Thread 和临时工作区。Local Agent 使用与桌面相同的 `--attachment-stdio` 和保持打开的 stdin 管道启动。`LOCAL_AGENT_BIN` 可指定已验证 Agent；默认 `target/harness-agent/debug/local-agent.exe`。脚本结束关闭 Agent 并归档自己的 QA Thread，保留小型 fixture 作为证据。成功时在 fixture 内写入 `history-result.json`，包含 Agent 二进制 SHA256、Turn ID、检查清单和附件输出快照。

## 验证范围

1. 真正创建固定旧动态工具表的原生 Thread，旧 summary 在首次续聊请求时补入当前客户端工作区绑定。
2. 第一个真实 Turn 只产生唯一 seed 文本，使原生 rollout 落盘；没有任何 Turn 的新 Thread 尚无可恢复 rollout。断开重连、恢复和读取后必须保留同一 Turn 和原消息。
3. 第二个真实 Turn 通过旧 `device_exec` 的 `codexia.workspace` 保留路由完成 context、search、read_text 和需审批的 patch；通过 `codexia.files` 写出一个真实客户端输出。原生 dynamicToolCall 事件必须仅使用旧工具名。
4. 同一 Turn 的实际客户端 Node 命令只向计数文件追加一次。脚本主动丢弃提交响应，待完成后断线重连，以公开 `conversation.message.status` 确认已接收后才重发相同 `clientMessageId`，要求返回原 Turn ID，历史只有两个 Turn，计数只有一行。
5. 归档后分别核对归档列表和普通列表；再重连、取消归档、恢复，要求原有 Turn ID 不变。
6. 调用独立 artifact helper，在归档前后核对实际附件/输出元数据、UI 历史卡片、来源设备、绝对路径、版本、字节和 SHA256；首次还验证显式保存副本、幂等和覆盖版本冲突。

丢响应实验只丢弃客户端消息处理中的单个提交响应，连接保留到工具全部执行结束，避免混入设备审批连接中断。它验证已被服务端确认接收的提交在重连后幂等重试，不声称验证任意外部系统副作用的 exactly-once。网关进程重启和执行中故障由独立故障矩阵覆盖。

## 当前结果

最终复跑使用修复 Windows Job 的 Agent，SHA256 为 `3CCF62FD08A79EBE0B35ACC7186BC86556E381E2275200C492AB75908571C0E8`；中央第二版网关包 SHA256 为 `f6e468648f8af6d9c1ceee4c8c6456d34c70bf699ab4dd8650d3e6cc4d7a593f`。十项主链检查、归档前后 artifact helper 全部通过，exit 0。最终 QA Thread 是 `01a084b2-4cb9-7fa2-84f2-95729792c1dc`，两个 Turn 为 `01a084b2-4d60-75f1-b5f3-4057ff7dbab5` 和 `01a084b2-6739-7101-a1e4-8ecfbbf2d413`；随机用户/设备为 `harness-history-f613e9d4-03a8-4bb3-963f-7b08991e3f58`。完整成功证据含输出快照已保存至 `C:\Users\developer\AppData\Local\Temp\codex-harness-history-uVthGO\history-result.json`。最终 Thread 已归档，Agent 退出。

2026-09-09，真实中央 4529 + Windows Agent 完整通过，脚本 exit 0。QA Thread 为 `01a084a8-1dd8-7bf3-a77a-35a88387c7e9`；seed Turn 为 `01a084a8-1e4f-7251-89f2-dadedfa3d0e0`，续聊 Turn 为 `01a084a8-34d0-7042-ab90-85a5962cfc64`。随机设备和用户均为 `harness-history-1f3a0779-16d2-437f-840f-ed49fa328f10`，客户端 fixture 为 `C:\Users\developer\AppData\Local\Temp\codex-harness-history-Hz3XtD`。

所有十项主链检查通过；真实原生 dynamicToolCall 只使用旧表工具，保留路由的 context/search/read/patch 与文本输出成功；补丁审批仅一次；命令 `cwd="."` 返回真实 exitCode 0；响应丢弃一次后状态查询和同 ID 重发返回相同 Turn，计数保持一行。归档、列表、取消归档和恢复保持两个原 Turn ID。artifact helper 的归档前保存副本/幂等/版本冲突及恢复后元数据等价检查全部通过。脚本最终归档 QA Thread 并退出 Agent，随后进程查询无 `local-agent`。

调试中记录两项测试前提：无 Turn 的新原生 Thread 尚未有 rollout，必须先完成 seed 再恢复；旧 `device_exec` 描述曾允许绝对 cwd，而严格工作区要求相对 cwd。一次试跑最后的计数命令被 `WORKSPACE_PATH_DENIED` 拒绝，未产生副作用；成功轮明确传 `cwd="."`。网关工具描述由主代理同步修正。以上失败没有被归为通过，也没有对同一未知写入自动重试。
