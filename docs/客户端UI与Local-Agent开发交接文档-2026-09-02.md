# 客户端 UI 与 Local Agent 开发交接文档

更新时间：2026-09-04

适用目录：`C:\Workplace\central-codex-platform`  
当前阶段：P0 用户验收、P1 统一配置与原生打包已推进；Windows 与 macOS arm64 已加入自动用户/设备身份和默认工作区并重建试用包。剩余跨版本升级/卸载、独立环境分发、Mac 现场/异机验收及发布签名。文件名保留原日期，避免破坏已有引用。

## 1. 当前结论

2026-09-07 已按用户要求将当前客户端重新构建为远舟 Windows 安装包并实装，保留原配置，移除旧名称安装项；安装版实际页面、中央连接及 Agent 在线通过，详见[远舟 Windows 重新打包与安装](远舟Windows重新打包与安装-2026-09-07.md)。下文此前“安装包尚未重建”记录保留为当时阶段说明。

2026-09-07 已补齐每轮任务用时：运行中实时显示，完成、失败和停止后保留用时，同轮追加不重置，本机刷新后可恢复。前端检查、构建、计时回归和真实中央独立 QA 任务通过；本次原生 Tauri 最终复查受窗口枚举不可用限制，详见[对话任务用时实施与验收](对话任务用时实施与验收-2026-09-07.md)。

2026-09-07 已按用户确认的 Codex 风格规范重构现有客户端页面，包含浅色/深色/跟随系统、侧栏、首页、输入框与分组设置；取消输入框上方的项目/设备条。前端检查、构建及相关状态回归通过，并实际检查 Tauri 页面。安装包尚未重建，详见[客户端 UI 重构实施与验收](客户端UI重构实施与验收-2026-09-07.md)。

2026-09-07 已实现运行中追加文字要求、独立停止和同轮多消息恢复，静态检查、网关协议测试、真实中央隔离链路和 Tauri 页面验收通过。用户确认后已备份并部署正式 4510 网关，正式链路追加、客户端命令停止和设备重连通过；旧安装版仍需重新构建分发，详见[运行中追加要求实施与验收](运行中追加要求实施与验收-2026-09-07.md)。

P0 剩余桌面验收由用户在本次会话确认完成。后续已完成统一配置与 macOS 原生构建/设备验证，没有重跑图片生成或模型推理。证据见[客户端统一配置实施与验收](客户端统一配置实施与验收-2026-09-03.md)及[macOS 编译与运行验收](客户端macOS编译与运行验收-2026-09-03.md)。

用户继续授权推进后，已生成包含 Agent 的两端试用包；安装版首次进入现有设置页选择本机目录。
交付文件和完整验证边界见[桌面打包与首次配置验收](客户端打包与首次配置验收-2026-09-03.md)。

本轮补齐 Windows 默认代码页输出解码及 Unicode 截断，真实 CP936 PowerShell/cmd 中文输出通过；见[命令输出编码修复与验收](客户端命令输出编码修复与验收-2026-09-03.md)。

用户明确允许关闭旧客户端并同步 4 个文件后，Windows 安装及首次配置 UI、中文目录、重启恢复、标题栏关闭和同版本覆盖安装通过；Mac 检查、12 项单测及真实设备 smoke 通过。原配置已恢复，新版客户端保持运行，详见[Windows 实装与 Mac 复测](客户端Windows实装与Mac复测-2026-09-03.md)。

2026-09-04 已取消新安装包内的固定 `desktop-user` / `desktop-device`：首次设置自动生成可编辑身份，预填系统 Documents 下的 `Codexia Workspace`，保存前不连接也不创建目录。Windows 新安装器已构建；实现和当前验证边界见[客户端首次身份与默认工作区实施验收](客户端首次身份与默认工作区实施验收-2026-09-04.md)。

