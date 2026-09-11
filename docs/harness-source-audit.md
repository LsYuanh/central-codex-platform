<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# 固定 Codex 源码审查与中央运行时验收

日期：2026-09-09。范围：P0 固定源码、P2 最小 fork 与运行时负向验证。
产品基线同步、UI/AgentRPC/Local Agent 改动与真实部署记录由主实施文档负责。
本文件不把协议测试当作真实模型、真实客户端闭环验收。

## 固定基线与依赖

| 项目 | 固定值 / 证据 |
|---|---|
| 中央原服务版本 | 主代理现场确认 `codex-cli 0.153.4`，正式 4510 未替换 |
| 官方仓库 | `https://github.com/openai/codex` |
| tag | `rust-v0.153.4` |
| annotated tag object | `042fb41b7c813ac7999105e886b2b7aa715b5081` |
| commit | `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` |
| 归档指纹 | `spikes/local-dev/harness/upstream.json` 的 archive/patch/schema SHA-256 |
| 原始文件校验 | `harness/source-files.json`，应用源码变更前逐文件核对 SHA-256 |
| 原始许可 | `harness/upstream/LICENSE`（Apache-2.0）与 `NOTICE` 原样归档 |
| 第三方依赖清单 | `harness/upstream/Cargo.lock` 原样保留；源码 tar 含第三方目录及原始 license，发布 SBOM 尚需补齐 |
| 编译目标 | `codex-app-server`，不是全套 Codex CLI/TUI |
| 上游请求工具链 | Rust 1.95.0 |
| 实際验收工具链 | 现有中央 Rust/Cargo 1.98.0，macOS 26.3.1 arm64，Command Line Tools |
| 隔离目录 | `/Users/operator/central-harness-qa-20260909` |

官方 release tag 的 `Cargo.toml` workspace.version 为 0.153.4，而 Cargo.lock
无 source 的 workspace 包仍为 0.0.0，直接 `--locked` 首次失败。已核对最小 lock
差异：只把这些本地包版本改为 0.153.4，未修改 registry/git 包的版本、来源或 checksum。
整份重新 resolve 会产生无关依赖升级，未将该结果纳入补丁。

最终编译指纹见 `harness/verification/central-qa.json`。这是独立 QA 产物，未写入
`/Users/operator/central-codex-platform` 正式目录；仅只读使用其中已有工具链二进制。
Cargo cache、target 与运行数据均在独立 QA 目录。

## 协议来源与兼容范围

固定源码的 `app-server-protocol/src/precomputed_exports.rs` 本身通过嵌入的
stable/experimental `.json.zst` 导出协议。这里原样归档两个压缩包，并以
`harness/export-schema.mjs` 执行相同的数据解压/文件导出，生成逐文件 SHA-256 manifest：

- stable：1,010 个 JSON/TypeScript 文件。
- experimental：1,243 个 JSON/TypeScript 文件。
- 这是固定源码中预生成产物的现场导出，不是运行商业 Codex 后重新生成，也不是
  依据文档手写 schema；未在 Windows 客户端启动任何 Codex。
- DynamicToolSpec 的 function 对象显式带 `type: "function"`，dynamicTools 是实验性接口。
- fork 不增加协议结构字段；`initialize.result.userAgent` 在模式启用时追加
  `yuan-zhou-remote-workspace/1`。

现有原生 Thread/Turn 的基本创建、通知、完成，以及动态调用/结果返回由编译后的
fork 实测。旧安装版、旧 rollout、图片生成和正式模型连接不能仅因版本字符串相同
而认定兼容；现有商业部署与开源 fork 的完整协议兼容仍需真实回归。

## 执行入口审查

所有下表路径均相对于固定源码 `codex-rs/`。

