<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

## 2026-09-20：复用中央原始 Codex 登录（未发布）

“模型接入”新增推荐入口“复用本机 Codex 登录”。中央仅保存账号关联，由受管官方 Codex 认证进程刷新原始登录，再将最新访问令牌热更新到网关；无需保持 Codex 桌面程序运行。独立设备登录及旧副本导入归入“其他登录方式”。Windows/macOS 原生测试、真实中央现有登录认证、网关热更新和 Windows Tauri 入口检查通过。未强制轮换真实有效令牌，未更新正式服务。使用限制及验收范围见[共享登录与受管认证](../../docs/中央复用Codex登录与受管认证-2026-09-20.md)。

## 2026-09-20：中央专用登录与独立自动续期（未发布）

中央管理 App 新增设备代码专用登录。首次授权并启动受管服务后，原生后台主动续期并热更新网关中的访问令牌，无需保持 Codex 桌面程序运行；旧的本机登录导入仍是不会自动续期的副本。授权撤销和不确定轮换显示重新授权状态，临时网络错误有限重试，不自动重发模型任务。Windows/macOS 原生与网关协议检查通过，新增 Tauri 页面和真实上游授权仍待验收。本次未打包或替换正式服务。使用、存储、运行包兼容及完整验收边界见[独立自动续期说明](../../docs/中央模型独立自动续期-2026-09-20.md)。

## 2026-09-14：执行过程紧凑展示

客户端执行明细现在默认折叠，运行时仅显示一行状态摘要，完成后通过用时入口展开。思考摘要、进度说明和执行明细统一折叠，保留用时下方分割线、最终结果和必要提示，去掉匹配的重复工具通知。Windows/macOS 安装包已重建，本机已升级并实测原历史对话。详见[实施与验收](../../docs/执行过程紧凑展示-2026-09-14.md)。

## 2026-09-14：本机自由文件访问

经用户确认，客户端配置目录改为默认输出目录，不再限制文件访问范围。工具接受本机绝对路径及相对路径，生成文件未指定目的地时保存到该目录。网关按设备能力兼容：具有 `client-paths/v1` 的新版使用自由路径及默认输出目录；缺少该能力、但支持既有 `remote-workspace/v1` 与设备身份的旧版可继续在原工作目录内对话、读写和执行命令，不必升级。旧版输出沿用其原有默认位置。中央推理、客户端执行的架构不变。此前工作区沙箱/下载目录默认输出说明为历史行为，以[本次实施与验收](../../docs/客户端自由文件访问与默认输出目录-2026-09-14.md)为准。


## 中央管理开发版（2026-09-11 更新）

Windows 最新测试包统一了配对、授权检查及桌面/Agent WSS 的 Rustls 实现，并提供证书与网络分类错误码，用于排查旧 Windows 配对成功后连接失败。凭据格式不变，保留此前全部修复。16 组原生 TLS、27 项安全库、19 项 Agent 与正式桌面模型/工具验收通过；用户 Windows 8.1 现场尚待复测。安装包见[TLS 统一与旧 Windows 连接验收](../../docs/客户端TLS统一与旧Windows连接验收-2026-09-11.md)。

Windows 客户端最新包已修复执行中及完成后多层滚动和输入框遮挡：执行记录进入对话滚动区，结束后默认折叠。真实模型与 Local Agent 长日志、三种窗口尺寸的运行/完成状态及手动展开共 7 组检查通过。安装包见[执行记录布局修复与验收](../../docs/客户端执行记录布局修复与验收-2026-09-11.md)，包含此前配对、无终端及首次发送修复。

Windows 客户端最新测试包已修复首次发送携带旧 `serviceName` 被网关拒绝的问题，保留一体配对和无终端启动。实际 Tauri 页面 GPT-5.6-Sol/high 新建对话、首条发送与后续回复通过；交付包与复现入口见[首次发送修复与验收](../../docs/客户端首次发送serviceName修复与验收-2026-09-11.md)。

最新客户端已支持“一体配对码”：中央端生成并复制，客户端只需粘贴并点击“配对并连接”，自动处理地址、公共 CA 和设备名，保留当前工作区。中央 Mac 已更新，Windows 和 Apple Silicon 客户端测试安装包已生成，真实 Windows Tauri 配对、设备重连及正式模型链路通过。步骤、安装包和验收边界见[客户端一体配对码实施与验收](../../docs/客户端一体配对码实施与验收-2026-09-11.md)。下文手工导入 CA 仅适用于旧版或高级配置。

Mac Apple Silicon 中央 App 已构建、安装，并经用户批准将正式 `192.0.2.10:4510` 切换到 App 管理的 **WSS＋平台登录**。Windows 原生设备配对、Local Agent 重启重连、真实模型读取/命令、设备撤销及 Mac App 退出重启通过。旧 WS 客户端须重新配置 CA 与配对；旧历史保留原目录/备份，尚未映射新账号。测试 DMG、管理员密码文件位置、Mac 构建入口与回退方法见 [macOS 打包与正式迁移验收](../../docs/中央管理App-macOS打包与正式4510迁移验收-2026-09-11.md)。当前仍为 ad-hoc 签名 Debug 测试包，Mac 逐页视觉验收待本地测试。以下“正式 4510 未切换”记录均为此前批次状态。

独立 Windows 安装验收版已完成初装、同版覆盖、0.1.0 → 0.1.1 升级、运行中安装/卸载阻断、静默降级拒绝及卸载重装数据保留。实际安装版的诊断版本、合成账号恢复、完整网关启动和窗口退出清理通过。打包入口为 `node scripts/package-central-qa.mjs --version 0.1.0` 或 `0.1.1`；只读实装校验为 `node scripts/verify-central-qa-installed.mjs --build <成功构建目录的绝对路径>`。脚本不自动安装或启动，QA 身份及安装目录固定；仍为未签名 Debug 候选。限制与完整证据见[Windows 安装与升级验收](../../docs/中央管理App-Windows安装与升级验收-2026-09-11.md)。

“设置与诊断”已增加当前受管服务故障与恢复建议、已保存并发设置、诊断 JSON 预览与本机导出。报告按采集时点展示，手动刷新；不含目录、连接地址、账号凭据、用户设备标识或完整日志。保存时重新采集并拒绝覆盖已有文件，取消不写入。说明及验收见[设置与诊断交接](../../docs/中央管理App-设置与诊断-2026-09-10.md)。

