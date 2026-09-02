<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# Day 5 验收矩阵

`npm run day5:acceptance` 对中央测试网关执行一组可重复的黑盒探针。默认地址是
`ws://127.0.0.1:4510/ws`，也可以用 `DAY5_GATEWAY_URL` 指定 SSH 隧道或中央测试环境。

脚本会输出 `PASS` 和 `BLOCKED` 两类结果。`BLOCKED` 不是把尚未实现的能力误判为通过；设置
`DAY5_STRICT=1` 时，只要存在阻断项就以退出码 2 结束，适合接入 CI。

| 场景 | ID | 当前探针 | 当前 Spike 预期 |
| --- | --- | --- | --- |
| 两个用户各自创建 Thread，互不可见 | THR-001 | `conversation.list/read/turn.create` 交叉访问 | PASS |
| 掉线后恢复原用户 Thread | THR-002 | 关闭连接再连接并列出原 Thread（固定 `userId`） | 需重启中央网关后复测 |
| 两台设备的设备/工作区隔离 | DEV-001 | 两个带独立 `deviceId` 的 AgentRPC `/ws/agent` hello | 需重启中央网关后复测 |
| 跨会话取消被拒绝 | APR-NEG | 非所有者 `conversation.turn.cancel` | PASS |
| 批准、拒绝、取消、超时完整闭环 | APR-001 | 协议和事件是否可驱动生命周期 | BLOCKED：尚未暴露审批状态协议 |
| 审计可检索且包含关联 ID | AUD-001 | `/audit` 是否返回 user/device/request 关联字段 | 需重启中央网关后复测（当前为进程内环形缓冲） |

运行示例：

```powershell
npm run day5:acceptance
$env:DAY5_STRICT = "1"
npm run day5:acceptance
```

`DAY5_ALLOW_AGENT_PROBE=1` 可在确认不会干扰现有 Local Agent 时强制执行双 Agent 探针；默认检测到已有
Agent 在线时跳过连接竞争，以免中断正在使用的设备。