| 能力 | 当前状态 |
|---|---|
| 图片/文件输入 | 原生选择、拖入、截图粘贴、附件草稿与历史卡片已实现；原生选择及纯图片发送通过 Tauri 实测，剩余拖拽/粘贴 UI 验收由用户确认完成 |
| 附件入口 | 输入框左下角加号；已移除“本地路径”按钮，路径不自动写入正文 |
| 图片输出 | 实时生成结果及旧历史均接入输出卡片，经 Local Agent 保存到本机下载目录的 `Codexia` 子目录；真实生成与文件校验通过 |
| 客户端写入 | 文本写入、复制、发布、目录查询、保存结果查询已实现；真实模型写入及旧对话兼容入口通过 |
| 图片尺寸 | 对话缩略图最大 240×180 像素，图片卡片最大宽度 360 像素；保留查看大图和打开目录按钮 |
| 模型菜单 | 保留“模型 / 推理强度 / 速度”；删除“高级”、箭头及分隔线；滚动区移至 `.composer-body`，修复外层裁剪弹窗 |
| 设备身份 | 新安装默认由电脑名和持久化安装 UUID 短段生成，可编辑；旧配置身份保留；Thread 保留来源设备关联 |
| 统一配置 | 现有设置页支持中央网关、用户 ID、设备 ID、本机工作区、保存并应用和重启恢复；Agent 与附件 IPC 一起重建，支持忙碌拒绝和保存失败回退 |
| macOS 客户端 | arm64 编译、配置专项和真实设备工具通过；修复正常退出后 Agent 残留；借用中央 Mac 同机验证，现场界面和异机验收仍待补齐 |
| 安装资源 | Tauri externalBin 内置 Agent；Windows x64 NSIS 用户级安装器、macOS arm64 `.app`/DMG 已生成，尚无正式发布签名 |
| 命令编码 | UTF-8 优先、BOM 识别、Windows OEM 代码页回退；成功/失败输出使用相同解码，64 KiB 截断保留完整字符；Windows 实测通过 |
| Windows 实装 | 0.1.0 安装器首次安装及同版本覆盖返回 0；设置/设备身份保留，首次配置、原生目录选择、中文 cwd 与标题栏关闭通过 |
| 长任务反馈 | `device_exec` stdout/stderr 实时回传；客户端常驻执行卡片显示阶段、耗时、退出码、截断、中断、失败和断线未知状态；旧 Agent 明确降级 |
| 多会话并行 | 单窗口可同时运行多个 Thread，每个 Thread 一个活动 Turn；左侧独立显示运行/审批/待核对状态，消息、Turn、执行日志、审批和草稿按 Thread 隔离，当前停止按钮不影响后台对话 |

完整证据见[附件 MVP 实施与验收](客户端附件MVP实施与验收-2026-09-03.md)和[图片输出与客户端写入验收](图片输出与客户端写入实施验收-2026-09-03.md)。[附件设计说明](客户端图片与文件发送功能设计说明-2026-09-02.md)保留了早期基线和分阶段计划，不应把其中的旧状态当作当前待实现列表。

核心链路已经打通：中央机只负责 Codex/App Server 推理，客户端的文件、Git、PowerShell 和其他系统操作由客户端 Local Agent 执行。

Local Agent 已纳入桌面客户端生命周期：

- 启动 `desktop-spike.exe` 时自动启动同目录的 `local-agent.exe`（macOS 对应无后缀文件）；
- 关闭唯一桌面窗口请求退出整个应用；应用退出事件统一停止 Local Agent，包含 macOS 菜单退出路径；
- 客户端不需要另外启动本地 Codex、Codex CLI 或 helper；
- 已在真实中央机上验证启动注册、关闭注销和 PowerShell 执行。

## 2. 架构与数据边界

```text
React/Tauri 客户端
        │  WebSocket /ws
        ▼
中央测试网关（中央机 192.0.2.10:4510）
        │  stdio
        ▼
Codex App Server（中央机，只推理）

客户端 Local Agent
        │  WebSocket /ws/agent（主动出站）
        ▲
中央测试网关转发 device.* 请求
        │
本机文件系统 / Git / PowerShell / 命令执行
```

重要边界：中央 App Server 不应直接读取客户端文件，也不应在中央机执行客户端命令。中央侧只产生推理结果和工具请求；网关将设备工具请求转交给目标客户端的 Local Agent，由 Local Agent 在本机执行并回传结果。