现有 `apps/central` 已接通 Windows 账号检测/DPAPI 导入、完整候选包核验、首次管理员设置、原生服务启停及用户与设备管理。开发入口 `npm run dev:central-app`；候选资源需要按内置清单准备，Release 仍拒绝未取得正式资格的包。运行方式见[账号与服务启停交接](../../docs/中央管理App-账号与服务启停-2026-09-10.md)，最新管理流程见[用户与设备管理交接](../../docs/中央管理App-用户与设备管理-2026-09-10.md)。

在运行概览启动验证服务后，进入“用户与设备”，使用首次启动时设置的平台管理员登录；新建配对专用用户，再生成限时一次性配对码。设备列表显示已认证 Local Agent 的在线状态和本次网关运行期间最近活动。停用用户或撤销设备前页面会明确目标及影响。管理员令牌只保留在原生内存，配对码只显示在页面内存；停止服务或退出管理员会清除会话。请求超时后须刷新核对，不会自动重发修改。

管理回归：`node scripts/central-people-gateway-smoke.mjs`。完整原生管理链路验证需先 staging 内置候选包，设置 `CENTRAL_SERVICE_QA_RESOURCES` 为本目录的绝对 `target` 路径，再运行 `cargo test -p central-app --offline native_owned_gateway_people_tls_auth_mutations_and_refresh_qa -- --ignored --nocapture`。该测试使用临时合成账号、证书和设备，不调用真实模型。

当前原生管理入口已完成真实模型与同机 Local Agent 验收：2 次模型读取、1 次客户端命令，设备撤销、Agent 退出和临时凭据清理通过；登录后 Tauri 列表、选择、确认框与取消交互也已实测。复现需先构建 `platform-security --example central-live-client` 和 `local-agent`；真实模型测试必须显式 opt-in，并指定一个尚不存在的 run 目录下的 `result.json`。完整命令、权限上下文、失败记录和覆盖边界见[真实链路与登录后界面验收](../../docs/中央管理App-真实链路与登录后界面验收-2026-09-10.md)。本轮没有更新正式中央服务。

下方中央 App 首版段落保留开发历史；完成状态以本节及最新交接为准。

运行概览现已展示受管网关的在线设备、活动任务及用户 Worker 实时统计，每 2 秒刷新。统计过期或读取失败时隐藏数字并提供恢复状态；服务停止且清理确认后显示零。真实模型与同机 Local Agent 已验证空闲、活动、完成和撤销后的指标变化。需使用完整候选 `windows-x64-node24-qa1-74b3e6f43896219f`；旧包不发送统计。检查入口为 `node scripts/central-overview-metrics-smoke.mjs` 与 `node scripts/central-service-host-smoke.mjs --metrics-only`，口径、状态和验收边界见[运行概览指标与验收](../../docs/中央管理App-运行概览指标与验收-2026-09-10.md)。

# 本地纵向技术 Spike

## 中央管理 App 开发交接（2026-09-10）

用户已确认开发独立中央管理 App，Windows 和 macOS 均须能实际作为中央端。
第一版目标涵盖首次配置、服务启停、用户与设备、模型管理及诊断。现有 `apps/central` 提供独立 Tauri 窗口、运行概览、三步配置、原生预备配置和资源检查。服务启停、账号接入和正式安装包尚未完成。
最新 Windows 更新：网关已接入显式原生 Worker 候选模式、原生凭据读取及限时停止流程，真实初始化、双用户进程与目录、同用户重启和退出检查通过。独立 Node 网关候选资源可附带 Host/App Server/helper；仍未取得中央 App 启动或正式分发资格。构建、参数和验收边界见 [Windows Worker 与网关候选包](../../docs/中央管理App-Windows-Worker与网关候选包-2026-09-10.md)。
后续更新：Windows 已接通非秘密预备配置的原生校验、原子保存、版本冲突保护、重启恢复与六项基础运行检查；尚未应用为实际运行服务配置。macOS 原生保存暂不可用。详见 [原生配置与检查验收](../../docs/中央管理App-原生配置与检查验收-2026-09-10.md)。
开发范围、代码入口、Windows Worker 隔离缺口及分阶段验收见
[中央管理 App 开发交接与后续计划](../../docs/中央管理App开发交接与后续计划-2026-09-10.md)。
本批配置、管理身份、启停状态与接口边界见
[P0 接口与运行设计](../../docs/中央管理App-P0接口与运行设计-2026-09-10.md)。

中央 UI 开发入口（在本目录运行）：

```powershell
npm run dev:central-app
# 仅浏览器预览，127.0.0.1:1422
npm run dev:central-ui
npm run build --workspace @central-codex-spike/central
node --no-warnings --experimental-strip-types scripts/central-ui-draft-smoke.ts
node --no-warnings --experimental-strip-types scripts/central-ui-management-smoke.ts
cargo test -p central-app --offline
```

两种开发入口择一运行，避免争用 1422。原有 `dev:central` 仍用于网关与工作客户端联合开发。
中央 App 仅管理安装它的本机；本版不会连接现有正式中央、启动 Local Agent 或读取模型登录。
草稿使用独立本地存储键 `yuanzhou.central.setup-draft.v1`，不含凭据，浏览器与桌面分别保存；它不是正式生效配置。
Windows 桌面 App 在第三步提供“保存本机配置”：原生存储位于应用数据目录 `config/central-config.json`，中央数据默认位于独立 `central-data` 子目录。保存不会创建用户库、读取登录或启动服务。
第三步现可选择受信清单中的候选运行包、核验实际文件，并通过原生目录选择器导入服务器证书。证书包由 Windows DPAPI 加密保存，普通配置仅保存资源 ID；列表与启动前检查均重新验证证书。候选包缺少完整网关与正式 Windows Worker，文件哈希通过仍不能启动。验收使用独立 QA 应用标识，正常应用没有写入测试配置。
可选资源打包流程、证书格式及最新验证见 [运行资源与证书接入](../../docs/中央管理App-运行资源与证书接入-2026-09-10.md)。
实际界面与验证边界见 [中央管理 UI 首版记录](../../docs/中央管理App-UI首版与验收-2026-09-10.md)。

认证工作最新检查点：RC3 双平台真实链路、Windows RC4 重新配对和撤销终态通过；
Mac RC4 仍待具体源码包上传批准及最终验收，上一轮结束时 4529 已停止，正式 4510 未更新。
下方早期阶段条目保留为历史说明，具体完成状态以
[简化设备认证验收记录](../../docs/简化设备认证实施与验收-2026-09-09.md)为准。

## 简化设备认证（RC3/Windows RC4 已验收，未正式发布）

