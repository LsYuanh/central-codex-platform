# Windows 实装与 Mac 兼容性复测

后续版本提示：本文件记录的是 2026-09-03 的旧安装器和实装证据。2026-09-04 自动身份与默认工作区版本的 Windows 安装器、校验值和验证边界见[客户端首次身份与默认工作区实施验收](客户端首次身份与默认工作区实施验收-2026-09-04.md)。

日期：2026-09-03。用户明确授权关闭旧客户端进行安装验收，并将本轮 4 个源码及 Cargo
文件同步到中央 Mac 的现有客户端构建目录。此次未修改产品代码、未创建模型 Turn、未重启中央网关。

## Windows 验收结果

使用已交付的 `Central Codex Local Workbench_0.1.0_x64-setup.exe`，SHA-256：

```text
24ecf099777eb08280817bc43a0cd9fda4d22067e79dba93fbf50a6a7ccc350a
```

| 项目 | 结果 |
|---|---|
| 关闭旧开发客户端 | 校验 PID 5868 路径后发送不带 `/F` 的退出请求，Agent 20144 一起退出，中央设备数 2→1 |
| NSIS 首次安装 | `/S` 返回 0，安装目录含桌面、Agent、卸载器，注册表版本 0.1.0，桌面/开始菜单快捷方式目标存在 |
| 安装内容 | Agent 与构建产物字节一致；桌面仅有 Tauri `__TAURI_BUNDLE_TYPE_VAR_UNK`→`NSS` 的正常包标记差异（3 字节） |
| 脱离开发环境启动 | PATH 仅含 Windows 系统目录及 PowerShell，桌面 13832 自动启动包内 Agent 23760，中央连接成功 |
| 原配置及历史恢复 | 配置文件哈希未变；实际页面显示原对话历史、中央已连接及 Agent 在线 |
| 安装版设备工具 | 经真实中央列目录、读取 README、执行默认 PowerShell cwd，返回 `PACKAGED_DEVICE_OK` |
| 安装目录 Agent 中文编码 | `encoding:smoke` 返回 `COMMAND_ENCODING_SMOKE_OK`，默认输出代码页/OEM 均 936，所有案例通过 |
| 标题栏关闭 | 原生关闭按钮实际点击成功，桌面 15392 与 Agent 22824 均退出，中央设备数 2→1；首次配置客户端关闭同样成功 |
| 无运行配置首次启动 | 备份并移开运行配置后，仅桌面 14916，未启动 Agent，中央连接数不增加；实际页面显示首次使用提示、OFFLINE、连接禁用 |
| 空工作区保存 | 页面明确显示“请选择本机工作区目录”，可继续修正 |
| 原生中文目录选择 | 通过“选择目录”打开系统选择器，选中验收目录，返回设置页；保存前仍不启动 Agent |
| 首次保存并应用 | 页面显示保存成功，中央与 Agent ONLINE；子 Agent 17328 自动启动，新中文 cwd 经真实设备工具确认 |
| 同版本覆盖安装 | 关闭应用后再次 `/S` 返回 0，工作区配置与设备身份哈希保持不变 |
| 重启恢复 | 桌面 11664 / Agent 19340 自动连接，设备工具继续使用新保存的中文目录，无需再次配置 |
| 恢复用户环境 | 原配置完整恢复，设备身份保持，最终仅安装版桌面 16544 与其 Agent 15020 运行，原工作区设备工具再次通过 |

原生选择的测试工作区：

```text
C:\Workplace\central-codex-platform\artifacts\package-verification\windows-安装验证\workspace
```

原配置路径：`%APPDATA%/com.centralcodex.localspike/desktop-runtime-v1.json`。
测试前与恢复后的 SHA-256 相同：

```text
4fd301efadf939bf2e24e8e1b821c97461325c6529be454ff7ed73a5c85fb178
```

设备 ID 保持 `desktop-1ce60276-a209-42ac-8cd9-b773d9f71f69`。
原工作区恢复为 `C:\Workplace\central-codex-platform\spikes\local-dev\fixtures\workspace`。
临时备份已恢复，不留待恢复操作；配置与验收记录副本在忽略目录 `artifacts/package-verification/`。

安装器报告目录为 `%LOCALAPPDATA%/Central Codex Local Workbench`。本次从 Codex MSIX
宿主执行，窗口工具显示实际文件映射到其 `LocalCache/Local/Central Codex Local Workbench`。
本轮结果限于该本机宿主环境，独立普通 Windows 用户环境的安装分发仍需验证。

窗口工具部分调用曾返回 `launched app did not expose a targetable window`、
`coordinate input geometry is unavailable`；重新列举窗口后确认实际启动，成功完成页面和
关闭按钮检查。不会将失败调用本身记为成功；末次恢复时用核对 PID/路径后的正常退出请求
清理测试实例，最终确认仅一个桌面及一个 Agent。

## Mac 复测

使用 colleague-pc-ssh，通过现有公钥直连 `operator@192.0.2.10`。同步范围仅为：

- `spikes/local-dev/crates/local-agent/src/main.rs`
- `spikes/local-dev/crates/local-agent/src/command_output.rs`
- `spikes/local-dev/crates/local-agent/Cargo.toml`
- `spikes/local-dev/Cargo.lock`

目标为 `/Users/operator/central-codex-platform/spikes/local-dev/` 内对应路径。
此前自动审批拒绝的传输，在用户明确授权后执行成功；未使用其他通道绕过。

使用已配置的项目 Node/Rust 和进程级 `DEVELOPER_DIR=/Library/Developer/CommandLineTools`：

| 检查 | 结果 |
|---|---|
| `cargo fmt --all -- --check` | 通过 |
| `cargo check -p local-agent --locked` | 通过 |
| `cargo test -p local-agent --locked` | 12 项通过，含共享 UTF-8/BOM/截断测试；CP936 专项仅在 Windows 编译 |
| `cargo build -p local-agent --locked` | 通过 |
| `npm run device:smoke` | 独立 `mac-encoding-regression` 设备，真实中央返回 `DEVICE_BROKER_SMOKE_OK` |

测试设备完成后退出。这里只把中央 Mac 借作客户端兼容性测试机，不能当作独立 Mac 异机
验收。已有生产运行目录及中央服务未改变。未重建 DMG，现有 DMG 保持上一轮哈希及版本。

## 后续工作

1. Windows 安装向导逐页检查、跨版本升级、卸载和独立普通 Windows 用户环境验收。
2. Mac 按最新源码重建试用包，完成现场界面、目录选择、关闭按钮及独立 Mac 异机验证。
3. 取得发布身份后完成 Windows 签名、Mac Developer ID/公证，再推进正式分发。

本次完成的是 0.1.0 同版本覆盖安装，不声称跨版本升级或卸载已经通过。安装器仍会结束
同名运行进程，安装前应先保存工作并关闭客户端。原仓库修改和 stash 保留，未创建 Git 提交。