附件选择与预览经 Tauri → Agent 匿名管道在本机完成；点击发送后才提交引用及推理所需内容。生成图片使用 App Server 返回的内联图片数据，由网关分块路由给 Agent 保存，不能把原生结果中的中央 `savedPath` 当作客户端路径。平台仅新增关联和输出元数据，App Server 自己仍可能保留内容，不能承诺中央磁盘零增长。

## 3. 真实中央机连接参数

当前中央机：`operator@192.0.2.10`  
中央网关 UI 地址：

```text
ws://192.0.2.10:4510/ws
```

Local Agent 地址由设置中的设备 ID 组装：

```text
ws://192.0.2.10:4510/ws/agent?deviceId=<设备ID>
```

新安装的用户 ID 默认取系统账号名；设备 ID 默认由电脑名和 `%LOCALAPPDATA%/Codexia/device-id-v1`（其他系统为对应 Local Data 目录）中的持久化安装 UUID 短段组成。两项可编辑，UI 与 Agent 使用同一设备 ID。旧配置中的 `desktop-user` / `desktop-device` 会保留；Agent 对旧 `desktop-device` 的兼容映射继续有效，避免升级时改变既有路由。

当前是可信局域网临时模式，使用明文 WebSocket 和 `--allow-insecure-lan`。暂未实现正式认证、WSS/mTLS、细粒度权限和多用户隔离，不要将 4510 暴露到互联网。

网关健康检查：

```powershell
Invoke-RestMethod http://192.0.2.10:4510/healthz
```

只有本机一个客户端在线时，启动后预期 `devices=1`，关闭后为 `0`。多机环境按本机设备上线/下线及全局数量增减验收，不要求全局设备数归零；本次已记录另一台设备在线时 `1 → 2 → 1` 的真实情况。

## 4. Local Agent 自动生命周期实现

实现文件：

- [Tauri 生命周期代码](../spikes/local-dev/apps/desktop/src-tauri/src/main.rs)
- [开发启动脚本](../spikes/local-dev/package.json)

`main.rs` 与 `runtime.rs` 中的 `DesktopRuntime` / `AgentProcess` 管理子进程：

1. Tauri setup 读取应用配置目录中的 `desktop-runtime-v1.json`，解析环境变量覆盖，然后启动 Agent；
2. 通过 `Command` 启动 Local Agent，Windows 不弹出终端窗口，stdin/stdout 使用匿名管道承担本机附件 IPC，stderr 当前丢弃；
3. “保存并应用”先校验配置并请求 Agent 暂停接收新操作，随后重建进程及附件 IPC；原子保存失败时恢复原 Agent；
4. Tauri `CloseRequested` 请求应用退出；`RunEvent::Exit` 统一释放 Agent，`AgentProcess::Drop` 停止并等待子进程退出，覆盖 macOS 菜单退出路径。

默认路径约定：

- Local Agent：桌面可执行文件同目录的 `local-agent.exe`；Mac 包内为 `Contents/MacOS/local-agent`，安装资源由 Tauri externalBin 提供；
- 工作目录：安装版预填系统 Documents 下的 `Codexia Workspace`，用户保存时才创建；可编辑或用目录选择器更换。开发调试版只有相对 fixtures 确实存在时才使用它；
- 网关：保存基础 `/ws` 地址，UI 与 Agent 按用户 ID、设备 ID 分别组装实际连接地址。

可用环境变量覆盖默认值：

```powershell
$env:CODEXIA_LOCAL_AGENT_PATH = 'C:\path\to\local-agent.exe'
$env:CODEXIA_WORKSPACE_ROOT = 'C:\path\to\workspace'
$env:CODEXIA_GATEWAY_AGENT_URL = 'ws://192.0.2.10:4510/ws/agent?deviceId=my-device'
```

## 5. 启动与测试

在原项目目录执行：

```powershell
cd C:\Workplace\central-codex-platform\spikes\local-dev
npm install
npm run dev:desktop
```

`dev:desktop` 现在会先执行 `cargo build -p local-agent`，再启动 Tauri 开发窗口；Tauri 的 `beforeDevCommand` 会自动启动 Vite。