2026-09-09 用户确认改为 HTTPS/WSS + 管理员一次性配对码 + 可撤销设备令牌。
现有客户端设置页使用配对码和本机名称，不再要求平台账号密码或设备证书续期；
服务端 CA 与主机名验证保留。Windows 使用当前用户 DPAPI + ACL，macOS 实现使用
当前用户 `0700/0600` 私有文件（内容未加密），不依赖 Keychain。
中央管理员负责发码和设备管理，设备令牌本身没有管理员权限。

默认切换经用户明确批准；模块检查、RC3 双平台真实 4529 链路，以及 Windows RC4
重新配对、撤销终态和实际 Tauri 页面已有验收记录。Mac RC4、新认证安装/升级/回退仍待完成，
正式 4510 未切换，候选仍为 `deployable=false`。旧 Mac Keychain/mTLS 验收由新方向取代，
下文旧批次保留历史，不能代替新候选验收。旧设备需重新配对，历史执行绑定不自动迁移；
Windows 中央 Worker 隔离仍为后续工作。详见
[简化设备认证实施与验收](../../docs/简化设备认证实施与验收-2026-09-09.md)。

## 设备证书与 mTLS（P5 第四批历史方案，未发布）

以下记录适用于原 mTLS 方案，不是上述已批准的新默认方案。

真实平台认证模式新增必填 `PLATFORM_DEVICE_CA_CONFIG`，指向中央设备 CA 配置。
管理员在中央机执行 `node scripts/device-ca-init.mjs --directory /绝对路径/新的私有目录`，
将输出的配置路径交给网关；目录必须不存在，且必须位于 Worker 根目录之外。
此 CA 专用于设备认证，HTTPS 服务端证书仍使用 `PLATFORM_TLS_CERT` / `PLATFORM_TLS_KEY`。
默认设备证书有效 7 天，提前 1 天由 Agent 自动续期；CA 自身有效 1 年，需要管理员另行轮换。

客户端配对时本机生成 RSA-2048 TLS 私钥，独立存于系统凭据库；中央只收到公钥。
Agent 的 WSS 接入同时校验设备签名票据和 mTLS 证书。登录、初次配对和 UI 接口仍可
在没有设备证书时访问，以便恢复账号和重新配对；它们不能代替 Agent 证书检查。
续期通过 mTLS 认证并只延长相同设备和平台会话的已连接 Agent 授权，不中断执行中的命令。
未续期的证书到期或设备被吊销时，现有设备连接关闭并取消客户端命令。
过期、吊销和缺失证书会在原有设置页显示，重新使用需显式配对。

旧配对身份不会自动获得证书；切换至本版前要准备 CA 并重新配对。旧历史的设备绑定
不会因重新配对而绕过，跨设备恢复仍遵守原有工作区边界。
自动恢复旧设备对话被拒绝时，客户端保留正常中央连接，显示明确提示并允许新对话。
只有明确声明且监听 loopback 的协议 fixture 可省略 CA；真实中央无降级开关。
本批开发验收入口是 `qa-control.mjs start-mtls`，只使用 4529 和新的第四批 QA 数据目录。
本批验收记录见[设备证书与 mTLS 生命周期](../../docs/设备证书与mTLS生命周期-2026-09-09.md)。

## 开源 Harness 隔离改造（2026-09-09，未发布）

当前源码中央网关要求固定 Codex `rust-v0.153.4` 的远端工作区补丁，初始化缺少
`yuan-zhou-remote-workspace/1` 标识时明确拒绝；不回退到中央本机执行。
准备/构建脚本位于 `harness/`，正式 4510 服务未替换。新 Agent 需要声明
`remote-workspace/v1` 和 canonical workspaceRoot；Thread 绑定设备安装 key/工作区，
同名设备或工作区变化不能续接执行。原生图片生成、插件、子代理暂未适配，UI 明示不可用。

客户端支持项目规则、分页搜索/读取、Codex 格式补丁预检与单次审批、实际 Git diff。
审批后重新核验文件 SHA-256；多文件部分失败、断线及未知结果不得自动重放。
`npm run harness:check` 验证 UI/协议；`npm run harness:workspace-smoke` 使用独立构建的
真实 Windows Agent（默认 `target/harness-agent/debug/local-agent.exe`）。这些测试不替代
中央模型真实闭环。实施、版本、验证缺口与回退见
[Harness 实施与验收](../../docs/Harness实施与验收-2026-09-09.md)。

P4 补充：Windows Agent 使用进程 Job，强制退出也会清理命令后代；网关状态原子写入，
坏状态拒绝启动、写入失败停止推理。共享只读登录禁用刷新/撤销请求，过期明确报错并由
凭据所有者更新。重启保留历史与提交幂等记录，中断任务不会自动重放。
旧历史/附件、审批冲突、断线和真实重启证据及测试命令见
[P4 兼容与故障验收](../../docs/Harness-P4兼容与故障验收-2026-09-09.md)。

## 平台登录与设备身份（P5 第一批，未发布）

网关设置 `PLATFORM_AUTH_FILE` 后启用平台账号、设备配对和吊销，并要求
`PLATFORM_TLS_CERT` / `PLATFORM_TLS_KEY`；该模式仅提供 HTTPS/WSS，拒绝 URL 的
`userId` 冒用与未验证 Agent，关闭所有测试控制入口。首次管理员用
`node scripts/platform-auth-bootstrap.mjs` 离线建立：通过 stdin 提交 JSON 的
`username` / `password`，密码不放在命令参数、环境变量或仓库文件中。
已有身份库的账号管理使用认证的 `/auth/admin/user/create` 等 API。

桌面设置填写 `wss://中央地址:端口/ws` 后显示平台登录；登录、配对，再保存工作区配置。
用户/设备 ID 由服务端分配且不可编辑。私有 CA 只配置管理员提供的 PEM 公共证书路径，
不得关闭证书或主机名校验；公开受信任证书无需额外设置。访问/刷新令牌和设备私钥保存在
原生系统凭据库；设备签名在 Agent 执行，客户端仍只主动出站连接。

验证：`node scripts/platform-auth-smoke.mjs` 和 `node scripts/platform-auth-live-smoke.mjs`。
后者需要 Windows 原生 QA 工具和 OpenSSL，在独立临时目录进行 TLS/双 Agent 检查。
真实中央、原生页面、配置保留及边界见
[平台登录与设备身份实施](../../docs/平台登录与设备身份实施-2026-09-09.md)。
本批不代表完整 P5：Worker 操作系统隔离、正式模型凭据策略、mTLS 证书签发与更新、发布安装升级仍需后续验收。

## 按用户 Worker 与持久审计（P5 第二批，未发布）

