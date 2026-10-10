# Windows P0 网络观察探针

> 公开副本已脱敏：文中的示例主机、用户目录和私有部署路径不是可直接执行的现场配置；原始记录由维护者私有保管。测试结论与未验收项保持原意。

`windows-network-probe.cpp` 和 `windows-network-smoke.mjs` 仅用于 QA，不接入正式 Worker。每个目标先由宿主连接并验证合成 TCP echo，再由一次性 AppContainer 连接同一个数字 IP 和端口。受限进程的 token 必须为 AppContainer、capability 数量为 0；Job 配置 kill-on-close 与活动进程上限 1。只授予新建 QA 树的权限，不改祖先 ACL、防火墙、网络 capability 或 loopback exemption。

宿主发送 ASCII `HOST_BASELINE_NETWORK_QA`，受限进程若连通则发送 `APPCONTAINER_NETWORK_QA`，均无换行。服务端原样回显。网络探针只接受 IPv4/IPv6 数字地址，未测试 DNS、UDP、任意互联网目标或所有网络接口。

## 判据

- `observationComplete` 只表示基线、受限测试、子进程退出与 profile 清理完成。
- `connectionPermissionDenied` 仅在 Winsock 最终错误为 `WSAEACCES`（10013）时为 true；10035 是非阻塞连接初始状态，10060 是等待超时，都不能算权限拒绝。
- 同一调用者上下文调用 `NetworkIsolationDiagnoseConnectFailureAndGetInfo`，独立保存 API 返回码和 `NETISO_ERROR_TYPE`。API 成功且类型为 1/2/3 才记录缺少能力；返回 NONE 不证明连接获准，也不证明被策略阻断。
- `tcpCasesQualified` 只覆盖实际测试的 TCP 目标，并要求明确权限拒绝及无意外连接。即使为 true，也不会自动把 `fullNetworkIsolationQualified` 或 `deployable` 改为 true。

Microsoft 说明该诊断 API 可识别缺少的网络 capability，类型 1、2、3 分别对应 privateNetworkClientServer、internetClient、internetClientServer。[诊断 API](https://learn.microsoft.com/en-us/windows/win32/api/networkisolation/nf-networkisolation-networkisolationdiagnoseconnectfailureandgetinfo)、[类型定义](https://learn.microsoft.com/en-us/windows/win32/api/networkisolation/ne-networkisolation-netiso_error_type)

## 本机结果

`target/central-p0/network-2/result.json`：IPv4 `127.0.0.1` 与 IPv6 `::1` 的宿主连接及 echo 均成功；两次受限连接在 5 秒后得到 10060。两次诊断均返回 API 0、类型 NONE 0；服务端各观察到一次宿主消息、零次受限进程消息。子进程退出及两个一次性 profile 清理完成。因此观察完成，但 TCP 策略拒绝仍未资格通过。

`target/central-p0/network-3/result.json` 增加受控 Mac echo `192.0.2.10:64372`，宿主真实 echo 成功，连接耗时 16 毫秒。AppContainer 连接初始错误为 10035，完成错误为 10013（WSAEACCES）；诊断 API 返回 0，类型为 2（缺少 internetClient）。因此该 LAN IPv4 TCP 目标有明确权限拒绝及 capability 诊断证据。不能因地址属于 LAN 就把诊断类型改写为 privateNetworkClientServer。本轮三个 Worker 均退出、三个 profile 均清理。

同轮两个 loopback 目标仍为 10060、诊断 NONE；所以整体 `tcpCasesQualified=false`、`fullNetworkIsolationQualified=false`。LAN echo 由协调任务通过开发诊断通道单独启动，远端接收及停止记录由协调任务归档；不是正式产品执行链路。

额外只读调用 `FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, ...)` 返回 50（ERROR_NOT_SUPPORTED），本轮无法读取已有 WFP 事件。没有调用 SetOption、添加规则或启用额外系统审计。[WFP 事件枚举说明](https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmneteventenum5)

第一次 `network-1` 在受限进程创建阶段失败 203，未执行受限网络测试，profile 已清理。随后补齐与既有隔离探针一致的显式环境白名单，没有放宽 AppContainer 或 Job 设置。

## 构建与运行

以下 MSVC 路径是本机示例。先加载 x64 开发环境，工作目录为 `.`：

```bat
call C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat
cl /nologo /std:c++17 /EHsc /W4 /MT harness\windows-network-probe.cpp /Fe:target\central-p0\windows-network-probe.exe /Fo:target\central-p0\windows-network-probe.obj
node harness\windows-network-smoke.mjs --probe C:\Workplace\central-codex-platform\target\central-p0\windows-network-probe.exe --output C:\Workplace\central-codex-platform\target\central-p0\NEW_NETWORK_QA_RUN
```

目录必须全新，父目录已存在且没有重解析路径。创建 AppContainer 需要从工具的宿主执行上下文运行；这不等于申请 Windows 管理员权限。默认只绑定本机随机 loopback 端口。受控 LAN echo 已由开发人员单独启动后，可追加 `--lan-ip <数字IP> --lan-port <随机端口>`；不能把现有生产服务当成 echo。远程 echo 的启动和关闭由协调方记录，4510 不参与测试。
