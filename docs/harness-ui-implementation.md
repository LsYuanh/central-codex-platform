# Harness UI 适配实施与验证（2026-09-09）

## 范围与基线

本轮在主代理同步的当前工作基线上修改 `spikes/local-dev/`，保留远舟页面、主题、附件、输出、多会话、运行中追加与任务计时。用户原项目及其安装配置未被本轮 UI 修改覆盖。Git 相对默认分支的完整 diff 含同步基线，不能把这些既有页面改动全算作本轮新增；基线来源见 `harness-baseline-2026-09-09.json`。

本轮 UI 新增/修改文件：

- `apps/desktop/src/gateway-ui-events.ts`：会话、消息、审批、连接、设备、文件保存、执行记录与能力类型；平台事件转换和纯执行 reducer。
- `apps/desktop/src/codexia-gateway-adapter.ts`：以 `subscribeUi` 为页面事件入口；实际客户端 diff 的请求及响应校验。
- `apps/desktop/src/platform-gateway-client.ts`：`device.workspace.git_diff` 映射、每次 initialize 的能力通知、旧 socket 消息防护。
- `apps/desktop/src/App.tsx`：消费 typed 平台事件，清理重复执行解析和日志裁剪；保留原生 Turn、历史恢复、追加、计时逻辑；显示执行阶段、真实 diff、部分补丁结果和单次补丁审批。
- `apps/desktop/src/WorkspacePanel.tsx`：原工作区面板内增加已暂存/未暂存实际 diff。没有复制 UI 或修改主题 CSS。
- `scripts/harness-ui-smoke.ts`：执行/审批/输出/能力/diff/部分修改事件回归。

## 状态语义

中央连接、设备在线、原生 Turn、客户端执行及文件保存保持独立。NativeTurnState 复用既有 TurnTimingStatus 投影，文件保存复用 OutputArtifact 状态，不新建第二套会话真相。开始事件只证明中央派发，UI 显示“已派发操作，等待本机确认”；stdout/stderr 证明客户端已产生输出。只有客户端最终结果可以确认成功、失败、取消或超时，停止请求本身不显示进程已退出。

`gateway/runtimeUnavailable` 独立表示中央引擎停止，不把仍在线的网关 socket 或设备改成离线。页面提示管理员重启网关、禁用发送/追加，活动 Turn 计时和执行结果标待核对；重连完成握手后才能恢复引擎可用状态。

重复开始不会清空日志，迟到开始/输出不会复活终态；完成先于开始也保留记录。网关或设备断线使活动执行进入结果未知，后续权威完成事件可核对；不自动重放命令或写操作。显式切换连接清理该连接的临时执行卡片。单卡日志限制 1 MiB，包含单个超大 Unicode 帧的裁剪。

`device/tool/completed` 支持 succeeded、failed、cancelled、timed_out、denied、offline、unknown 及 errorCode。补丁结果的 applied 路径/版本、failedPath、partial/unknown 和非整体事务语义在卡片显示。结果未知没有自动重试按钮。

设备、执行、输出、能力及审批解析已集中；App Server 原生消息/Turn 历史的现有兼容处理仍在页面和既有历史模块中，未宣称 P1 的全部协议拆分已完成。

## 能力与 diff 契约

`session.initialize` 的 `result.platformCapabilities` 经适配器转换，重连也更新。remoteWorkspace=true 才开放客户端 diff；imageGeneration/plugins/subagents=false 在工作区明确说明暂不可用。缺能力声明的旧网关不会假定支持。旧输出查看和保存保留。

`workspaceDiff(path, staged)` 发往 `device.workspace.git_diff`，使用既有 `{ok,result,errorCode,error}` 响应。只接受 `source:'client'`、`format:'git-unified-diff'`、exitCode=0、实际 repositoryRoot、stdout/stderr、staged/truncated 字段。显示来源设备工作区、暂存范围及截断提示；不包含 Git 未跟踪文件。查询失败有错误状态，网络请求有 60 秒上限；切换设备、工作区或离线会使旧请求结果失效。

同样结构的动态工具完成结果可直接显示在对应执行卡片，页面不拿模型描述替代实际 diff。结构验证依赖网关/Agent 的来源边界，不构成独立密码学来源证明。

