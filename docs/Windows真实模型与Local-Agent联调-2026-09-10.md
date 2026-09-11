# Windows 真实模型与 Local Agent 联调

日期：2026-09-10。本阶段接续中央管理 App P0。用户已明确选择使用本机现有 Codex 登录；联调读取原登录文件，不复制凭据、不刷新或撤销账户登录。正式 `192.0.2.10:4510` 服务与已安装客户端没有替换。

## 范围与实现

本机分别承担 QA 中央进程和 QA 客户端角色。中央 App Server 运行在真实 Windows AppContainer 中，通过命名管道及独立租约 TLS 访问中央模型代理。中央代理读取已授权的现有登录，连接固定 ChatGPT 模型端点。实际文件读取与 PowerShell 执行经独立 Local Agent 进程完成。

`harness/local-agent-qa-adapter.mjs` 是仅供测试导入的 AgentRPC 路由，不是正式 Device Broker。它使用随机 loopback 端口、新工作区及独立身份目录，检查真实 Agent hello、工作区能力、固定绑定及请求终态。模型参数不得覆盖设备/工作区绑定。执行工具只允许本轮预先创建的 PowerShell 脚本及精确参数；工作目录边界本身不等于命令沙箱。

`harness/windows-runtime-session.mjs` 封装真实隔离启动器的 JSONL 会话，从创建时订阅租约关闭事件，按具体 Worker 实例幂等停止。`windows-isolation-probe.cpp` 新增严格校验的 `YUAN_QA_MODEL_NAME`，仅允许有限 ASCII 模型名称写入 QA 配置。

`harness/windows-real-model-smoke.mjs` 明确接收登录路径和已编译二进制路径。模型先读取客户端上下文及随机输入标记，再通过 Agent 执行固定脚本，读取脚本生成的另一个随机标记，最后必须在当前 Turn 的同一条最终消息中返回两个标记。脚本验证实际非空 stdout 流、机器名、命令 PID、固定工具参数及 Thread/Turn/callId 归属。持久化验收结果仅保存哈希、计数、固定错误类别和清理状态。

