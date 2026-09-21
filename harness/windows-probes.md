# Windows P0 隔离与运行探针

这些文件只用于开发验收，不接入正式网关，不是 Windows Worker 实现。测试只创建新的合成目录、一次性 AppContainer profile 和 Job；不读取真实凭据、不修改现有桌面 ACL 或网络例外。

当前结果：窄范围 Windows CODEX_HOME 修复后，真实 App Server 在 AppContainer/Job 内初始化、两项本机 RPC 拒绝、Job 回收和 5 个 SQLite 数据库只读完整性检查均通过。网络权限拒绝、真实模型与 Local Agent 闭环、正式 Windows Worker 仍未验收；整体保持 `deployable=false`。下文保留修复前失败对照。

## 编译

在 `.` 执行，先建立 `target/central-p0`。以下命令在加载 `vcvars64.bat` 的 x64 Native Tools 命令提示符中运行（本机入口为 `C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat`）：

```bat
cl /nologo /std:c++17 /EHsc /W4 /MT harness\windows-isolation-probe.cpp /Fe:target\central-p0\windows-isolation-probe.exe /Fo:target\central-p0\windows-isolation-probe.obj
cl /nologo /std:c++17 /EHsc /W4 /MT /DYUAN_PROBE_CHILD harness\windows-isolation-probe.cpp /Fe:target\central-p0\windows-isolation-child.exe /Fo:target\central-p0\windows-isolation-child.obj
cl /nologo /W4 /GS- /c harness\windows-loader-probe.c /Fo:target\central-p0\windows-loader-probe.obj
link /nologo /ENTRY:probe_entry /NODEFAULTLIB /SUBSYSTEM:CONSOLE target\central-p0\windows-loader-probe.obj kernel32.lib /OUT:target\central-p0\windows-loader-probe.exe
cl /nologo /W4 /MT harness\windows-ipc-probe.c /Fo:target\central-p0\windows-ipc-probe.obj /Fe:target\central-p0\windows-ipc-probe.exe
```

## 合成系统调用探针

```powershell
.\target\central-p0\windows-isolation-probe.exe C:\Workplace\central-codex-platform\target\central-p0\NEW_RUN_NAME
```

测试目录必须是不存在的本地绝对路径，父目录必须已存在，路径及祖先不能是 reparse point；已有目录不会重用。进程须有创建 AppContainer profile 的权限，受限自动化沙箱用户可能需要使用获准的宿主执行上下文。工具的 `require_escalated` 在这里表示脱离自动化受限沙箱执行纯 QA，不是要求以 Windows 管理员运行；探针不申请管理员权限，也不设置网络例外。

子进程使用 AppContainer（无 network capabilities）、只对白名单合成路径授权、显式环境变量、Job `KILL_ON_JOB_CLOSE` 和 `ACTIVE_PROCESS_LIMIT=1`。先以挂起状态创建、加入 Job 后才继续执行。检查自有读写、中央与跨用户文件拒绝、指向中央 canary 的 hardlink 拒绝、父环境不继承、创建子进程因 Job 配额以 1816 拒绝。独立启动 hold worker，确认仍存活后关闭 Job，再等待退出。失败路径也关闭 Job 并有界等待。

网络检查监听本机随机 loopback 端口，等待非阻塞 connect 的完成状态。只有明确 `WSAEACCES=10013` 视为拒绝；`10035` 仅为进行中，`10060` 超时不能证明访问策略拒绝。网络不通过仍继续独立生命周期检查。

`alice/result.json` 保存分项结果，`summary.json` 保存整体结果及 profile 清理、Job 回收状态。最新本机结果：文件和子进程边界、Job 回收通过；loopback 为 10060，故整体 `passed=false`、`deployable=false`。

附加 `--spawn-baseline` 可运行无 Job active-process limit 的 AppContainer 对照，保留 Job kill-on-close。仅当相同二进制创建的后代写出 ready、仍存活并随后被明确终止时，基线通过。本机基线 `childCreateError=0 / descendantReady=true`，受限模式 `childCreateError=1816`。基线的 `passed=true` 仅证明子进程可启动，scope 明确不是隔离验收。

## Loader 对照

在全新测试目录后附加下列参数之一：

- `--loader-only`：仅 AppContainer 与 Job kill-on-close。
- `--loader-policy`：另外启用 `PROCESS_CREATION_CHILD_PROCESS_RESTRICTED`。
- `--loader-joblimit`：另外启用 Job active-process limit 1。