打包使用 `npm run package:desktop`，在目标系统构建匹配架构的 Agent 和桌面。产物位于
`target/desktop-package/<target>/release/bundle/`；本轮两端交付副本与 SHA-256 清单位于
仓库 `artifacts/installers/`，不提交。安装版无需 Node、Rust 或本地 Codex，首次确认自动预填的身份和工作区后连接中央。

如果中央网关已经在中央机运行，在设置页核对 Central Gateway 和上述 UI 地址。设置页支持统一填写中央网关、选择本机工作区并“保存并应用”，自动重启 Agent、重建附件 IPC 和重连 UI；重启客户端后恢复。模型、推理强度、速度和主题继续沿用原本的本地持久化。`CODEXIA_*` 开发覆盖保留，页面显示覆盖来源，网关覆盖同步作用于 UI。网关连接成功不代表 Local Agent 已连接，需同时看到设备在线。

只做前端修改时，运行中的 Vite 会热更新；正式内嵌前端仍需重新构建桌面包。Rust/Agent 改动需要重建并由桌面重新启动 Agent。不要在已有 Tauri/Cargo 构建锁占用时重复启动构建，也不要为了刷新 CSS 重启中央网关。

快速验证：

```powershell
Get-Process desktop-spike,local-agent
Invoke-RestMethod http://192.0.2.10:4510/healthz
```

验证关闭行为：关闭桌面窗口后执行上述命令，应看不到本机两个进程，且中央对应设备下线。

按改动范围选用以下命令，不必每次文档或样式调整都重跑真实模型：

```powershell
npm run check --workspace @central-codex-spike/desktop
npm run build --workspace @central-codex-spike/desktop
npm run build --workspace @central-codex-spike/agentrpc-types
npm run build --workspace @central-codex-spike/test-gateway
cargo fmt --check
cargo check -p desktop-spike
cargo test -p local-agent
npm run history:smoke
npm run multi-session:smoke
```

附件/文件链路改动先构建 `local-agent` 和网关，再运行：

```powershell
cargo build -p local-agent
npm run attachment:smoke
node scripts/attachment-contract-smoke.mjs
npm run output:smoke
```

这些附件/输出脚本默认访问真实中央机；其中模型测试会消耗推理额度，并创建测试 Thread 和测试文件。增加真实原生图片生成验收时，先设置 `$env:OUTPUT_IMAGE_SMOKE='1'` 再运行 `npm run output:smoke`；完成后可用 `Remove-Item Env:OUTPUT_IMAGE_SMOKE` 清除本次会话变量。`npm run smoke` 使用 Fake Central，仅作协议回归，不能替代真实中央验收。

## 6. 当前已完成的功能

- Codexia Workspace 基础正式版布局；
- Central Gateway 连接、Thread 创建/恢复/重命名/归档；归档 Thread 在设置页可恢复或永久删除；
- 对缺少当前 rollout 的历史 Thread，归档/恢复/删除会由平台保存对话元数据，不因 App Server 的 `no rollout found` 错误阻塞管理操作；
- 主页采用对话优先布局：列表顶部仅保留刷新，对话项仅保留编辑和归档；归档管理集中在设置页；
- 重命名使用应用内对话框（支持 Enter 保存、Esc/遮罩关闭），不再使用浏览器原生 `prompt`；
- 对话消息区独立滚动，输入框底部悬浮并预留安全间距，切换 Thread 后自动滚动到最新消息；
- 刷新、编辑、归档使用统一尺寸的线性 SVG 图标；浅色主题已提高辅助文字和状态文字对比度；
- 流式对话、Markdown 消息和中断；
- 中央连接后通过 App Server `model/list` 获取可用模型，并在对话输入框切换模型、推理强度和速度；
- 模型菜单主菜单及子菜单在浏览器预览中完整展开；已移除底部“高级”占位行及相关样式。桌面可访问性树已确认只保留三项，完整桌面点击复核仍见验收清单；
- 附件添加、预览、发送及历史恢复；纯图片可无正文发送，失败保留草稿，未知提交结果先“核对历史”，避免重复 Turn；
- 图片输出有保存中/已保存/失败状态，本机路径、校验结果和失败重试；源设备身份或文件版本不一致时提示错误；
- 旧对话中两张生成图片已恢复到 `C:\Users\developer\Downloads\Codexia`，并在本机核对 SHA-256 一致；
- 工作区目录浏览和文件读取；
- 客户端 `device_exec`，支持本机 PowerShell；
- 中央侧自动拒绝不应由中央处理的系统审批；
- Local Agent 主动出站连接；
- Local Agent 随 Tauri 客户端自动启动/停止；
- 真实中央机网关连通和设备工具调用验证。
- 长命令不再等待结束后一次性显示：Agent 按行或 250 ms 分块发送，Turn 中断终止关联客户端进程树，网关按 Thread/Turn 所有权路由且不持久化原始输出。