官方说明：Codex 可复用本机登录缓存，文件模式位于 `~/.codex/auth.json`，也可使用系统凭据存储。见 [OpenAI 认证说明](https://learn.chatgpt.com/docs/auth)。本轮只验证现有文件缓存接入；Windows 生产凭据 ACL、系统凭据存储和登录刷新流程仍待实施。

## 已完成的独立验收

| 验证 | 结果 | 边界 |
|---|---|---|
| Local Agent 构建 | `cargo build -p local-agent --locked --offline` 通过 | 复用现有代码，未修改 Agent 源码 |
| 真实 Agent | 7 组通过 | 上下文、随机文件、PowerShell/流、越界和错绑定、两种取消、断连 unknown、不重放及完整清理 |
| 双真实 Worker | 4 组通过 | 模型为合成服务；A 撤销后上游 31ms 关闭、Worker 64ms 回收，B 继续完成原 Turn 和新 Turn |
| Worker 替换与整体关闭 | 通过 | 三个实际 Job/profile 清理、已记录 launcher 残留 0；旧 CA/token 负例由 Node HTTPS 客户端发起 |
| Session 失败收尾 | 4 项通过 | 伪 Node 启动器协议负例，不冒称隔离证据；错误、已排队工具回调和实际 30 秒 RPC 超时触发自动停止 |
| 异步 Worker 启动 | 28 项原有管理 smoke + 3 项启动超时 smoke 通过 | 启动中占用配额；超时拒绝等待请求，迟到 bridge 只关闭一次并保留槽位至匹配退出；不重放 |
| 自然租约到期 | 4 组通过 | 65 秒 TTL；到期后 lease 18ms、上游 19ms、Worker 91ms 内回收；兄弟 Worker 继续 |
| 中央私密文件准入 | 18 项 Rust 测试、格式检查通过 | 固定卷、句柄链、DACL/所有者、reparse/硬链接、大小和零化读取；尚未接入现有 broker |
| 模型代理回归 | HTTPS 租约 19 项、原 broker 23 项通过 | 包含成功终态后保持连接、残缺/非成功终态取消、嵌套及后续错误、配额恢复 |
| 网络边界 | 受控 LAN TCP 明确拒绝；loopback 仍未定性 | 宿主回显成功，AppContainer 返回 `WSAEACCES (10013)`，NetISO 类型为 `INTERNET_CLIENT (2)`；IPv4/IPv6 loopback 仅超时 `10060`，不能据此宣布完整网络隔离 |
| 正式中央只读健康检查 | `ok=true` | 仅证明旧服务可用，不代表新 Windows Worker 已部署 |

原始证据位于 `spikes/local-dev/target/central-p0/local-agent-qa-3/result.json` 和 `lease-runtime-1/result.json`。

异步 Worker 启动超时证据为 `spikes/local-dev/harness/verification/worker-manager-start-timeout-2026-09-10.json`；自然到期证据为 `spikes/local-dev/harness/verification/windows-worker-expiry-2026-09-10.json`。两者都不启用正式 Windows Worker。

中央私密文件准入证据为 `spikes/local-dev/harness/verification/windows-central-private-file-2026-09-10.json`，详细日志保留在 `spikes/local-dev/target/central-private-file-qa.log`。该函数只为后续新建 Windows 凭据存储提供准入，不读取本机现有 `auth.json`，也不修改现有 ACL。

网络矩阵脱敏归档为 `spikes/local-dev/harness/verification/windows-network-2026-09-10.json`。受控诊断服务只绑定中央机 `192.0.2.10`，只接受本机 `192.0.2.20`，自动结束并返回 1 次宿主回显；没有修改防火墙或 loopback exemption。归档中的 `controlled-lan` 为宿主 `0`、容器 `10013`、`NETISO_ERROR_TYPE=2`；loopback 两个地址均为 `10060` 且没有明确诊断，保持 `fullNetworkIsolationQualified=false`。

首次 Agent 测试发现原 debug 二进制缺少当前 remote-workspace 能力，严格拒绝；重新构建后的二进制通过。保留旧失败记录，不将旧二进制的握手成功视为当前协议通过。

## 真实模型验收

最终 `real-model-3/result.json` 四组全部通过，可提交脱敏归档为 `spikes/local-dev/harness/verification/windows-real-model-2026-09-10.json`：

- 使用本机已有 ChatGPT 登录和 `gpt-6-astra`，5 次管道连接、TLS 握手、HTTP 请求及模型请求准入，无失败审计。
- 4 次真实 Agent 调用：客户端上下文、输入文件读取、固定 PowerShell 执行、执行结果文件读取；流中有 2 次非空 stdout 事件，内容包括启动标记及执行生成的随机结果。
- Turn 为 `completed`；当前 Turn 的最后一条消息同时精确匹配输入随机标记和命令新生成的随机标记。最终文本为 98 个 UTF-8 字节，只归档哈希。
- 租约撤销自动停止 Worker，Job/profile 清理通过；Agent 已退出、监听关闭、pending=0、重放=0。

失败历史保留：`real-model-1/result.json` 已有 4 次真实设备调用和 completed Turn，但上游成功完成后 Rust 关闭 SSE 被审计为 `MODEL_REQUEST_CANCELLED`，整体严格判失败。修复现在只在完整成功终态已验证、下游 write 回调确认传出后，将客户端关闭归为完成；未传递、残缺或非成功终态不适用。`real-model-2/result.json` 在两次读取后收到泛化 `MODEL_PROVIDER_UNAVAILABLE`，Turn 失败，没有执行命令；该历史错误码不足以追溯具体原因。本轮随后补充固定失败阶段码，不保存上游原始错误文本。第三次在全新工作区主动开始独立验收，未重放失败 Turn。

最终二进制 SHA-256：

- App Server：`117549a4f5fde94b376ab4c1cdd821706030289362e0055e836c97cc973b986b`。
- 原生启动器：`5357cf20c19de63484313cf50d2d5bb7bd78001d76edec81a91753f9e4118a98`。
- Local Agent：`700837cc5dba17ed7712005e657ccd5eddfbd9fb806daaf7ec897dd6e94c8e7c`。

## 后续边界

同机真实模型/Agent 闭环不等于独立远端设备、正式网关路由或 Windows 生产发布。`worker-isolation.ts` 的正式 Windows gate 保持关闭，`deployable=false`。完整 IPv4/IPv6/LAN 网络拒绝、安装目录及凭据 ACL、自动到期验收、生产 Worker 生命周期整合和中央管理 UI 仍须独立完成。