启用平台认证后，每用户懒启动独立 App Server，使用独立 `CODEX_HOME` 和运行目录。
默认最多 8 个 Worker、每用户 2 个活动 Turn、全局 8 个活动 Turn；超额明确拒绝。
一个 Worker 崩溃仅影响其所属用户；重新连接后可恢复原目录中的历史，未完成操作不自动重发。
故障时在连接设置中断开后重新连接，再恢复对话核对结果。空闲 5 分钟且无任务/RPC 时回收 Worker。

`PLATFORM_WORKER_ROOT` 指定用户运行数据根目录；`PLATFORM_AUDIT_DIR` 指定持久审计目录，
认证模式下默认启用分段日志。损坏日志拒绝启动，写入失败停止执行；部署须保证单网关写者。
管理员认证后可读取 `/workers` 与 `/audit`，后者返回最近 1000 项，完整历史留在中央审计目录。
旧共享 Worker 历史需要显式迁移；发现缺少 `workerLayout=per-user/v1` 的既有 Thread 时拒绝启动，
不会悄悄切到空用户目录。正式 4510 尚未切换。

验证：构建网关后运行 `npm run workers:smoke`、`node scripts/worker-routing-smoke.mjs`。
真实中央专项复用 `platform-auth-live-smoke.mjs`，设置 `PLATFORM_QA_CENTRAL=1` 和
`PLATFORM_WORKER_QA=1`；该开发探针只控制指定 4529 QA 环境。
配置、14 项真实中央验收与边界详见[按用户 Worker 管理实施与验收](../../docs/按用户Worker管理实施与验收-2026-09-09.md)。

## Worker 权限与模型凭据隔离（P5 第三批，未发布）

> P5 第三批更新：当前认证网关强制使用中央模型凭据代理及 macOS Worker 沙箱，
> 除身份/TLS 配置外还要求 `PLATFORM_MODEL_BINDINGS`、`PLATFORM_WORKER_BINARY` 与
> `PLATFORM_WORKER_BINARY_SHA256`。旧共享 auth/config 需显式迁移，不会直接续用。
> Worker 只接收按用户撤销的代理令牌，真实模型凭据留在中央网关；缺失、停用与过期有明确错误。
> 中央运维用 `node scripts/model-access-configure.mjs` 经 stdin 配置用户绑定，模型凭据不能放入 Worker 目录。
> 本机 Node 协议夹具须明确设置 `PLATFORM_WORKER_ISOLATION=protocol-fixture`，只允许回环监听；
> 该模式不提供真实 Worker 隔离验收。验证命令：`node scripts/model-credential-broker-smoke.mjs`，
> 中央实际 syscall 验证：`node harness/worker-isolation-smoke.mjs`。
> 当前进度、配置和验收边界见 [Worker 权限与模型凭据隔离](../../docs/Worker权限与模型凭据隔离-2026-09-09.md)。

## 运行中追加要求（2026-09-07）

中央网关模式下，当前 Turn 运行时可以继续输入文字，按 Enter 或点击“追加要求”；
独立的“停止当前任务”按钮始终保留。每条追加显示发送中、已接收、失败或待核对。
前一条接收后即可发送下一条；首版不支持追加图片/文件，模型与推理设置供下一轮使用。
追加影响后续行为，正在生成的内容或执行中的命令可能先完成；不会撤销已完成的修改。

平台操作 `conversation.turn.steer` 携带 `threadId`、`expectedTurnId`、`clientMessageId` 和文字
`input`，网关校验所属用户/设备，复用提交记录去重，再调用中央 `turn/steer`。
仅在上游明确拒绝“无活动 Turn”、历史确认目标轮正常完成、当前无活动轮且未请求停止时，
自动用同一消息 ID 发起下一轮。超时、断线、Turn 不匹配和已停止均不会自动重发。
历史按消息标识精确匹配，流式助手消息按 item ID 更新；追加失败不清除原 Turn 的运行状态。

验证命令：`npm run steering:smoke`、`npm run steering:gateway-smoke`。
真实验收需显式设置 `STEERING_GATEWAY_URL` 后运行 `node scripts/steering-live-smoke.mjs`，
使用中央 App Server 和 Windows 客户端现有 Local Agent，测试进程结束时关闭测试 Agent。
详见 [运行中追加实施与验收](../../docs/运行中追加要求实施与验收-2026-09-07.md)。
2026-09-07 已完成中央机隔离验收和 4510 正式网关部署，正式链路追加、续发及停止验证通过。
开发桌面使用当前前端；旧安装版需重新构建客户端安装包后分发。

## 长任务状态与实时命令输出（2026-09-04）

`device_exec` 已支持从客户端 Local Agent 实时回传 stdout/stderr。命令有换行时逐行展示；
没有换行的输出每 250 ms 尝试刷新，超长行拆为小帧。客户端在输入框上方显示常驻执行卡片，
包含工具/程序、工作目录、实时耗时、退出码、截断、失败、中断和断线后状态未知；日志与 Codex
回复分开，不会伪装成模型文本。用户向上滚动日志后不会被强制拉回底部。

Agent WebSocket 的收发和命令任务已解耦，执行期间继续心跳并可接收取消。Turn 中断会通过
`job.cancel` 终止关联的本机进程树。命令默认超时 30 分钟，可用 `timeoutMs` 调整，中央网关和
Agent 均限制在 1 秒到 2 小时。最终工具结果仍限制为每流 64 KiB；界面实时流每流最多 1 MiB，
超出时明确标记截断并继续排空管道，避免子进程因输出无人读取而卡死。

兼容策略：只有声明 `exec-stream/v1` 的 Agent 才显示实时输出；旧 Agent 继续等待最终结果，
客户端明确提示当前版本不支持流式输出。目标程序自身若在管道模式下缓存输出，平台无法强制
它刷新；例如 Python 可由任务显式选择无缓冲模式。

## 统一桌面与 Agent 配置（更新于 2026-09-04）

安装包不再写入固定的 `userId=desktop-user&deviceId=desktop-device`。首次启动时，“设置 → 常规与连接”
自动预填中央网关、用户 ID、设备 ID 和本机工作区，用户确认后点击“保存并应用”。用户 ID 默认取当前
系统账号名；设备 ID 默认由电脑名和持久化安装 UUID 的短段组成，两项都可编辑。桌面端用这些字段分别
组装 `/ws?userId=...&deviceId=...` 与 `/ws/agent?deviceId=...`，再启动 Local Agent 和附件 IPC 并连接 UI。
工作区目录浏览及相对命令 cwd 使用新的本机目录；中央模式不再把此路径作为 App Server cwd。
“工作区与工具”页面显示实际工作区，并可返回原设置入口修改。