新增设备工具：`device_read_text` 按页读取附件文本；`device_write_file` 写文本；`device_copy_file` 复制；`device_publish_file` 校验并展示客户端命令生成的文件；`device_output_paths` 查询实际目录；`device_list_outputs` 等待并查询图片保存结果。旧 Thread 没有新工具名称时，经 `device_exec` 的 `program='codexia.files'` 兼容入口路由到相同 Agent 方法，不执行同名程序，不要求重建用户对话。

## 7. 下一步工作

### P0：已完成（用户确认）

用户已确认桌面图片交互、模型菜单、截图粘贴/跨窗口拖拽、故障恢复及模型/推理强度/速度参数生效验收完成；这些记录是用户验收结论，不冒充本轮代理重测。

### P1：完善配置和文件体验

- 统一 UI 连接设置与 Agent 启动配置已实现；使用现有设置页，详见本轮统一配置验收文档。
- Windows x64 与 macOS arm64 新试用包均已生成，加入自动身份与默认工作区；Mac DMG 通过 `hdiutil verify` 和包内 Agent 真实设备 smoke。后续补齐跨版本升级/卸载、独立 Windows 环境及 Mac 现场/异机验收。
- Windows PowerShell 5.1 / cmd 默认 CP936 输出乱码已修复；Mac 共享模块和本次首次配置代码均已同步，编译、进程专项及真实设备 smoke 通过。
- 本次旧开发客户端已关闭，安装版沿用原配置运行。NSIS 仍会检测并结束同名客户端，安装前应先保存工作并关闭应用。
- 取得发布签名身份后完成 Windows 签名、Mac Developer ID/公证，再进入正式分发。
- 根据后续用户确认再扩展 PDF/Office 解析、较大文件、更多文件结果交互；当前仅提供普通文件引用和已有读写工具。
- 按实际问题优化 Thread 列表、长输出、窄屏与错误提示，避免重做已存在的基础工作台。

### P2：生产化

- 平台认证、WSS/mTLS、用户/设备隔离、细粒度审批与审计、稳定 Worker 管理。
- 核心状态机测试按风险补齐；只改样式时执行前端检查、构建和对应 UI 复核。

## 8. 已知限制与注意事项

