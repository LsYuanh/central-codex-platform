# Windows P0 受限模型命名管道

这是独立 QA 探针与桥接原型，不是正式网关或客户端功能。没有读取真实模型凭据、增加 AppContainer network capability、修改全局 ACL、防火墙或 loopback 例外。

## 已验证的名称与身份

`target/central-p0/model-pipe-native-5/summary.json` 为本机原生合成验证结果。宿主与 Worker 使用不同的名称视图：

```text
GetAppContainerNamedObjectPath(nullptr, SID, ...) 本机返回：
  AppContainerNamedObjects\<SID>

宿主 CreateNamedPipe：
  \\.\pipe\Sessions\<WorkerSessionId>\AppContainerNamedObjects\<SID>\<随机叶子名称>

Worker CreateFile：
  \\.\pipe\LOCAL\<同一随机叶子名称>
```

SessionId 由 `ProcessIdToSessionId` 获取。直接让宿主与 Worker 都使用同一 `LOCAL` 字符串在本机失败为 2；缺少 Sessions 前缀也失败为 2。必须按实际返回的命名对象路径与会话构造宿主路径，不能把这些失败当作 DACL 隔离证明。[Microsoft 命名对象 API](https://learn.microsoft.com/en-us/windows/win32/api/securityappcontainer/nf-securityappcontainer-getappcontainernamedobjectpath)

成功连接使用：仅 SYSTEM、宿主用户完全控制；只对目标 AppContainer SID 开放客户端访问；Low mandatory label；`PIPE_REJECT_REMOTE_CLIENTS`；首次实例 `FILE_FLAG_FIRST_PIPE_INSTANCE`。Worker 查询 server PID 并匹配预期宿主进程；宿主先读合成初始字节，再核验 client PID，并通过 `ImpersonateNamedPipeClient`、`OpenThreadToken(..., OpenAsSelf=TRUE)` 验证 `TokenIsAppContainer=1`、精确 SID 和 capability 数量 0，随后 Revert。另一 AppContainer 直接访问 A 的完整宿主路径返回 5。

## 权限与实例对照

| 对照 | 本机结果 |
| --- | --- |
| A 使用精确 `0x00100083` 访问掩码及同一 DACL | 双向通信、身份验证通过 |
| A 对该窄 DACL 使用 GENERIC_READ/WRITE | 5，拒绝 |
| B 对 A 精确宿主路径尝试连接 | 5，拒绝 |
| 窄 DACL 下 A 尝试创建额外实例 | 5，拒绝 |
| GENERIC_READ/WRITE DACL，唯一实例始终保留，A 创建额外实例 | 231，实例已满 |
| 已存在实例上再用 FIRST_PIPE_INSTANCE | 5，拒绝 |
| A 预占一个尚未建立的同名端点，宿主尝试首次建立 | 宿主返回 231，未获得实例 |
| Disconnect 后复用原唯一句柄 | A 再连接及身份检查通过 |

Microsoft 明确说明 `FILE_GENERIC_WRITE` 包含与 `FILE_CREATE_PIPE_INSTANCE` 等值的权限；窄访问掩码能避免授予此权限。Tokio/reqwest 当前客户端使用 GENERIC_READ/WRITE，桥因而采用完整预建实例和保留句柄方案，而不能仅依赖 SID DACL 阻止额外服务器实例。[Microsoft named-pipe 权限说明](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)

预占仍可以造成拒绝服务，不能通过换一个同名创建方式继续运行；首次创建失败必须关闭 Worker。随机名称用于生命周期隔离，TLS 独立验证同连接的服务端身份。上述探针实测的是 maxInstances=1；桥的四实例集成结果必须单独记录。

## 原生探针运行

在加载 `C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat` 的 x64 开发环境下，工作目录为 `.`：

```bat
cl /nologo /std:c++17 /EHsc /W4 /MT harness\windows-model-pipe-probe.cpp /Fe:target\central-p0\windows-model-pipe-probe.exe /Fo:target\central-p0\windows-model-pipe-probe.obj
cl /nologo /std:c++17 /EHsc /W4 /MT /DYUAN_PIPE_CHILD harness\windows-model-pipe-probe.cpp /Fe:target\central-p0\windows-model-pipe-child.exe /Fo:target\central-p0\windows-model-pipe-child.obj
target\central-p0\windows-model-pipe-probe.exe C:\Workplace\central-codex-platform\target\central-p0\NEW_PIPE_QA_RUN
```

目录必须全新且父目录已存在，没有祖先 reparse point。工具的宿主执行许可不等于申请 Windows 管理员权限。两个测试 profile 在退出时清理；新建 QA 目录保留分项结果。

## 四实例透明桥 API

`windows-model-pipe-bridge.hpp` 提供 `yuan::qa::WindowsModelPipeBridge`：

```cpp
auto alias = WindowsModelPipeBridge::clientPipeName(freshNonce);
// 把 alias 放入显式白名单环境，再 CREATE_SUSPENDED 创建 Worker 并加入 Job。
WindowsModelPipeBridge bridge(sid, fixedLoopbackHttpsPort, workerPid, freshNonce,
    [job](std::string) { TerminateJobObject(job, 14); });
bridge.start(); // 必须在 ResumeThread 之前。
// ... QA stdio 与模型测试 ...
bridge.stop(); // stop/join 完成后再关闭 Worker Job。
auto count = bridge.connections();
auto drained = bridge.tailDrains();
auto cancelled = bridge.tailDrainCancels();
```

构造期间一次性预建全部四个 maxInstances=4 句柄；第一例使用 FIRST 标志，其余三例在 Worker 恢复前填满容量。所有句柄保持到析构，连接结束通过 Disconnect 复用。每次只在 PID/SID 身份确认并 Revert 后连接预先固定的 `127.0.0.1:<HTTPS port>`。桥不解 TLS、不读取 lease/token、不解析 HTTP，也不接受 Worker 指定的目标。

每向使用 16 KiB 缓冲；上游 connect 与初始客户端读取限制 10 秒，流空闲限制 120 秒。I/O 使用独立 OVERLAPPED 事件，可由全局/连接停止事件取消并等待完成；socket 使用 1 秒系统 I/O 期限以支持线程回收。正常 EOF、TLS 证书拒绝产生的 reset/abort、Worker 关闭连接只结束当前连接并复用实例。身份错误、无法建立固定上游、未知 I/O 错误及超时触发一次失败回调。

上游正常 EOF 后，桥先用 `FlushFileBuffers` 确认已写入管道的尾部字节被客户端读完，再 Disconnect。仅完成 `WriteFile` 不代表客户端已经读取，直接 Disconnect 会丢弃未读数据。[Microsoft DisconnectNamedPipe 说明](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-disconnectnamedpipe)

排空最多等待 5 秒；全局停止、Worker 退出或客户端关闭会立即请求取消。专用同步 I/O 线程通过重复 `CancelSynchronousIo` 与线程句柄等待回收，取消期限为 3 秒，以覆盖取消发生于进入 Flush 之前的调度竞态。若仍未返回，先失败回调终止 Worker Job，再等待 1 秒；仍无法回收则终止 QA launcher，让 kill-on-close Job 关闭，不能 detach 悬空线程或无界 join。reset/abort 直接结束连接，不等待排空。`tailDrains()` 只统计 Flush 成功；`tailDrainCancels()` 记录取消请求，均不能证明模型语义成功。

`onFailure` 运行于 I/O 线程，只能通知控制线程或终止对应 Job；不能在回调内析构桥或调用 `stop()`。`connections()` 统计身份验证通过且已向固定上游发送初始字节的累计连接数，不能单独证明 TLS 或 HTTP 成功。

当前原生证据不等同于真实模型验收；远端客户端实际拒绝测试、完整安装生命周期与生产并发仍需后续覆盖。

## 真实 App Server 与合成模型集成结果

`target/central-p0/model-runtime-2/result.json` 的 7 组检查全部通过。该轮使用真实固定补丁 App Server、真实 AppContainer/Job 和四实例桥，但 HTTPS 模型上游及 Local Agent 均为合成 fixture，没有调用真实外部模型或设备。

- launcher SHA256：`2225c5cd828e75f0e75cd7eb6c4d43ef53bc47b72cdb2be75ecede7d67f95973`；App Server SHA256：`117549a4f5fde94b376ab4c1cdd821706030289362e0055e836c97cc973b986b`。
- 正例连接、TLS 成功、HTTP 请求均为 5 次；正常 EOF 排空成功 3 次，取消排空 0 次。两次最终回答各 131123 UTF-8 字节，SHA256 均为 `3e157658f075779322b7a9602415650f29d59bb50f945d1eae8401e27f20c14b`，与预期一致，覆盖超过单向缓冲大小的响应尾部。
- 内置系统工具与工作区 override 保持拒绝；合成动态工具完成往返。静默 SSE 中断后上游在 5 秒内关闭，随后新 Turn 完成，终态序列为 completed、interrupted、completed。
- 错 CA 负例有 1 次 native 连接，TLS 成功 0 次，HTTP 请求 0 次；Rust 返回类型化 `MODEL_PIPE_TLS_CERTIFICATE_REJECTED`。Node 仅观察通用握手失败，证书拒绝判据来自 Rust 类型链，而不是把连接 reset 当作证书错误。
- 正例及错 CA Worker 的 Job、AppContainer profile 和限定 TLS lease 均完成清理，stderr 均为 0 字节。

这条集成证据证明当前 P0 QA 接线及正常 EOF 排空路径可运行；仍保持 `realModelVerified=false`、`realDeviceVerified=false`、`deployable=false`。独立 native 探针的 maxInstances=1 范围保持不变。

## 排空取消的独立证据

`windows-pipe-flush-probe.cpp` 在同一宿主进程建立合成命名管道，先写入 32 KiB 数据并让客户端暂不读取，确认 Flush 处于等待。正常读取全部数据后 Flush 返回 0；两个已阻塞取消用例均观察到 `CancelSynchronousIo` 成功、Flush 返回 995，耗时约 109–110 毫秒；两个调用前取消用例返回 995，耗时 0 毫秒。此测试不创建 AppContainer、不连接模型、不改变网络配置。

证据为 `target/central-p0/pipe-flush-cancel-2/summary.json`，可归档记录为 `harness/verification/windows-pipe-flush-2026-09-10.json`。探针自身的异常路径也用有界取消 guard 保留 Flush 的上下文，防止合成读取失败时遗留引用栈内存的线程。本机编译与运行示例：

```bat
cl /nologo /std:c++17 /EHsc /W4 /MT harness\windows-pipe-flush-probe.cpp /Fe:target\central-p0\windows-pipe-flush-probe.exe /Fo:target\central-p0\windows-pipe-flush-probe.obj
target\central-p0\windows-pipe-flush-probe.exe C:\Workplace\central-codex-platform\target\central-p0\NEW_FLUSH_QA_RUN
```

该证据验证 Windows API 的成功排空与取消行为；桥的实际正常 EOF 路径由真实 App Server 加本地合成 HTTPS 模型服务单独验收。