`device/fileChange/requestApproval` 仅提供允许一次/拒绝/取消，隐藏“本会话允许”，保留目标设备、工作区、完整补丁和 expectedVersions；明确执行前重新核对版本。原生 `item/tool/requestUserInput` 与审批 resolved 事件继续可用。

## 已执行验证

在 `spikes/local-dev/`：

| 命令/场景 | 结果 |
|---|---|
| `npm run check --workspace @central-codex-spike/desktop` | 通过 |
| `npm run build --workspace @central-codex-spike/desktop` | TypeScript + Vite 通过 |
| `node --no-warnings --experimental-strip-types scripts/harness-ui-smoke.ts` | HARNESS_UI_SMOKE_OK |
| `npm run history:smoke` | 历史消息、附件、输出恢复通过 |
| `npm run multi-session:smoke` | 多会话隔离通过 |
| `npm run steering:smoke` | 追加、超时、停止、历史核对通过 |
| `node --no-warnings --experimental-strip-types scripts/turn-timing-smoke.ts` | 实時計时、重放、后台隔离、重启、离线、停止通过 |
| 隔离浏览器 127.0.0.1:1429，目标中央 4529 未运行 | 连接错误与重试入口明确；本机设备离线；工作区读取/命令/diff 禁用；实际页面布局已查看 |

## 原生与真实链路验收记录

Computer-use 初始化和 `sky.list_windows()` 成功，未操作现有安装版。隔离桌面使用 TAURI_CONFIG 覆盖标识 `com.centralcodex.harnessqa20260909`、窗口标题“远舟 Harness QA 20260909”、devUrl `http://127.0.0.1:1429`，构建目录 `target/harness-agent`。产品 tauri.conf.json 不修改。隔离工作区是 `target/harness-qa-workspace`，与模型可写的实际产品仓库分开。

隔离 `cargo build -p desktop-spike --target-dir target/harness-agent` 通过（2m44s）。初次 sandbox 启动报 `tauri-2.11.5/src/app.rs:1425 Failed to setup app: 拒绝访问 (os error 5)`；仅对独立 QA 程序进行受控提升后启动成功。窗口标题及进程路径证实是隔离构建；首屏、连接设置、目标 4529、测试用户/设备与 fixture 工作区均经原生截图核对。

首次原生“保存并应用”点击被自动审批拒绝，随后用户明确批准指定 4529、用户 `harness-qa-20260909`、设备 `harness-windows-qa` 及独立 fixture 的保存/启动/关闭验证，才重新执行。保存成功且原生页面显示已连接、设备在线；桌面 PID 9684、Agent PID 22508，4529 健康 clients/devices 从 0/0 到 1/1。真实目录读取返回 fixture 的 7 个条目，能力限制说明正确显示。

首次实际 diff 读取触发 `COMMAND_TIMEOUT`（15 秒），原生 `git --version` 亦挂起，UI 请求在 60 秒后明确显示失败。源码诊断确认子命令继承了 Tauri→Agent 附件 IPC stdin；独立 Agent 的既有 smoke 未覆盖该启动形态。QA 窗口 Alt+F4 关闭后，桌面/Agent 及两个 Git PID 9684/22508/23856/23324 均已退出，4529 clients/devices 恢复 0/0。Agent 已补 `stdin(Stdio::null())` 和 Windows `CREATE_NO_WINDOW`，并通过保留附件 IPC 的 15 项真实 Agent smoke。最终 Agent SHA-256 为 `C4BE11300009B7FF5597CFECFA35D24947BDAE2A407254BB694D79FCF0DA9C31`。

最终原生复测使用桌面 PID 19348 / Agent PID 22432；已保存配置自动恢复，中央与设备在线，4529 clients/devices 为 1/1。页面 `git --version` 快速返回 exitCode 0、`git version 2.55.0.windows.3`。原 fixture 的 diff 随后返回明确失败；实际 Agent 的 `git_status` / `rev-parse` 查明是 `dubious ownership`：sandbox 初始化仓库的所有者为 `EXAMPLE-PC\CodexSandboxOffline`，原生 Agent 身份为 `EXAMPLE-PC\developer`。这是测试环境身份差异，没有放宽全局 safe.directory 或产品工作区边界。