- 这是 Spike，不是正式生产客户端；
- 安装版首次确认中央地址、自动生成的用户/设备身份及默认工作区，保存后才创建默认目录、启动 Agent 和连接；已有配置沿用。Windows 配置为 `%APPDATA%/com.centralcodex.localspike/desktop-runtime-v1.json`，其他平台由 Tauri API 定位。当前只支持可信局域网 `ws://`，WSS 留待生产化；
- 试用包通过 Tauri externalBin 内置相邻 Agent；Windows 未签名，Mac 仅链接器 ad-hoc 签名、未公证；Windows 当前环境实装及同版本覆盖已通过，跨版本升级/卸载及独立分发环境仍待验收；
- 可信局域网模式允许附件/输出工具和命令 cwd 使用本机绝对路径，受 Agent 运行账号权限限制，不提升管理员/root 权限；相对路径和旧 `read_file` 仍保留 workspace 边界；
- 结构化写入覆盖不同内容必须携带 `overwrite=true` 和 `expectedVersion`，同内容重试幂等；该保护不替代普通 PowerShell/命令自身的覆盖语义；
- 输入图片每张 5 MiB、每回合合计 10 MiB，最多 10 个附件；输出图片/复制/发布最多 20 MiB，文本单次写入 256 KiB。图片解码限制 8192×8192 且不超过 1600 万像素；
- 截图临时文件由 Agent 在发送时保存，按 7 天期限登记，由后续导入触发过期清理；移除草稿不删除用户原文件；
- PDF/Office 尚无内置解析器；Windows 原有实机链路已验收，macOS 已在中央 Mac 同机编译和运行；远程会话无截图权限，Mac 现场界面/红色关闭按钮和独立 Mac 异机验收仍未完成；
- 浏览器预览只能验证通用前端交互，文件选择、附件预览、输出大图等本机 IPC 能力必须在 Tauri 验证；
- Vite 开发服务器是前端开发依赖，关闭 Tauri 不会自动停止由外部命令启动的 Vite 进程；
- 正式版本仍需认证、WSS/mTLS、用户/设备隔离、审批、审计和稳定的 Worker 管理。

## 9. 部署与 Git 交接

本次功能已部署到中央机 `/Users/operator/central-codex-platform/services/test-gateway` 并经用户授权重启现有 4510 网关。更新的是网关 `dist/index.js`、`dist/outputs.js` 及中央项目根目录下的运行依赖 `node_modules/@central-codex-spike/agentrpc-types/dist/index.js`。入口备份有 `dist/index.pre-attachments-20260903.js` 和 `dist/index.pre-outputs-20260903.js`。

最近三项样式/菜单调整仅修改客户端前端，未再重启中央。不要仅凭磁盘上的 dist 判断运行进程已加载新版；后续涉及网关部署时需检查真实版本和健康状态。SSH/SCP 仅用于开发部署与诊断，不进入产品客户端文件链路。

截至本次更新核对到的最近提交：

```text
8711853 docs: add repository agent instructions
4fa7b1b docs: add client UI and Local Agent handoff
d6f1e75 style: format Local Agent lifecycle code
030a5b7 build: prepare Local Agent before desktop dev
6554ef0 feat: manage Local Agent with desktop lifecycle
```

**当前工作区并未清理或提交。** UI、附件、输出、协议、Rust 依赖和文档存在修改及未跟踪的新文件。接手时先检查 `git status --short` 和 diff；不能只提交已跟踪文件，否则会遗漏 `attachments.tsx`、`outputs.tsx`、Agent/网关模块及 smoke 脚本。

已核对保留 `stash@{0}: On main: backup before Codexia worktree integration`。本次未恢复或删除；在未来操作前重新检查，stash 序号可能变化：

```powershell
git -C C:\Workplace\central-codex-platform stash list
```

不要直接覆盖或删除该 stash。

## 10. UI 验收清单

勾选表示已有记录支持，不表示本次文档更新重新执行。浏览器、协议和桌面点击证据分别列出。

