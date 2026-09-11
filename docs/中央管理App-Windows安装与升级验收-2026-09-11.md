# 中央管理 App：Windows 安装与升级验收

日期：2026-09-11。接续[设置与诊断](中央管理App-设置与诊断-2026-09-10.md)，在现有 monorepo 内增加独立安装验收入口。

## 本轮目标与边界

准备 Windows 当前用户 NSIS 验收包，验证初次安装、同版覆盖和 `0.1.0 → 0.1.1` 应用版本升级。两版使用同一个完整网关候选 `windows-x64-node24-qa1-74b3e6f43896219f`；网关运行包更新和数据模式迁移需要另外验收。

验收版使用独立身份：产品名“远舟中央管理安装验收”、标识 `com.yuanzhou.central.installqa20260911`、主程序 `yuanzhou-central-install-qa-20260911.exe`。安装位置限定为本源码目录下 `spikes/local-dev/target/central-install-qa/installed`，和已有工作客户端、正常中央 App、前序资源 QA 配置分离。

包为 Debug 验证候选，保留现有 Release 启动资格门禁，不将运行包改为 `qualified:true`。本轮不调用真实模型或读取本机真实 Codex 登录；原生验证仅创建独立合成管理员、模型凭据、证书和用户。系统已具备 WebView2，验收包不下载或安装共享运行时，因此本轮不是缺少 WebView2 的干净系统验收。

## 安装及数据策略

产品文件安装和删除限定在固定 QA 安装目录，注册项及快捷方式使用独立 QA 名称。更新前必须关闭该验收版及其受管服务；安装器阻止运行中替换，不强杀进程。安装器和卸载器保留 AppData 配置、DPAPI、证书与中央数据。默认 NSIS 模板先执行 `SetOutPath` 再调用路径 hook，所以传入错误 `/D` 可能创建空目录，随后拒绝复制产品文件；不能将其描述为错误目标完全没有副作用。

进程保护采用有界 Toolhelp 枚举；发现验收程序、查询失败或超过 4096 项上限均阻止，并覆盖默认模板的强杀分支。安装前另读独立 HKCU 64 位卸载项，只接受已知版本 `0.1.0`、`0.1.1`，拒绝降级、版本未知和读取失败；仅键不存在时允许首次安装。卸载前将删除 AppData 的复选框状态清零，静默与交互入口均保留资料。

诊断版本展示改用 Tauri 的实际应用包版本，避免安装版本 `0.1.1` 仍显示 Cargo 工作区版本 `0.1.0`。已有配置不因应用版本更新自动改写。

## 验收结果

两版均已完成本机实装。现有正式工作客户端为 `远舟 0.1.0`；本轮 QA 安装目录和独立 QA AppData 在执行前均不存在。

| 项目 | 实测结果 |
| --- | --- |
| 初装 0.1.0 | 静默安装退出码 0，独立注册版本与目录正确 |
| 合成资料准备 | 原生入口 1 项通过，35.61 秒；创建两名合成用户，服务退出清理通过 |
| 运行中同版安装和升级 | 退出码均为 10，原窗口进程保持运行 |
| 同版覆盖 | 退出码 0，8 项原生资料文件名称、长度、SHA-256 全部一致 |
| 0.1.0 → 0.1.1 | 退出码 0，注册版本更新；8 项资料文件全部一致 |
| 静默降级 | 0.1.1 上执行 0.1.0 退出码 12，资料保持一致 |
| 升级后原生读取 | 1 项通过，33.22 秒；配置 v1、DPAPI 账号、TLS 证书、原用户可用，服务清理通过 |
| 实际安装版 UI | 0.1.0 与 0.1.1 诊断分别显示正确版本；升级后恢复合成账号并成功启动服务 |
| 安装资源来源 | 0.1.1 App 从系统目录启动，PATH 不含全局 Node；网关 Node、脚本及 PID 父子关系均来自固定安装目录 |
| 实际窗口生命周期 | App 关闭后受管网关退出，独立回环端口释放；零负载指标为设备/任务/Worker 均 0 |
| 运行中卸载 | 退出码 10，窗口及网关仍运行 |
| 关闭后卸载 | 退出码 0，安装目录及 QA 卸载注册项移除；10 项原生资料哈希不变 |
| 重装 0.1.1 | 退出码 0，10 项资料哈希不变，程序与全部资源再次通过校验 |
| 重装后原生读取 | 1 项通过，33.26 秒；原配置、账号、证书及用户可用，服务清理通过 |

资料哈希分别在覆盖/升级之前、卸载之前采集；原生验证与 GUI 启停会合法更新服务操作记录和审计，所以不能跨这些运行操作比较整个资料目录。验收没有读取真实模型登录或调用模型；保留的账号、证书和用户均为测试合成资料。当前宿主是 Codex MSIX，原生资料实际映射到该宿主 `LocalCache/Roaming` 下的独立 QA 标识；普通 Explorer 启动下的非 MSIX 配置路径尚需另验。