通过真实 Agent 在 QA 根内创建 `native-owner-1788930308099` 子仓库，根及 `.git` 的所有者均为实际用户 `EXAMPLE-PC\developer`。原生页面只切换相对路径，没有改写已批准的工作区根配置。点击“读取实际 diff”后，页面显示本机子仓库完整路径、未暂存范围和真实 `marker.txt` diff，包含 `+NATIVE_CLIENT_DIFF_VERIFIED`；同页保留成功的 git 版本结果，原生截图已核对。

最后 Alt+F4 关闭 QA 后，`Get-Process -Name desktop-spike,local-agent,git` 无输出，4529 健康检查为 clients=0/devices=0、enforcedRuntimeReady=true、sequence=416。本轮 Vite PID 22124 已停止。正式安装配置 `com.centralcodex.localspike/desktop-runtime-v1.json` 的最终 SHA-256 仍为 `4FD301EFADF939BF2E24E8E1B821C97461325C6529BE454FF7ED73A5C85FB178`，与验收前一致；正式 4510 服务及安装器未变更。

主代理另以最终 Agent binary、`--attachment-stdio` 和真实中央 4529 完成 8 项模型闭环，Thread `01a08488-4163-7d20-bb1d-c9ca0aa968d4` 已归档，结果见主交付记录与 central-qa manifest。本 UI 验收没有重复运行模型，也未运行 Fake Central 冒充真实链路。QA fixture 均保留在 `target/harness-qa-workspace`；原始独立 Git 初始提交 `cb03385` 与后续同用户子仓库用于保留复现证据，属于不提交的测试产物。

## P4 执行中关闭：Windows Job 进程树回归

P4 故障矩阵发现强制结束 Agent 时命令后代可能遗留，Agent 随后新增 Windows Job 的 kill-on-close 约束。使用修复后 Agent SHA-256 `3CCF62FD08A79EBE0B35ACC7186BC86556E381E2275200C492AB75908571C0E8`，复用已有独立原生 QA binary、配置和 Vite 1429；未重建 UI，也未改产品安装配置。

本次用户明确批准执行中关闭回归。确认其他测试 Agent/Cargo 退出后启动单个隔离窗口，原生页面显示中央和设备在线，4529 clients/devices=1/1。使用同一 QA 用户/设备的独立测试 WebSocket，经真实网关 `device.exec` 派发 Node 父子孙任务；不新增模型 Turn。任务只在 `target/harness-qa-workspace/native-close-0f4c373e-a7b7-4b1e-b9e1-5ea052306f26` 内写 PID 证据，并计划在 30 秒后写完成标记。

实际进程树为桌面 19500 → Agent 15876 → Node 父进程 18532 → 子进程 21148 → 孙进程 20876。确认三代命令进程同时存活后，对标题为“远舟 Harness QA 20260909”的确切原生窗口执行 Alt+F4。全部五个 PID 均退出；probe 等待至任务开始后 32 秒，确认三个 `.finished` 标记均不存在，返回 `NATIVE_EXECUTING_CLOSE_OK`、exit 0。网关返回 `AGENT_DISCONNECTED`、`retryable:false` 和明确结果未知，没有伪报任务成功。

关闭后 4529 clients/devices=0/0、enforcedRuntimeReady=true、sequence=518，正式配置 SHA-256 仍为 `4FD301EFADF939BF2E24E8E1B821C97461325C6529BE454FF7ED73A5C85FB178`。本次 Vite 24396 已停止。证据保留在 `target/harness-ui-runtime/executing-close-ready.json`、`executing-close-result.json` 与专属 fixture 内，不提交临时脚本/产物。

准备阶段的绝对 cwd 请求被严格工作区协议以 `WORKSPACE_PATH_DENIED` 拒绝，未启动命令；probe 更正为协议要求的相对 `cwd:'.'` 后才进行上述有效回归。未通过放宽产品路径规则修饰测试结果。

## 回退

回退 UI 时仅撤销上述本轮新增适配和面板修改，保留同步来的用户页面基线。数据格式没有不可逆迁移；Thread/附件/输出存储继续使用既有格式。可恢复旧 UI 显示行为，但不得由 UI 回退重新启用中央执行、未审查插件或跳过客户端审批。QA 临时构建、WebView 数据和日志位于隔离标识/target 范围，不提交。