- [x] Windows 客户端启动，中央连接与 Local Agent 上线；关闭时 Agent 退出，再启动重新上线，按来源设备和数量增减验收。
- [x] 真实 Thread 对话、文本读取及客户端 PowerShell 执行。
- [x] Tauri 原生选图、无正文纯图片发送、模型正确识图、草稿清空与重启后的历史卡片恢复。
- [x] 附件入口为左下角加号，旧“本地路径”入口已移除并经 Tauri 实测。
- [x] 真实模型生成图片、实时输出事件、客户端保存和 SHA-256 校验；原对话两张图片恢复。
- [x] workspace 外文本写入、绝对 cwd、旧工具兼容入口、版本覆盖、命令失败和图片保存重试通过真实链路测试。
- [x] 主模型菜单及模型子菜单在浏览器预览完整显示，不再被输入框滚动区域裁剪。
- [x] “高级”、箭头和分隔线已移除，TypeScript/Vite 通过，Tauri 可访问性树已确认无该行。
- [x] 紧凑缩略图尺寸及模型全部菜单，在 Tauri 完成无遮挡截图和点击复核（用户确认）。
- [x] Tauri 查看大图、关闭预览、打开所在目录完整点击验收（用户确认）。
- [x] 截图粘贴和跨窗口拖拽完整 UI 验收（用户确认）。
- [x] 网关/Agent 故障时重连、保存失败恢复的完整桌面验收（用户确认）。
- [x] 模型、推理强度和速度各项切换对下一 Turn 参数生效的逐项复核（用户确认）。
- [x] 统一配置保存/切换、真实目录浏览、窗口关闭注销和重启恢复（本轮新增验收）。
- [x] macOS arm64 原生编译、配置进程专项、真实设备工具和应用正常退出验证（中央 Mac 同机）。
- [ ] macOS 现场页面、目录选择、附件操作和红色关闭按钮验收；独立 Mac 异机验证。
- [x] Windows x64 / macOS arm64 试用包构建，包内 Agent、搬迁运行和真实设备工具验证；Mac 包内应用正常退出。
- [x] 首次配置进程专项：未选目录不启动 Agent，首次保存、失败保护和重启读回。
- [ ] 安装向导、Finder 安装、安装后首次设置页点击、升级与卸载验收；发布签名及公证。
- [x] 主页对话区只保留刷新；对话项只显示编辑和归档操作。
- [x] 设置页可查看归档对话，并只允许从该处永久删除。
- [x] 重命名使用应用内弹窗，消息区滚动和悬浮输入框不遮挡最后一条内容。

最近通过的自动验证：AgentRPC/网关构建、桌面 TypeScript check/Vite build、Rust fmt/check、Local Agent 8 项测试、历史 smoke；真实链路返回 `OUTPUT_REAL_SMOKE_OK` 和 `OUTPUT_NATIVE_IMAGE_SMOKE_OK`。最后的纯 UI 修改只重跑前端检查/构建与对应页面复核，未重复消耗模型验收额度。

## 11. 接手时的代码入口

以下路径均相对 `spikes/local-dev/`：

| 入口 | 职责 |
|---|---|
| `apps/desktop/src/App.tsx`、`styles.css` | 消息发送、输出事件、模型菜单、`.composer-body` 滚动边界、紧凑图片样式 |
| `apps/desktop/src/attachments.tsx`、`outputs.tsx`、`thread-history.ts` | 附件草稿、本机输出卡片、历史恢复与去重 |
| `apps/desktop/src/platform-gateway-client.ts`、`codexia-gateway-adapter.ts` | 前端协议适配、请求超时、重连 |
| `apps/desktop/src-tauri/src/main.rs`、`capabilities/`、`tauri.conf.json` | Agent 生命周期、匿名管道、原生选择和事件权限、图片 CSP |
| `apps/desktop/src/runtime-settings.tsx`、`apps/desktop/src-tauri/src/runtime.rs`、`crates/local-agent/src/runtime.rs` | 统一配置 UI、持久化/环境覆盖、进程及 IPC 切换、忙碌保护 |
| `crates/local-agent/src/main.rs`、`attachments.rs`、`outputs.rs` | 来源设备、客户端文件读写/校验/预览/目录操作、命令执行 |
| `services/test-gateway/src/index.ts`、`attachments.ts`、`outputs.ts` | App Server 适配、设备路由、附件提交、图片结果保存与状态 |
| `packages/agentrpc-types/src/index.ts`、`schema/agentrpc-v1.schema.json` | AgentRPC 方法、能力及元数据 |
| `scripts/attachment-smoke.mjs`、`attachment-contract-smoke.mjs`、`output-smoke.mjs`、`thread-history-smoke.ts` | 真实链路、负向协议和历史回归 |
| `scripts/package-desktop.mjs`、`apps/desktop/src-tauri/tauri.bundle.conf.json` | 原生匹配目标、sidecar 暂存、用户级安装器与应用/DMG 构建 |

协议参数与大小/超时上限以 [AGENTRPC](../spikes/local-dev/AGENTRPC.md)、[README](../spikes/local-dev/README.md)及对应实现为准。继续在现有工程修改，不创建平行产品目录。