自 0.2.1 起，本机工作区默认预填为 Windows“文档/YuanZhou Workspace”或 macOS
`~/Documents/YuanZhou Workspace`。它是 Local Agent 浏览文件和执行命令时的默认根目录；相对路径以此
为起点，选择或保存它不会自动上传文件，也不会让中央机把该目录当作自己的工作目录。默认目录只在
首次“保存并应用”时创建，显示预填值本身不会改动文件系统；用户填写的其他不存在目录仍按无效配置处理。

配置保存在 Tauri 应用配置目录的 `desktop-runtime-v1.json`；Windows 为
`%APPDATA%/com.centralcodex.localspike/desktop-runtime-v1.json`。升级时保留已有身份和工作区；旧配置中
网关 URL 的 `userId`、`deviceId` 会迁移到独立字段，其他查询参数保留。原“默认工作目录”曾是 App Server
参数，因此不会自动迁移为本机工作区。主题、模型、推理强度、
速度继续使用现有偏好存储。`CODEXIA_GATEWAY_AGENT_URL`、`CODEXIA_WORKSPACE_ROOT`、
`CODEXIA_LOCAL_AGENT_PATH` 覆盖优先，页面显示覆盖来源；移除环境变量并重启后恢复保存配置。

任务、提交状态不明或文件传输期间暂停配置切换。Agent 对在途命令/传输再次校验；配置无效时
保留原进程，启动或原子保存失败时恢复旧配置和 Agent。新地址暂不可达时配置仍保存，页面明确
显示中央连接失败，可重试连接或重新修改地址。进程已启动和设备已在线是两个独立状态。

基础配置验收见[客户端统一配置实施与验收](../../docs/客户端统一配置实施与验收-2026-09-03.md)，
自动身份与默认工作区见[2026-09-04 实施验收](../../docs/客户端首次身份与默认工作区实施验收-2026-09-04.md)。
进程级专项回归（独立测试设备，不触发模型推理）：

```powershell
cargo build -p local-agent
$env:CODEXIA_LOCAL_AGENT_PATH = (Resolve-Path 'target/debug/local-agent.exe').Path
cargo test -p desktop-spike runtime_process_integration -- --ignored --nocapture
Remove-Item Env:CODEXIA_LOCAL_AGENT_PATH
```

专项测试要求当前 shell 未设置 `CODEXIA_GATEWAY_AGENT_URL` / `CODEXIA_WORKSPACE_ROOT`。
请在独立测试 shell 中运行，避免改变已有开发覆盖。

## 桌面安装包与首次启动（2026-09-03）

在目标系统上运行 `npm run package:desktop`，Windows 生成 x64 NSIS 用户级安装包，macOS
生成当前主机架构的 `.app` 和 `.dmg`。本轮已验证 Windows x64 和 Apple Silicon；Intel Mac
尚未验证。客户端安装后无需 Node、Rust、Codex 或手动启动 Agent；这些只是构建机依赖。

```bash
npm ci
npm run package:desktop
# 需要可调试的打包产物时：npm run package:desktop -- --debug
```

脚本先按 Rust host target 构建 `local-agent`，将它暂存为
`apps/desktop/src-tauri/binaries/local-agent-<target>[.exe]`，再通过
`tauri.bundle.conf.json` 的 `externalBin` 交给 Tauri。最终 Agent 位于 Windows 应用可执行文件
旁边，或 macOS `.app/Contents/MacOS/`。Rust 保留现有匿名管道和生命周期管理，不增加 JS Shell 权限。
暂存二进制被 Git 忽略；干净源码应使用上述入口完成构建，不能单独给 Tauri 指定打包配置而省略 Agent。

默认产物位于 `target/desktop-package/<target>/release/bundle/`；`--debug` 对应 `debug/bundle/`。
可以用 `CARGO_TARGET_DIR` 改变构建缓存根目录。打包与 `dev:desktop` 的运行文件隔离，开发入口不变。
DMG 默认使用 Tauri 的 CI 模式，省略 Finder 窗口图标排版，避免远程构建依赖 AppleEvents 权限。

安装版首次没有保存配置时，自动打开原有“常规与连接”页面，显示自动生成且可编辑的用户 ID、设备 ID，
并预填系统“文档/YuanZhou Workspace”。用户点击“保存并应用”前不启动 Agent、不自动连接中央，也不创建
默认目录。保存时创建尚不存在的默认目录；其他路径仍可使用系统目录选择器指定。
已有 `desktop-runtime-v1.json` 和设备标识沿用；升级不改应用 identifier。开发调试版本仅在
相对 fixtures 确实存在时沿用它；环境覆盖继续有效。内嵌前端只提供中央网关模式，开发服务器
仍保留协议调试模式。

本轮产物为局域网试用包：Windows 未做发布者签名，Mac 只有链接器生成的 ad-hoc 签名，
没有 Developer ID 签名/公证，也没有自动更新。正式分发前需完成签名、公证及安装/升级验收。
不应通过关闭系统安全检查来替代这些步骤。
详细文件、校验值和验收边界见[桌面打包与首次配置验收](../../docs/客户端打包与首次配置验收-2026-09-03.md)。

## Windows 命令输出编码（2026-09-03）

Local Agent 对命令 stdout/stderr 优先识别 UTF-8 和 BOM；无 BOM 的非法 UTF-8 在 Windows
回退到本机 OEM 代码页（本轮中文系统为 CP936）。带 BOM 的 UTF-16LE/BE 同样可读。
成功与 `COMMAND_FAILED` 共用解码，输出限制仍为每流 64 KiB，截断保留完整 Unicode 字符。
不修改 PowerShell 参数或系统代码页，文件读写继续沿用原有 UTF-8 协议。
混合编码、自定义代码页、无 BOM 的 UTF-16 不保证自动识别；推荐工具显式输出 UTF-8。

在 Windows 客户端独立 shell 中运行真实链路验收（默认中央地址 `192.0.2.10:4510`，
可由 `DEVICE_GATEWAY_URL` 覆盖），不会创建模型 Turn：

```powershell
$env:LOCAL_AGENT_BIN = (Resolve-Path 'target/desktop-package/x86_64-pc-windows-msvc/release/local-agent.exe').Path
npm run encoding:smoke
```

测试生成独立设备及临时中文目录，覆盖 PowerShell/cmd 默认编码、stdout/stderr、非零退出、
UTF-8 emoji、UTF-16 BOM 与长中文截断，完成后清理测试资源。
证据见[命令输出编码修复与验收](../../docs/客户端命令输出编码修复与验收-2026-09-03.md)。

## macOS 原生开发与验证（2026-09-03）