原生回归 `cargo test -p central-app --offline`：67 项通过，9 项需显式 opt-in 的验收测试忽略。新增安装资料准备测试已执行一次，保留验证已在升级后、重装后各执行一次，均通过。前端 TypeScript 检查与 Vite 构建通过，`cargo fmt -p central-app --check` 和 `git diff --check` 通过。

实装测试直接执行这次回归产生的测试可执行文件中的 `install_qa` 入口，避免与第二版构建争用 Cargo。这不代替安装版 UI：上表另列了真实安装程序的诊断、账号恢复、启动和窗口退出验收。

## 产物与已修正问题

- 0.1.0：`target/central-install-qa/0.1.0/1789090708124-642f3650-d875-4197-869d-53ee93fddd43`，安装器 69,374,077 字节，SHA-256 `80913b1e8883a8b9ff23cfa8c401a519d377f07b1f9c6243b9ad33157a82d922`。
- 0.1.1：`target/central-install-qa/0.1.1/1789090948819-3d0fca56-9444-47b6-a651-5cce46f45ef0`，安装器 69,371,114 字节，SHA-256 `cf15201024cb2041f9fd530a4e30d7dd40ad0fe213dd1d55a6b39fdb690f7208`。
- 安装后的 0.1.1 主程序 SHA-256：`f1983dc792e5e973d67927d1a93de86c5b80bad332079f1195a0ee9f5e422f93`。
- 两版均包含完整服务的 864 个文件加 manifest。安装后通过内置固定清单逐项校验；没有重复打入旧的单 App Server `central-runtime` 资源。

首次构建的产物检查发现 WebView2 `skip` 实际渲染为空模式，脚本原先误判为字符串 `skip`；修正后重包，失败目录保留 `ok:false` 记录且未用于安装。另修复了默认模板静默入口不可靠拒绝降级的问题。

Tauri 打包时会将主程序中唯一的 `__TAURI_BUNDLE_TYPE_VAR_UNK` 改为 `__TAURI_BUNDLE_TYPE_VAR_NSS`，打包后的 Cargo 副本恢复为 `UNK`。本机两个版本核对只差这 3 个字节。新增只读校验脚本仅允许这项内存归一化，然后比较全部字节；安装版 0.1.1 与旧 0.1.0 产物比较会拒绝，不能用标记差异豁免其他二进制差异。

## 复现入口

本轮文件：`scripts/package-central-qa.mjs`、`scripts/verify-central-qa-installed.mjs`、`apps/central/src-tauri/tauri.install-qa.conf.json`、`apps/central/src-tauri/install-qa-hooks.nsh`、`apps/central/src-tauri/src/install_qa.rs`、`apps/central/src-tauri/src/main.rs`。结果摘要保存到 `harness/verification/central-install-qa-2026-09-11.json`，README 与主交接已同步。

在 `spikes/local-dev` 中串行打包，禁止与其他 Cargo 构建同时执行：

```powershell
node scripts/package-central-qa.mjs --version 0.1.0
node scripts/package-central-qa.mjs --version 0.1.1
node scripts/verify-central-qa-installed.mjs --build <成功构建目录的绝对路径>
```

脚本不安装或启动程序。每次构建在 `target/central-install-qa/<version>/<唯一编号>` 保存计划、配置、安装器、程序、NSIS 模板及 SHA-256；只有 `build-result.json` 的 `ok:true` 表示完整打包检查通过。`--prepare-only` 仅生成计划，不能作为安装验收。

原生验收使用固定独立资料目录；首次准备只能执行一次，之后使用验证入口读取保留的数据：

```powershell
$env:CENTRAL_INSTALL_QA_ALLOW = '1'
$env:CENTRAL_INSTALL_QA_RESOURCES = 'C:\Workplace\central-codex-platform\spikes\local-dev\target\central-install-qa\installed'
cargo test -p central-app --offline install_qa::prepare_installed_profile -- --ignored --nocapture
cargo test -p central-app --offline install_qa::verify_installed_profile -- --ignored --nocapture
```

上述原生测试通过源码测试入口使用已安装资源；安装后的程序界面和生命周期另行验收，不能用原生测试代替。

安装命令使用成功构建目录中的安装器，参数 `/S /D=<固定安装目录>`，`/D=` 必须最后，不加自动启动参数 `/R`。可等待的卸载验收先将 `installed/uninstall.exe` 复制到安装目录之外的 QA 证据目录，再执行该副本 `/S _?=<固定安装目录>`，`_?=` 最后；必须先确认窗口和网关退出。

## 后续未验收范围

最终状态：独立 QA 0.1.1 保留安装，合成资料保留；QA 主程序、网关和回环监听均为 0。原有 `远舟 0.1.0` 的注册版本与安装目录仍与执行前基线一致。未创建 Git 提交，构建包和私有测试资料留在忽略目录内。

本轮没有取得正式 Release 资格、代码签名、缺少 WebView2 的干净系统安装、普通 Explorer 启动环境验收、网关运行包或数据模式升级、不同 Windows 用户间迁移、远端客户端和 macOS 中央适配。没有更新真实中央机的 4510 服务。后续应优先补非 MSIX 启动环境和远端客户端验收，再决定正式安装路径及发布包策略。
