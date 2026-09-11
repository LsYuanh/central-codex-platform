# 客户端首次发送 serviceName 修复与验收

日期：2026-09-11。用户反馈首次发送报错并确认修复，沿用现有客户端、正式中央服务与单线程开发方式。

## 原因与修复

客户端 `apps/desktop/src/App.tsx` 在首次发送时调用 `threadStart`，无条件带上旧 Spike 参数 `serviceName`。网关 `services/test-gateway/src/remote-workspace.ts` 的 `validateRemotePayload` 禁止客户端设置这个由中央管理的字段，所以会返回 `REMOTE_POLICY_OVERRIDE: serviceName is managed by the gateway`。网关和设备均在线，配对与 CA 配置无误。

修复仅移除客户端构造请求时的 `serviceName`。网关策略保持原样，仍负责管理运行参数，文件与命令继续由 Local Agent 在客户端执行。无需用户重新配对或修改中央配置。本批 Windows 安装包继续包含一体配对和无终端启动修复。

## 回归入口

`scripts/pairing-native-ui-smoke.mjs` 增加显式 `--send-turn` 验收：使用独立 QA Tauri 应用身份与工作区，连接正式中央服务，在真实页面选择 GPT-5.6-Sol/high，点击发送首条及后续消息，核对两次模型回复与完成状态。只观察真实 native IPC 的请求字段，不替换网关或模型结果；验证只创建一个对话，两次 Turn 使用同一 Thread，并且请求不含中央管理字段。测试代码仅经内存传递；结束后撤销专用设备、取消本机配对并正常关闭窗口。

从 `spikes/local-dev` 运行：

```powershell
node scripts/pairing-native-ui-smoke.mjs <playwright/index.mjs的绝对路径> --send-turn
```

运行前必须按原生验收脚本要求构建独立 QA 标识版本，不能将普通用户客户端作为验收目标。输出位于 `target/desktop-first-send-20260911/`。分发仍使用 `node scripts/package-desktop.mjs --debug` 生成的正常应用标识安装包。

## 结果与交付

- TypeScript 检查、Vite 构建、Tauri Debug 构建与 NSIS 打包通过；Windows GUI 子系统打包校验通过，保留无终端启动修复。
- 真实桌面首条消息与后续消息均通过 GPT-5.6-Sol/high 完成，两个不同的随机文本标记在助手回复中显示，任务退出运行状态。实际截图已查看：`target/desktop-first-send-20260911/conversation.png`。
- 观察实际请求序列化的数据：一个 `conversation.create`，只包含 `model`；两个 `conversation.turn.create`，包含 `threadId/input/clientMessageId/attachments/model/effort`，Thread 均为 `01a08ef1-cc23-7b83-9b57-e22eaac7be70`。没有 `serviceName` 或其他中央管理字段。
- 完整通过报告：`target/desktop-first-send-20260911/result.json`。专用测试设备 `2ec794c6-57d3-4fe1-9247-f574d9969a81` 已撤销，本机取消配对，窗口正常关闭。真实用户客户端与资料未覆盖。
- 早期脚本因 Markdown 处理含下划线标记而等待超时，另一次原生 invoke 观察未获取帧；调整为纯字母数字标记与不改变输出的序列化观察后，完整验收通过。上述是验收脚本问题，不把失败轮次记为通过。

安装包：`spikes/local-dev/target/releases/pairing-20260911/远舟客户端_0.1.0_windows_x64_对话修复.exe`。

大小：6691305 字节。SHA-256：`d547bd4465aa459e610251ea11aadbb49d0e6b842e83b59bd1aa7e2989cb5825`。

先退出旧客户端，再运行此安装包。本轮已构建、未替用户安装；仍为未签名 Debug 测试版。本轮交付 Windows 包，Mac 客户端历史 DMG 未重新构建；中央服务无需更新。