使用 Node 24、npm 11、Rust stable，以及可用的 Apple Command Line Tools。
`rust-toolchain.toml` 使用当前主机目标，不再要求安装 Windows target；Apple Silicon
原生目标为 `aarch64-apple-darwin`。如果全局选中了不兼容的旧 Xcode，而已安装新版
Command Line Tools，可只在构建 shell 设置 `DEVELOPER_DIR=/Library/Developer/CommandLineTools`。

在本目录运行：

```bash
npm ci
npm run dev:desktop
```

桌面会自动启动同目录的 `local-agent`，无需在 Mac 客户端安装 Codex 或手动启动 Agent。
检查及生成不依赖 Vite 服务器的调试版可执行文件：

```bash
cargo fmt --check
cargo check --workspace --locked
cargo test --workspace --locked
cargo build -p local-agent --locked
npm run tauri:build --workspace @central-codex-spike/desktop -- --debug
./target/debug/desktop-spike
```

上述命令仍为未打包开发产物。桌面与 Agent 必须相邻；首次启动使用仓库中的
`fixtures/workspace`，随后可在设置中保存自己的目录。关闭唯一窗口会请求退出整个应用，
应用退出事件统一停止 Agent，包含 macOS 应用菜单退出路径。

macOS 配置切换进程专项：

```bash
CODEXIA_LOCAL_AGENT_PATH="$PWD/target/debug/local-agent" \
  cargo test -p desktop-spike runtime_process_integration -- --ignored --nocapture
```

`smoke`、`attachment:smoke`、`output:smoke` 已使用平台对应的可执行文件后缀和本机 shell；
可用 `LOCAL_AGENT_BIN` 指定二进制。`OUTPUT_SKIP_MODEL=1 npm run output:smoke` 只验证
Agent 输出处理及真实中央设备命令，不创建模型 Turn。普通 `smoke` 使用隔离 Fake Central，
不能替代真实中央验收。

实测范围和剩余项见 [macOS 编译与运行验收](../../docs/客户端macOS编译与运行验收-2026-09-03.md)。

## 图片输出与客户端写入（2026-09-03）

生成/编辑图片现在显示为对话图片卡片，并通过 Local Agent 自动保存到本机系统下载目录的
`Codexia` 子目录。已有对话中的 `imageGeneration` 结果也会在恢复历史时补齐；卡片支持
查看大图、打开所在目录，以及保存失败后重试。中央路径不会作为本机路径展示或传给 Agent。

中央模型可调用 `device_write_file` 创建/修改文本、`device_copy_file` 复制文件、
`device_publish_file` 校验并展示由客户端命令生成的文件；`device_output_paths` 查询实际
目录，`device_list_outputs` 返回保存结果。旧对话通过 `device_exec` 的 `codexia.files`
兼容入口使用同一条 Agent 链路，不需要重建对话。

可信局域网模式允许本机绝对路径和绝对命令 cwd，受当前系统用户权限限制；相对路径仍约束在
工作区。文本写入最多 256 KiB，图片/复制/发布最多 20 MiB；分块写入为 256 KiB，提交后
回读校验 SHA-256。图片默认另存，结构化写入覆盖不同内容必须携带 `overwrite=true` 与
`expectedVersion`。同内容重试不会重复创建文件。此覆盖保护不替代普通客户端命令自身的行为。

运行 `npm run output:smoke` 验证真实中央模型写入、兼容入口、客户端绝对 cwd、错误返回及
图片保存重试；设置 `OUTPUT_IMAGE_SMOKE=1` 增加真实图片生成与实时保存事件验收。
需先构建 `local-agent` 和网关，测试默认连接当前真实中央机。
详见[图片输出与客户端写入验收记录](../../docs/图片输出与客户端写入实施验收-2026-09-03.md)。

## 当前附件 MVP（2026-09-03）

正式桌面主链路是中央机 `192.0.2.10:4510` + 桌面自动管理的 Local Agent。
下文 Fake Central / 本机 App Server 命令仅保留为独立开发探针，不是附件运行入口。

在本目录运行 `npm run dev:desktop`，无需另外启动 Agent。点击输入框左下角的加号
选择附件，也支持拖拽和粘贴截图；已移除手动路径输入入口。添加阶段只走 Tauri 与 Agent 的匿名管道，点击发送后
才向中央提交附件引用。图片由 Agent 读取，通过 256 KiB 块交给网关内存，适配
App Server `image.url`；文本/代码通过 `device_read_text` 按需读取，PDF/Office
当前仅附加引用，尚无解析器。

图片限制：PNG/JPEG/WebP/GIF，单张 5 MiB、每回合共 10 MiB，最多 10 个附件；
图像尺寸不超过 8192×8192 且不超过 1600 万像素，解码分配上限 80 MiB。
不缩放原图输入，本机缩略图最大 240×180。已发送消息和历史保留附件卡片。

桌面首次启动时，Agent 在 Windows `%LOCALAPPDATA%/Codexia/device-id-v1`
（macOS `$HOME/.local/share/Codexia/device-id-v1`）登记随机设备标识。
旧的默认 `desktop-device` 会自动解析为 `desktop-<设备标识>`，避免多机争用同名
设备；UI 在连接前通过本机 IPC 获取实际标识。显式设置的其他 `deviceId` 保持原值，
但必须与 Agent 一致。Thread 会保留来源设备；已绑定其他设备的 Thread 不能用新设备
发送附件，应连接原设备或新建对话。已有 `CODEXIA_*` 开发覆盖变量继续支持。

剪贴板图片仅在点击发送时由 Agent 落盘到系统临时目录的 `codexia-attachments-v1`；
随机命名并登记，容量上限 100 MiB，登记后保留 7 天，下次导入时清理过期登记文件。
发送失败的临时图片也保留 7 天用于重试。移除附件只移除引用，不删除用户原文件。
应用不会自动安装文档解析器或执行宏。

附件失败保留草稿；未知提交结果先用“核对历史”确认，不自动重发。平台记录消息 ID、
Turn、设备和附件元数据，中央不新增原文件仓库；App Server 自己的历史可能保存内容。
未完成的图片传输空闲 60 秒过期，显式取消/完成时主动关闭。

验证命令：

```powershell
npm run check
npm run build --workspace @central-codex-spike/desktop
npm run build --workspace @central-codex-spike/test-gateway
npm run history:smoke
npm run multi-session:smoke
npm run attachment:smoke
node scripts/attachment-contract-smoke.mjs
```

