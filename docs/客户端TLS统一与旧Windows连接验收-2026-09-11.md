# 客户端 TLS 统一与旧 Windows 连接验收

日期：2026-09-11。用户确认统一 TLS 实现、保留证书验证并交付测试包。

## 故障证据与范围

故障电脑为 Mac 硬件安装的 Windows 8.1 专业版（6.3.9600），地址 `192.0.2.30`。用户提供的检查显示正式中央 `192.0.2.10:4510` TCP 可达，时间在中央证书有效期内。界面已有配对用户与设备身份，但后续授权检查、桌面 WSS 与 Agent 连接失败。

源码确认一体配对使用 Rustls，后续 HTTP 状态检查、撤销与 WSS 使用系统 TLS。这是与故障阶段吻合的兼容差异。原版没有保留细分握手错误，因此尚未在故障 Windows 8.1 上确认底层具体错误；本轮交付供该机复测，不代表完整 Windows 8.1 平台认证。

## 改动

- `crates/platform-security/src/transport.rs`：共用 Rustls 配置、HTTP 客户端和安全错误分类。TLS 使用安全默认协议；显式 CA 仅信任给定 CA，无 CA 时读取系统根证书。保持证书链、主机名、有效期验证。
- `src/lib.rs`、`src/pairing_bundle.rs`：配对、授权状态、撤销、桌面与设备 WSS 统一使用 Rustls；HTTP 关闭环境代理、重定向与自动重试。现有 mTLS 显式身份配置仍保留。
- 移除平台安全库直接依赖的 native-tls 与对应特性，避免持续连接回退到系统 TLS。其他组件的系统依赖不在本轮移除范围。
- `apps/desktop/src/platform-pairing-state.ts`、`src/native-gateway-socket.ts`、`src/platform-gateway-client.ts`：固定安全错误码贯穿状态页和连接提示，区分证书过期、未生效、主机名不符、不受信任、握手失败、连接被拒绝及超时。不展示原始异常、令牌或完整 URL；连接失败不误标为授权撤销。
- 凭据格式、应用标识、用户配置与配对身份不变。中央服务无需更新。

## 本地回归

从 `spikes/local-dev` 运行相应命令：

- `cargo check -p platform-security -p local-agent -p desktop-spike --offline`、`cargo check -p central-app --offline` 和 `cargo fmt --check -p platform-security` 通过。
- 真实 Windows 用户上下文运行平台安全库 27 项单测、Local Agent 19 项单测，均通过，覆盖 DPAPI/ACL 与固定错误分类。
- `node scripts/device-token-native-smoke.mjs --helper <platform-acceptance.exe>`：16 组通过。TLS 1.2-only 服务验证配对、跨进程凭据恢复与实际 Rustls WSS；HTTP/WSS 均拒绝无关 CA 和受信但主机名错误的证书；替换、旧令牌撤销与本地清理通过。报告：`target/device-token-native-ci7VzX/result.json`。测试初版使用同名但不同密钥的 CA，实际返回签名无效，调整无关 CA 名称后准确覆盖未知签发者分类。
- `node --no-warnings --experimental-strip-types scripts/platform-pairing-ui-smoke.ts` 与 `node --no-warnings scripts/gateway-auth-reconnect-smoke.mjs` 通过；后者含 13 组连接和安全错误映射检查，报告：`target/gateway-auth-reconnect-KDoJiI/result.json`。
- TypeScript 检查和 Vite 构建通过。

## 正式链路与交付

`node scripts/pairing-native-ui-smoke.mjs <Playwright模块路径> --execution-layout` 通过。独立 Windows Tauri 客户端使用新 TLS 实现连接正式中央服务，真实 GPT-5.6-Sol/high 调用 Local Agent 执行只打印测试日志与等待的本机 PowerShell 脚本，模型最终回复成功。运行中、完成后和折叠展开共 7 组布局检查同时通过。实际页面截图已查看；结果位于 `target/desktop-execution-layout-20260911/result.json`，本轮专用设备为 `f30aa17c-4e46-423c-9eeb-078563ce77a1`，已撤销、取消本机配对并正常退出。

`node scripts/package-desktop.mjs --debug` 构建成功，包含新 Local Agent，Windows GUI 子系统验证通过。交付文件：

`spikes/local-dev/target/releases/pairing-20260911/远舟客户端_0.1.0_windows_x64_TLS兼容修复.exe`

- 大小：6604515 字节。
- SHA-256：`50f7a09c10877df8fa4779fb61ddbdd92140cf1382cf499bf458e3c46ab2bb62`。
- 包含此前一体配对、无终端启动、首次发送和执行布局修复。
- 退出故障电脑的旧客户端后覆盖安装，使用原配对点击“重试连接”或“保存并应用”，无需取消配对、另行导入 CA 或修改中央服务。
- 本轮测试在开发 Windows 环境完成，尚未在用户的 Windows 8.1 电脑实测。若仍失败，读取新提示中的固定错误码继续定位，不把旧系统兼容性视为已经验收。
- 仍为未签名 Debug 测试安装包；未替用户安装。Mac 客户端历史 DMG 本轮未重建。