| 入口 | 上游行为 | 本期运行时处理 |
|---|---|---|
| 环境实例化 | `exec-server/src/environment.rs` 可从 environments.toml、exec URL、noise 创建 local/remote executor | 在两个 prepare 入口强制上游成熟的 `DefaultEnvironmentProvider(Some("none"))`；没有 LocalFileSystem/LocalProcess 实例，不采用未适配的上游远端传输 |
| 工具清单 | `core/src/tools/spec_plan.rs` 聚合内置、MCP、扩展、hosted、dynamic、code mode | 远端分支只注册 DynamicToolHandler，并按精确名称与默认 namespace 过滤；直接模式，不创建其他工具或 code mode worker |
| 工具分发 | `core/src/tools/registry.rs` 统一 handler 调用及 hooks | handler 必须自行通过 `remote_workspace_safe`，默认 false，仅审查过的 DynamicToolHandler 实现可 opt in；在前置 hook/execute 前拒绝其他实现 |
| 内置 shell/unified exec/patch/read/search/view-image | `core/src/tools/handlers`、`runtimes`、local process/filesystem | 不注册且无 native executor；伪造调用产生模型可见失败，未转发中央命令 |
| API 直接执行/文件/搜索 | `app-server/src/message_processor.rs` typed client request 可绕过模型 registry | typed 公共入口先校验固定 RPC 白名单；command/exec、fs/readFile、skills/list 等明确返回 REMOTE_WORKSPACE_UNSUPPORTED |
| 用户输入本地图片/skill | 原生 input 可指定 host localImage/skill 路径 | 只允许 text 和 data:image 内联图片；本地路径输入拒绝 |
| 项目 config/信任探测 | `config/src/loader/mod.rs` 根据 cwd 查找项目层及 Git root | 模式中 cwd 不参与配置层加载，跳过项目层及其发现；中央独立 CODEX_HOME 配置仍可读取 |
| 项目与用户 AGENTS | `core/src/agents_md.rs` 和 `thread_manager.rs` 加载中央文件与用户规则 provider | 跳过项目扫描和 host user-instruction provider，规则由客户端 workspace/context 返回 |
| Shell/环境提示 | `session/session.rs` 检测 default shell，world_state/environment 探测和展示 | 使用不可执行的占位 shell；无 shell snapshot；模型环境片段不展示中央系统信息，客户端实际环境从工具取得 |
| Git 自动探测 | `git-utils/src/info.rs` 的 root/ancestor/collect；`git_process.rs` spawn | root/collect/ancestor 返回 None，中央 Git spawn 返回 None；Git 状态和实际 diff 经设备工具 |
| exec policy 文件 | `core/src/exec_policy.rs` 从 config 层读取 rules | 远端模式返回空 Policy；不读取本地用户工作区规则；这不是安全执行兜底，执行器本身已经不存在 |
| agent roles 文件 | `core/src/config/mod.rs` load_agent_roles | 不加载中央角色文件，返回空角色集合 |
| Hook/notify | `session/mod.rs` build_hooks_config 与 config notify | 返回空 HooksConfig，清除 notify；实际 fixture 配置恶意 notify 后未发生写入 |
| MCP 启动与调用 | `codex-mcp/src/connection_manager.rs` 建立 stdio/http 服务 | 返回空 connection set；config 中 mcp_servers 清空；模型 MCP handler 不注册 |
| plugins | `core-plugins/src/manager.rs` 加载/启动插件，App Server startup task 可提前同步 | plugins_for_config 返回空；App Server startup tasks 强制 Skip，避免仅隐藏 UI 工具 |
| skills 的缓存/热身/监听 | `ext/skills/src/host_service.rs`、session warmup | 三个 snapshot/watch 入口返回空，session warmup 跳过；客户端 rules 与中央技能扫描分开 |
| 扩展及 hosted 能力 | `app-server/src/extensions.rs` 包含 skills/MCP/web/image/memory/guardian/queue/goals 等 | 返回空扩展 registry；原生图片生成、web、queue/goals/history-note 扩展目前不可用，不能声称原有图片生成行为保持 |
| 子任务 | `thread_manager.rs` spawn_subagent/spawn_internal_session + tool/spec | 两类 spawn 明确拒绝；没有向不继承设备边界的子任务开放功能 |
| feature 重开 | `features/src/lib.rs` 从配置读取 feature flags | 进程级远端模式优先，feature enabled 一律 false；用户 config 不能重新启用未审查功能。这是首期保守能力面，后续逐项证明再开放 |
| 原生 remote control | App Server 可从持久设置恢复另一传输 | runtime options 强制 DisabledEphemeral；launcher 只接收 stdio app-server |
| 进程操作系统权限 | 仅源码拦截仍不能作为 worker OS 隔离证明 | 独立 macOS worker.sb 默认 deny；只读必要系统运行文件、精确 binary/auth 文件，运行数据只写独立 CODEX_HOME/worker，禁止其他程序执行 |