`attachment:smoke` 默认访问真实局域网中央，自动启动独立测试设备、在 workspace 外
生成图片/文本并测试视觉识别、文本读取、历史和重复提交；可用 `ATTACHMENT_GATEWAY_URL`
及 `LOCAL_AGENT_BIN` 覆盖地址/二进制。需先构建 `local-agent`。负向协议探针使用真实
网关和合成设备测试离线、旧版本、错误设备和取消，不把合成设备当作真实视觉验收。
详见 [附件 MVP 实施与验收记录](../../docs/客户端附件MVP实施与验收-2026-09-03.md)。

该目录用于阶段 1 的本地开发验证，不是正式产品工程，也不代表生产版本已经锁定。

当前桌面端已采用 Codexia Workspace 正式工作台界面：左侧提供连接模式、Thread
管理和设备工作区，中央提供对话、流式状态、审批和活动日志；底层仍连接本目录的
中央测试网关与 Local Agent，便于在局域网环境持续验证核心流程。

单个桌面窗口支持多个 Thread 同时运行，每个 Thread 仍限制一个活动 Turn。左侧列表分别显示
“进行中 / 待确认 / 待核对”；切换或新建对话不会中断后台 Turn。消息增量、Turn ID、执行日志、
审批队列、未确认提交以及文本/附件草稿均按 Thread 隔离，停止按钮只中断当前 Thread。后台完成、
失败或请求审批时显示可点击提醒。任一 Thread 仍在运行时继续禁止重配 Agent 工作区，运行中的
Thread 不能归档或删除。

当前闭环：

```text
Tauri/React Desktop
        │ ws://127.0.0.1:4310/ws/ui
        ▼
Fake Central Gateway
        ▲ ws://127.0.0.1:4310/ws/agent（Agent 主动出站）
        │
Rust Local Agent
        │ 仅允许 ./fixtures/workspace
        ▼
workspace/list、read_file、受控版本查询
```

阶段 2 第一轮增加了版本化 AgentRPC V1 和中央侧的 Fake App Server Worker /
Remote Workspace Bridge。UI 的 `app.request` 会经过
`worker → bridge → AgentRPC → Local Agent`，而旧的 `agent.request` 仅作为
UI 兼容入口；设备链路不会发送旧格式。协议类型与 JSON Schema 位于
`packages/agentrpc-types/`，详见 [`AGENTRPC.md`](AGENTRPC.md)。

## 前置条件

- Windows x64；
- Node.js 24.x 和 npm 11.x；
- Rust stable（本机验证版本为 1.98.0），目标 `x86_64-pc-windows-msvc`；
- Microsoft C++ Build Tools、Windows SDK 和 WebView2 Runtime。

这些版本只服务本 Spike。由于 rustup 获取精确版本元数据时发生 TLS 中断，当前临时使用本机已安装的 `stable` 通道并记录实测版本 1.98.0；阶段 1 Go/No-Go 之前，不把它们提升为生产基线。

## 安装与运行

在本目录执行：

```powershell
npm install
npm run setup:env
npm run db:init
npm run check
npm run smoke
npm run dev
```

`setup:env` 会创建未纳入版本控制的 `.env` 和 `data/` 目录；本地 PoC 默认使用 `data/central.db` SQLite 文件，不需要启动 PostgreSQL。数据库表由仓库根目录的 `database/migrations/001_initial.sql` 初始化。多人长期运行或生产部署仍需切换到 PostgreSQL，届时替换 `DATABASE_URL` 并使用对应迁移流程。

如果本机 WebView2 被终端安全软件拦截，可先使用浏览器开发模式继续 UI 与本机 App Server 代理开发：

```powershell
npm run dev:browser
```

然后访问 `http://127.0.0.1:1420/`。该模式不启动 Tauri 窗口；桌面运行时问题修复后再恢复 `npm run dev`。
`npm run dev` 与 `npm run dev:browser` 都会启动 App Server 代理；若要运行旧的 Fake Central + Local Agent 闭环，请使用 `npm run dev:fake` 或 `npm run dev:browser:fake`。

要验证 B.6 Day 3 的“客户端经中央测试网关访问 App Server stdio”链路，使用：

```powershell
npm run dev:central
```

该命令启动 `services/test-gateway` 和浏览器 UI。测试网关监听
`ws://127.0.0.1:4510/ws`，由网关进程在服务端本地启动 `codex app-server`（stdio），
对客户端只暴露版本化的 `central-gateway-v1` 请求/响应/事件封装，不透传 App Server 原始
WebSocket。客户端 UI 选择 `Central Test Gateway`，地址保持上述 `4510/ws`。网关默认将
Thread 所有权和摘要保存到 `data/test-gateway-state.json`（可用 `TEST_GATEWAY_STATE_FILE`
覆盖）；重启后同一用户可以继续看到并恢复自己的 Thread。

### 局域网核心功能模式（当前优先支持）

如果中央机和客户端在同一可信局域网，可以暂时跳过正式账号、TLS/mTLS 和细粒度权限，直接验证核心工作流：

1. 在中央 macOS 机启动网关（网关监听局域网接口，并在本地通过 stdio 启动 Codex App Server）：

   ```bash
   TEST_GATEWAY_HOST=0.0.0.0 TEST_GATEWAY_PORT=4510 \
   CODEX_BIN=/Users/operator/Applications/ChatGPT.app/Contents/Resources/codex \
   npm run dev:test-gateway
   ```

2. 桌面模式运行 `npm run dev:desktop` 自动管理 Agent。仅独立设备诊断时可运行：

   ```powershell
   cargo run -p local-agent -- --workspace-root C:\work\project `
     --gateway-url ws://192.0.2.10:4510/ws/agent --allow-insecure-lan
   ```

3. 启动桌面端，在“中央测试网关”模式填写
   `ws://192.0.2.10:4510/ws?userId=<用户标识>&deviceId=<设备标识>`，连接后即可使用：
   Thread 创建/恢复/重命名/归档/删除、实时对话、Markdown 消息、工作区目录浏览、文件读取和白名单版本命令。
   连接成功后客户端还会调用中央 App Server 的 `model/list`，在对话输入框提供中央可用模型、推理强度和速度切换；中央网关需部署支持 `model.list` 的版本。

当前版本按“可信局域网内部使用”处理身份和权限；4510 仅允许在隔离局域网临时开放，禁止暴露到互联网。正式认证、TLS/mTLS、细粒度权限、审批和审计仍列为后续工作。

### 连接本机 Codex App Server 做真实 UI 测试

桌面 UI 另保留 `Local Codex App Server` 模式。它只在本地开发时让浏览器/Tauri
通过 `127.0.0.1:4501` 的本地桥接代理连接你启动的 Codex App Server；生产中央网关链路不受影响。
代理只负责去掉浏览器的 `Origin` 握手头，再转发到 `127.0.0.1:4500`，不会读取或存储对话内容。