本机 policy 对照在进入程序前失败，退出码 `0xc0000142`；Job limit 对照可进入程序。因此完整探针使用 Job 限制，并实际检查子进程创建被拒绝。Loader 成功只证明可进入程序，不是隔离验收。

## 继承管道与真实 App Server

使用空的独立 `CODEX_HOME`、`CODEX_REMOTE_WORKSPACE=1`、`CODEX_REMOTE_AUTH_MODE=broker` 和白名单环境。只继承 stdin/stdout/stderr 三个允许句柄。额外创建可继承的合成 central-canary 文件句柄，故意不加入白名单；IPC fixture 尝试读取这个句柄并要求无效句柄。当前系统直接抛出 `STATUS_INVALID_HANDLE=0xc0000008`，fixture 仅捕获这一精确异常并单独记录。无模型令牌、真实凭据或网络例外。Launcher 收集 initialize 和本机 command/fs RPC 响应，Node 对完整 JSON 精确验证 ID、marker 和预期的 `-32602 / REMOTE_WORKSPACE_UNSUPPORTED`，并检查没有命令副作用。

```powershell
# 只证明继承管道可通信的合成 fixture
.\target\central-p0\windows-isolation-probe.exe C:\Workplace\central-codex-platform\target\central-p0\NEW_IPC_RUN --runtime-binary C:\Workplace\central-codex-platform\target\central-p0\windows-ipc-probe.exe
node harness/windows-runtime-verify.mjs target/central-p0/NEW_IPC_RUN --ipc-fixture

# 固定上游版本、应用现有补丁且完成构建的真实 App Server
.\target\central-p0\windows-isolation-probe.exe C:\Workplace\central-codex-platform\target\central-p0\NEW_RUNTIME_RUN --runtime-binary C:\ABSOLUTE\BUILD\codex-app-server.exe
node harness/windows-runtime-verify.mjs target/central-p0/NEW_RUNTIME_RUN
```

Launcher 的 `receivedResponses=true` 只表示完成传输收集，必须再看 `runtime-verified.json`。合成 fixture 不能用于真实运行验收。真实模式结果也只覆盖初始化与两个 RPC 拒绝，不覆盖真实模型、Local Agent、完整网络隔离或生产权限。句柄验收仅覆盖这个明确遗漏的 canary，不是任意句柄的穷尽测试。继承 stdio 管道成功不代表现有 HTTP Model Broker 已获得可用的 Windows 受限传输实现。

## 2026-09-10 修复前真实运行阻塞与最小诊断

固定上游 `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`、应用现有 remote-workspace 补丁的 Windows App Server 已成功构建。实际测试二进制 SHA-256：`a4baf5d502a66919a454e1711010e1a8a60be1faa49ee3e8aace84b0064de850`。

两次均在相同 AppContainer/Job 隔离下、initialize 前退出 1：`failed to canonicalize CODEX_HOME: access denied (os error 5)`。第一次使用合成 workspace 下的 `alice/codex-home`；第二次设置 `YUAN_QA_USE_PROFILE_HOME=1`，只在新建的一次性 AppContainer profile 中建立 `AC/LocalState/codex-home`。两次 profile 清理均成功，首次失败证据保留在 `target/central-p0/real-runtime-1`，第二次在 `real-runtime-2`。这不是构建失败，也不是已验证的真实运行链路。

合成 IPC fixture 对两种布局的 Win32 调用得到相同结果：

| 操作 | Win32 error |
| --- | --- |
| 读取目录 attributes | 0 |
| `CreateFile` 目录 `FILE_READ_ATTRIBUTES` | 0 |
| `GetFinalPathNameByHandle`，NORMALIZED + DOS | 5 |
| 同上，OPENED + DOS | 5 |
| 同上，NORMALIZED / OPENED + NT | 0 / 0 |
| 同上，NORMALIZED / OPENED + NONE | 0 / 0 |

证据表明失败集中在 DOS 卷名形式；自有目录本身可以读 metadata 并打开。仍未确认更底层原因，不能直接归因为祖先 ACL，也不能据此认定改用 NT/NONE 输出即可安全替代真实运行时的规范化。没有修改现有目录 ACL、绕过 canonicalize 或修改真实 fork 的行为。生产 Windows 运行目录和规范化兼容方案仍是下一阶段的必解阻塞。

诊断证据：`target/central-p0/ipc-canonical-workspace-1/runtime-verified.json` 和 `ipc-canonical-profile-1/runtime-verified.json`；归档分项结果见 `harness/verification/windows-p0-probe-2026-09-10.json`。真实模型、设备闭环、完整网络隔离和正式 Windows Worker 均未验收通过。