实际模型设备工具还依赖可信网关的定义和路由。精确名称白名单不能代替设备所有权
校验；Local Agent 仍需检查工作区与权限。反向连接、身份变更、调用取消和未知结果
继续由平台/Agent 处理。P5 的登录、用户授权和租户隔离尚未完成。

## 最小 fork 修改清单（25 个文件）

1. `Cargo.lock`：只修正 release tag 的本地包版本。
2. `core/src/lib.rs`：导出小型 remote_workspace 模块给 App Server。
3. `core/src/remote_workspace.rs`：进程模式、精确工具名、RPC/input/override 校验。
4. `core/src/tools/registry.rs`：handler provenance 的默认拒绝。
5. `core/src/tools/handlers/dynamic.rs`：只有 allowlisted dynamic device handler 可通过。
6. `core/src/tools/spec_plan.rs`：只创建客户端工具的直接调用清单。
7. `features/src/lib.rs`：阻止用户配置重开未审查 features。
8. `core/src/agents_md.rs`：不扫描中央项目规则。
9. `core/src/thread_manager.rs`：不读取 host 用户规则，不开放子任务。
10. `core/src/exec_policy.rs`：不读取中央 rules 文件。
11. `config/src/loader/mod.rs`：不加载 cwd/project config。
12. `core/src/config/mod.rs`：worker cwd、notify/MCP/指令文件/角色限制。
13. `core/src/session/mod.rs`：空 hooks。
14. `core/src/session/session.rs`：不热身技能，不检测用户 shell。
15. `core/src/context/world_state/environment.rs`：不把中央环境送入用户工作区上下文。
16. `codex-mcp/src/connection_manager.rs`：空 MCP 连接集合。
17. `core-plugins/src/manager.rs`：空 plugin 结果。
18. `ext/skills/src/host_service.rs`：禁用 snapshot 和监听发现。
19. `exec-server/src/environment.rs`：强制无 native executor。
20. `git-utils/src/info.rs`：禁用 Git 探测。
21. `git-utils/src/git_process.rs`：拒绝 Git 子进程。
22. `app-server/src/extensions.rs`：不安装未经适配的扩展。
23. `app-server/src/lib.rs`：禁用插件 startup 与 remote control。
24. `app-server/src/message_processor.rs`：直接 RPC 边界。
25. `app-server/src/request_processors/initialize_processor.rs`：能力标记。

变更以 `harness/remote-workspace.patch` 保存，`apply-fork.mjs` 从逐文件校验后的固定
源码生成并执行 rustfmt；不提交整套上游 repository。更多配套脚本属于现有项目的
构建/测试集成，不是第二产品入口。构建明确只走 Cargo，未宣称 Bazel 构建已经验收。

## 能力复用 / 替换判定

| 能力 | 本期判定 | 依据 / 保留边界 |
|---|---|---|
| 模型调用、Agent 循环 | 直接复用 | 固定 upstream core/App Server，真实 Rust dispatcher 的 SSE 三步 fixture 完成 |
| Thread/Turn 流式及终态 | 直接复用 | initialize、thread/start、turn/start、turn/completed 现场通过；平台只补设备状态和提交可靠性 |
| 无执行环境 | 直接复用并强制 | 已有 EnvironmentProvider none，fork 固定此模式而非再造一套环境编排 |
| 动态工具及结果调用关联 | 直接复用 | 原生 item/tool/call + contentItems，网关保留设备/Thread/Turn 归属 |
| 停止 | 原生机制 + 平台保留 | 原生 Turn interrupt 不等于跨网络客户端进程树已退出 |
| 文件/搜索/Git/命令 | 远端适配 | 现有 Device Broker/AgentRPC/Local Agent；禁止复制中央本地执行结果 |
| 补丁 | 客户端复用独立组件 | Agent 子任务从同一固定源码提取 apply-patch，中央不运行本地 patch handler |
| UI、设备路由、身份与工作区归属 | 平台保留 | 上游单进程会话不能代替多设备平台授权 |
| 历史/附件/输出与未知提交 | 暂不整批替换 | 有跨网络不确定结果及旧格式关联；等待真实链路迁移证据 |
| 图片生成/web/plugins/skills/subagents | 本期明确禁用 | 目前扩展不能保证全部入口继承客户端执行边界，不提前声称复用完成 |
| P5 多用户生产化 | 独立后续 | 当前临时可信 LAN 身份不能当生产授权或租户沙箱 |