先开一个终端启动本地监听器：

```powershell
codex app-server --listen ws://127.0.0.1:4500
```

另一个终端运行 `npm run dev:browser`（或 `npm run dev`），打开客户端后确认：

1. 保持 WebSocket 地址为 `ws://127.0.0.1:4501`，需要时填写工作目录和模型；
2. 点击“连接并创建 Thread”；
3. 在对话框输入任务，客户端会发送 `initialize` → `thread/start` → `turn/start`，并实时显示
   `item/agentMessage/delta`、`turn/completed` 和审批请求；
4. 需要时用“中断”调用 `turn/interrupt`，或在审批卡片中允许/拒绝/取消。

如果只想验证工作区权限与 AgentRPC，可切换到 `Fake Central / AgentRPC` 模式。浏览器预览与
Tauri 桌面窗口共用这套本地 App Server 客户端；当前实现没有把 OpenAI 凭据放进 UI。

启动后，桌面窗口可执行以下验证：

- 列出测试工作区；
- 读取测试工作区内的 `README.md`；
- 通过 Local Agent 执行严格白名单中的 `git --version`。

`npm run smoke` 会自动启动 Fake Central 和已编译的 Local Agent，验证目录列表、文件读取、白名单命令、路径逃逸拒绝和非白名单命令拒绝，并在完成后停止测试进程。

要只验证 Day 4 Device Broker（包含 Rust Local Agent 出站连接），使用：

```powershell
npm run device:smoke
```

默认连接 `ws://127.0.0.1:4510/ws` 和 `/ws/agent`。验证真实中央机时，可设置
`DEVICE_GATEWAY_URL=ws://192.0.2.10:4510/ws` 走局域网直连；测试会依次调用
`workspace/list`、`read_file` 和受控 `exec`，成功时输出 `DEVICE_BROKER_SMOKE_OK`。

要运行 Day 5 的双用户/双设备隔离、掉线恢复、审批边界和审计验收探针，使用：

```powershell
npm run day5:acceptance
```

该脚本默认连接 `ws://127.0.0.1:4510/ws`，对当前 Spike 尚未实现的能力输出
`BLOCKED` 及证据；设置 `DAY5_STRICT=1` 可让阻断项以退出码 2 失败，详见
[`docs/day5-acceptance-matrix.md`](docs/day5-acceptance-matrix.md)。

Central Gateway 模式的“工作区验证”面板也会使用同一组 `device.*` 操作；连接级
Thread 隔离由网关强制执行，客户端不能通过 payload 自行指定其他设备或工作区。

旧 `read_file` 仍限制 workspace 相对路径；相对命令 cwd 拒绝 `..` 和符号链接逃逸。
新增 `file/*` 附件方法在 `--allow-insecure-lan` 下允许本机绝对路径；文本按页读取，
图片有单独大小/像素限制。当前 `exec` 支持普通客户端命令及 PowerShell，可信局域网模式
也允许客户端绝对 cwd。Fake Central 只监听 `127.0.0.1`，不会连接 OpenAI。

开发模式使用单独的 CSP，仅额外允许 Vite React Refresh 的内联启动脚本和本机
`1420/4310/4501/4510` WebSocket；App Server 与桥接代理连接仍限制在 localhost。

### Windows 桌面白屏排查

如果 `http://127.0.0.1:1420/` 在普通浏览器中正常，但 Tauri 窗口持续白屏，先确认 WebView2 是否创建了 renderer 进程，并检查 Windows 事件查看器中的 `Microsoft-Windows-CodeIntegrity/Operational` 日志。

当前开发机上的排查记录显示，WebView2 renderer 被 Code Integrity 事件 3033 阻止：`C:\Windows\System32\winhafnt64.dll` 和 `winncap364.dll` 属于 TEC Solutions 的 OCular Agent，但不满足 WebView2 要求的 Microsoft 签名级别。退出搜狗输入法、使用全新 profile，以及改用已知可工作的 WebView2 Fixed Runtime 133 均未改变结果，因此需要升级、卸载或由管理员为 OCular Agent 配置兼容/白名单后再启动桌面应用。

不要把 `--no-sandbox` 或 `--disable-features=RendererCodeIntegrity` 作为产品修复；它们会削弱 WebView2 的进程隔离或完整性保护，也不能解决本机的 OCular Agent 注入冲突。

## 边界

- 不内置 Codex、OpenAI 凭据或 App Server 进程；Local 模式依赖你在本机自行启动 `codex app-server`，Central Test Gateway 模式由测试网关以 stdio 启动；
- 不复制 Codexia 或 Soromi 源代码；
- 不提供登录、数据库、生产认证或完整审计；
- 当前 `services/test-gateway` 是 Day 3/Day 4 的本地 Spike 和中央机测试网关，仍需补齐固定版本 Codex App Server 管理、平台认证、Worker 隔离、正式 WSS/mTLS、审批/审计和多用户路由。

## 发布候选与迁移准备（2026-09-09）

使用 `npm run package:desktop -- --rc` 构建独立 RC，升级版本加 `--rc-version 0.2.0-rc.2`；产物不是正式切换。Windows 安装/升级/回退、mTLS 续期和重新配对验收已通过；Mac arm64 包构建通过，原生 Keychain 与生命周期验收等待现场检查。迁移工具仅完成离线预检与合成备份恢复，真实共享历史导入尚未实现。详见[本批验收记录](../../docs/发布候选与迁移准备验收-2026-09-09.md)。

## 客户端版本更新（2026-09-14）

自 0.2.2 起，Windows 打包脚本为单独构建的 Local Agent 启用静态 CRT，并检查桌面主程序及 Agent 的普通/延迟 DLL 导入。发现 `VCRUNTIME`、`MSVCP` 等需另行安装的 VC 运行库依赖时拒绝打包，避免首次安装电脑缺少 `VCRUNTIME140.dll`。可用 `node scripts/windows-runtime-check.mjs <exe>` 单独核对；Windows 系统 DLL 和系统 UCRT API 集仍允许。

0.2.0 新增启动检查、设置中的“版本更新”、签名下载及确认安装重启。`npm run package:desktop -- --updater` 生成带更新签名的正式包；`scripts/publish-client-release.mjs` 整理中央发布目录。旧版需先手动安装带更新能力的版本，中央也需部署新的发布接口。构建结果、密钥管理、发布方式及尚未执行的完整安装验收见[版本升级实施与验收](../../docs/客户端版本升级实施与验收-2026-09-14.md)。
