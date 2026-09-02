<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# B.3 / B.6 阶段验收与 Go/No-Go

日期：2026-09-01  
范围：本地纵向 Spike + 真实中央 macOS 测试网关（SSH 回环隧道）

## 结论

**Spike：Conditional Go。** 中央机 App Server、桌面 UI、Device Broker、Local Agent、Thread/Device 隔离、审批测试生命周期和审计查询已形成可重复闭环，可以进入正式认证、持久化和安全架构阶段。

**生产 Fork：No-Go。** 当前仍是测试网关，身份来自仅限 Spike 的 URL query principal；通信使用 SSH 隧道而非 WSS/mTLS；Thread/审计状态为进程内存；尚未完成真实 Windows + macOS 双客户端、抓包证明和 Codexia 依赖许可证/法务归档。

## 可重复证据

在 `spikes/local-dev` 执行：

```powershell
npm run check
npm test
npm run smoke
npm run device:smoke
$env:DAY5_ALLOW_AGENT_PROBE = "1"
$env:TEST_GATEWAY_ENABLE_CONTROLS = "1"
$env:DAY5_STRICT = "1"
npm run day5:acceptance
```

最后一条真实中央机验收结果为 **6 PASS / 0 BLOCKED**：

- THR-001：双用户 Thread 列表、读取和续聊交叉访问被拒绝；
- THR-002：同一 `userId` 重连可恢复已拥有 Thread；
- DEV-001：两个 `deviceId` 可独立完成 AgentRPC hello；
- APR-NEG：跨会话取消在到达 App Server 前被拒绝；
- APR-001：synthetic approval 的 accept、reject、timeout 经 `approval.response` 完成并写入审计；
- AUD-001：`/audit` 返回关联的 user/device/request 元数据和结果状态。

桌面 Tauri 窗口另已在真实中央网关上人工验证：网关在线、Thread 创建、Device Broker 在线、`workspace/list`、`read_file` 和受控 `git --version` 均成功。

## 已知边界与下一阶段阻断项

1. `TEST_GATEWAY_ENABLE_CONTROLS=1` 只用于 Spike，生产构建必须关闭并移除 synthetic operation。
2. Spike principal（`userId`/`deviceId` query）不是认证机制；正式实现必须改为平台账号、设备证书和服务端派生的租户上下文。
3. 中央网关仍通过 SSH 回环隧道验证；正式链路需要 WSS/mTLS、配对、吊销、重放保护和连接恢复。
4. Thread/审计目前为进程内存；正式实现需要持久化数据库、事件游标、幂等键和防篡改审计留存。
5. 尚未完成真实 App Server 工具审批回合、第二台 macOS 客户端、抓包/防火墙验证，以及 Codexia 固定 Commit 的依赖许可证和商业再许可审查。