## 已执行验证与未验证范围

已执行（中央真实编译/进程，以及另行授权后的真实模型/Windows 设备联调）：

- 固定 archive 下载，tag/commit 匹配，`git apply --check` 通过。
- `cargo check -p codex-app-server --locked`：通过；初版 3m16s、无执行环境版 36.43s。
- `cargo build -p codex-app-server --bin codex-app-server --locked`：通过，4m16s；最终排版/注释版本另记录最终 build 指纹。
- 修改的 Rust 文件 rustfmt 通过；稳定 rustfmt 忽略上游 nightly-only imports_granularity 的告警保留。
- 实际 fork + 严格 OS profile + 无凭据、独立空 CODEX_HOME：`HARNESS_RUNTIME_BOUNDARY_OK`。
  三次 loopback Responses 请求；工具清单只有 `device_workspace_context`，过滤伪装的
  `device_bad_plugin`；故意发出 `exec_command` 被拒；一次 dynamic result 返回并完成 Turn。
  中央 AGENTS 标记没有进入模型请求，notify/命令未产生副作用。
- 实际 fork 拒绝 `command/exec`、`fs/readFile`、`skills/list` 与 cwd override，均有终态。
- 原生 C 探针 + 同一 worker.sb：`HARNESS_OS_BOUNDARY_OK`；worker 文件读写成功，
  外部中央 sentinel 读取/写入以及 `/bin/sh` 执行均得到 EPERM/EACCES。
- 探针结束后无该 QA fork 进程残留；正式 4510 保持原服务。
- schema 两个固定档案 SHA 验证和现场导出通过，1010/1243 文件。
- 用户明确批准 QA 网关包上传和独立 4529 联调后，包 SHA-256 校验为
  `5de68db256e891a3df868463f1dcd02d925ee7c46044f0cebfddbcf2f00fd546`。
  仅在 QA/gateway 解包，以锁文件安装运行依赖；正式 4510 保持 PID 90685。
  QA 网关 PID 71591，`healthz.enforcedRuntimeReady=true`；启动变量和日志路径见 harness README。
- 最终 binary `673a2705de80016e2a61ecd7f7f469532bc650bf8b5bf827b4c1fc1f753d9d88`
  在原严格 OS profile 下完成真实模型 + Windows Local Agent 闭环，主代理 live smoke exit 0：
  客户端 rules context、模型 search/read/patch、单次实际补丁审批、CRLF 写入、真实 Git diff、
  客户端 stdout/exit 0、结构化 exit 7、原生 Turn 完成，8 项检查通过。
  最终文本含真实客户端 marker 与 hostname。
  Thread `01a0847f-1785-7022-80f0-c65f866edfce`，Turn `01a0847f-17a2-7193-8a94-d3dff13ddb5a`。
  测试 Thread 已归档，测试 Agent 已退出。
- 真实认证仅使用独立 `live-home/auth.json` 指向既有 `~/.codex/auth.json` 的精确链接，
  profile 对确切目标仅开放读取；未读取输出、复制凭据或加载正式 config。
  此次真实认证/TLS/模型请求成功，无需增加任何 OS profile 权限；不代表 keychain 登录、
  token 刷新和全部网络条件均已验收。
- Windows Agent 的 attachment-stdio 管道保持打开场景在命令 stdin 修复后再次完成真实模型
  8 项闭环：Thread `01a08488-4163-7d20-bb1d-c9ca0aa968d4`，
  Turn `01a08488-41be-7500-b33d-4c6b6a9b04a6`；详情保留在 central-qa manifest。
- 已授权原生 UI 最终通过在线状态、客户端目录读取、Git/diff 页面检查后关闭；主代理确认
  desktop PID 19348、Agent PID 22432 及 Git 均无残留，正式客户端 config hash 不变。
  关闭时 QA health 为 clients=0、devices=0、sequence=416。
- 2026-09-09 05:09:54 UTC 收尾：再次核验 QA gateway PID 71591 的 command/cwd 与
  fork 子进程 PID 71592 的 command/父子关系/cwd 均位于既定 QA 边界后，仅向这两个 PID
  发送 TERM。现场确认两个 PID 均退出、4529 无监听；正式 4510 仍为 PID 90685，
  health ok=true、clients=1、devices=2、sequence=6620，与停止前完全一致。
  QA fixture、日志、源码/二进制、会话和 auth 链接全部保留，未执行文件清理。