### 经用户确认后的修复候选对照

扩展 GUID 检查：AppContainer 内 NORMALIZED/OPENED + VOLUME_NAME_GUID 均返回 5。使用 `YUAN_QA_USE_GUID_HOME=1`，由父 launcher 对新建空目录取真实 GUID 路径，再传给未修改的旧二进制，仍在 canonicalize CODEX_HOME 阶段返回 5。该路径转换没有改 ACL，但不足以单独解决启动问题。证据：`ipc-canonical-guid-1`、`real-runtime-guid-1`。

NT 路径候选：对目录句柄取得 NORMALIZED + VOLUME_NAME_NT，再加 `\\?\GLOBALROOT`。在 AppContainer 内重新打开成功，卷序列号和 file index 与原目录一致；通过该路径创建、写入、读回合成 canary 成功；设为本 probe 的 cwd 后相对路径 canary 读写成功，再恢复原 cwd 成功。证据：`ipc-canonical-globalroot-1/runtime-verified.json`。这只证明该系统上的 Win32 路径候选可用，真实 App Server 修复与回归结果须另行记录，不能拿合成成功替代。

### 精确 Rust helper 隔离测试

`windows-home-helper-probe.rs` 用 `#[path = "windows_home.rs"]` 编入修复候选的同一份源文件，未复制一份替代实现。直接用 rustc 编译，不启动 Cargo：

```bat
rustc --edition 2024 -C target-feature=+crt-static harness\windows-home-helper-probe.rs -o target\central-p0\windows-home-helper-probe.exe
```

通过同一 launcher 的 `--runtime-binary` 指定此 fixture，随后 `node harness/windows-runtime-verify.mjs QA_DIRECTORY --home-helper-fixture`。该模式有独立合成标记，不能作为真实 App Server 验收。

`target/central-p0/rust-home-helper-1/runtime-verified.json` 记录：AppContainer 内原始 std canonicalize 返回 5，helper 成功规范化自己的 CODEX_HOME 并完成函数内文件身份复核；中央和 bob 目录均返回 5；不存在路径、普通文件、调用者传入的设备路径及相对路径均拒绝；去掉 remote 标志后仍返回 5，不触发 fallback；规范化目录作为 cwd 后相对读写成功且恢复 cwd。Job 回收与 profile 清理通过。本次 helper 源码 SHA-256 为 `846cbff7738ca048e506f8849fecc19772e0efdb339f0688ab7be1e384f50bd5`。

补充负例：设置 `YUAN_QA_HOME_HELPER_LINKS=1` 后，launcher 只在新 QA 树的 alice 目录创建两个 junction，目标分别为同一树内禁止读取的 central、bob 目录。`rust-home-helper-negative-1/runtime-verified.json` 确认两者仍返回 5；卷根和 loopback 上随机不存在的 UNC 共享路径被拒绝，其他 helper 检查继续通过。没有修改旧目录 ACL 或请求管理员权限。测试目录中的 junction 属于保留的 QA 证据，不应在未确认目标边界时对其递归清理。

### 修复后的真实运行验收

新二进制 SHA-256：`16b376cc99d2a0d23e542af33dcc0f64de3e2ba917f45f536fa5e9358c82f20a`。它保留固定上游版本及原有 remote-workspace 边界，加入经过上述隔离负例验证的 Windows home helper。

`target/central-p0/real-runtime-homefix-1/runtime-verified.json` 已通过：普通本地 drive 路径的全新空 CODEX_HOME，无新增网络能力，在原 AppContainer/Job 限制下成功返回 initialize marker；`command/exec` 和 `fs/readFile` 均精确返回 `-32602 / REMOTE_WORKSPACE_UNSUPPORTED`；没有命令副作用；关闭 Job 后退出，profile 清理成功。`alice/runtime-stderr.log` 为 0 字节，initialize 返回经句柄身份复核的 GLOBALROOT home。

运行时实际创建 `state_5`、`logs_2`、`goals_1`、`memories_1`、`queue_1` 五个 SQLite 数据库。Job 关闭后执行：

```powershell
node harness/windows-sqlite-check.mjs target/central-p0/real-runtime-homefix-1
```

检查器使用 Node `DatabaseSync({readOnly:true})` 对每个库执行 `PRAGMA quick_check`，五项均为 `ok`，结果在同目录的 `sqlite-quick-check.json`。这证明本轮启动、基础数据库初始化和强制回收后的数据库状态可用；没有运行模型、访问真实凭据或把该结果扩大为完整产品可部署结论。