- 后续认证生命周期源码审查发现：固定 login manager 先向 authority 刷新，之后才写 auth.json；
  因此仅用只读共享链接仍可能先旋转正式共享 token。已在 launcher 安全默认中修复：
  外部 auth-file 模式强制 shared-readonly，覆盖 refresh/revoke endpoint 为不能联网的
  `disabled://read-only-shared-auth`，不允许调用方覆盖回正式端点，OS profile 不放宽。
  该模式只使用当前 access token，过期明确失败；不是自主长期认证方案。
- 真实 Rust + 原严格 OS profile + 生成假凭据/loopback authority 通过
  `HARNESS_AUTH_REFRESH_OK`：复现无保护共享假链接先刷新后保存被拒；独立可写假认证
  刷新并持久化后重启正确读取且不重复刷新；保护后的过期共享假认证零刷新请求、
  文件不变、2 次模型 401 请求后 119ms 进入 failed Turn。未触发任何真实共享凭据刷新。
  详见 `spikes/local-dev/harness/auth-lifecycle.md` 与 `verification/long-running-qa.json`。
- 后续旧会话/故障轮次使用新版 QA 包
  `71fcb83ba2df5a9907e914a1e93b871c65dbbc235a5e5b35437a67a965c8ede4`，依赖锁未变，
  仅覆盖 QA/gateway 的打包清单。受控 `qa-control.mjs start` 于 05:30:23 UTC 启动
  gateway PID 74635 / fork PID 74644，重用独立 state/home/worker；再次 initialize marker
  通过且 shared-readonly 保护日志出现。重启后独立原生 OS 探针仍为
  `HARNESS_OS_BOUNDARY_OK`；正式 4510 PID 90685 与 health baseline 不变。
- 原生执行中关闭测试完成后，受控 stop 验证上述 QA PID 均退出、4529 关闭，再覆盖包
  `f6e468648f8af6d9c1ceee4c8c6456d34c70bf699ab4dd8650d3e6cc4d7a593f` 并于
  05:43:41 UTC 启动 gateway PID 75844 / fork PID 75851；依赖锁、state/auth 保留。
  包内 `scripts/harness-state-smoke.mjs` 在中央 macOS 实际文件系统 exit 0，15 项通过：
  包括 fsync/atomic rename、错误保留已提交字节、v1 未知扩展字段往返，以及 11368 次并发
  读取只看到完整 JSON（generation 0..80，最终 80）。正式 4510 基线仍完全一致。

仍未验收 / 不在本文件中冒充完成：

- 真实链路下所有断线/超时/取消/未知结果组合；上述成功闭环不能代替这些故障矩阵。
  网关代码上传曾被自动审批拒绝；收到用户对确切载荷和 4529 联调的明确授权后才执行。
- keychain 登录、独立真实登录的 token 刷新和全部模型/代理/TLS 网络环境；既有 auth.json
  的真实模型成功请求及假凭据真实 Rust 刷新/持久化/重启已经验证，不能泛化到尚未执行的
  真实认证流程或多日持续运行。共享凭据的刷新由保护明确禁用，不能为验收强行旋转。
- 旧 Thread、旧 rollout 和图片生成/附件/输出的全部兼容回归。已禁用能力需在 UI 说明。
- 上游 Rust 1.95.0、release、全量 nextest、`just fix`、Bazel lock/build 和发布 SBOM。
  已执行的专项运行时测试不能冒充这些 upstream suites。
- 正式服务部署、安装版客户端升级、macOS 独立客户端、多用户认证/网络安全/租户隔离。

## 回退与交接

没有修改正式服务、正式配置或客户端安装包。QA 运行目录与数据可以保留供复查；
不执行自动清理用户原目录或 stash。部署前应以 manifest 固定 binary、patch、schema、
网关及 Agent 版本组合，再完成真正远端闭环。回退只能回到已验证的强制客户端执行版本；
不允许因设备离线或补丁不兼容而降回中央本地执行，普通上游 runtime 应被 marker 检查拒绝。

来源：固定源码本身，以及[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。
以上具体能力判定以固定源码和现场编译/探针为准，不把未来文档或商业桌面功能名当作已验证实现。
