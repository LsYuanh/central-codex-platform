# 中央管理 App：Windows Worker 与网关候选包

本批延续已确认的中央端开发范围，把 Windows 隔离进程从 QA 启动器推进到现有网关可调用的原生 Host，并准备独立运行候选资源。中央 App 的实际服务启停、模型账号管理和正式分发资格仍未完成。没有更新正式 4510 服务，没有修改已安装客户端，没有使用真实模型凭据。

## 实现

- `spikes/local-dev/services/windows-worker-host/`：每个用户的独立原生 Host，稳定 AppContainer 身份、受保护用户目录、独占用户锁、只读运行文件及配置。通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建进程时原子加入 Job，限制进程数为 1，Host 退出时回收 Job。
- `services/test-gateway/src/windows-worker-transport.ts` 与 `windows-worker-bridge.ts`：受信文件哈希、独立租约、二进制启动参数、初始化 marker 检查、有限等待和消息大小限制。Worker 输出经 `host/data` Base64 信封转发，不能伪造 Host 清理回执。仅匹配实例的 `host/closed` 加 Host 正常退出才能释放槽位；不确定结果保留占用并报错。
- `worker-manager.ts`：可重放的退出证据、启动取消、超时后保留占用、按实例处理退出、限时 drain。网关收到关闭信号后等待 Worker、模型 broker 及监听连接收尾，取消立即 `process.exit(0)` 的旧行为。
- `crates/central-native-helper/` 与 `windows-private-json.ts`：Windows 凭据 JSON 通过原生同句柄读取，检查保护 ACL、物理路径、链接及大小。Node 校验 helper 哈希，限制 5 秒和输出大小；没有普通文件读取回退。helper 输出仅供中央进程内存使用。
- `scripts/stage-central-gateway.mjs`：打包明确指定的 Node 24、网关、生产依赖闭包，以及可选的 Host、App Server、原生读取 helper；保留许可证和逐文件哈希。候选包的 `ready`、`qualified` 始终为 false。

共享的模型管道实现移至产品 Host 目录，原 `harness/windows-model-pipe-bridge.hpp` 保留兼容入口。未将 QA 启动器作为产品入口。

## 真实验收发现及修复

1. Host 最初传入 Volume GUID 路径，固定 App Server 在 AppContainer 下的 CODEX_HOME 回退仅接受盘符路径，初始化前以退出码 1 结束。现从已锁定句柄取得 DOS 路径，并复核 volume/file ID 和 GUID 物理身份；没有修改固定 App Server 或放宽路径检查。
2. 原创建后再加入 Job 的流程存在父进程退出空窗，已改为创建时原子加入 Job；失败不回退到未纳入 Job 的启动方式。
3. Cargo debug helper 是硬链接产物，读取器正确拒绝；测试和运行包使用单链接副本。三个新副本首次执行均复现仅 ctime 变化，dev/ino/size/mtime/nlink 和内容哈希未变。现遇到 ctime 单独变化时，对原 FD 和重新打开路径的 FD 分别完整哈希，并复核三组文件身份稳定；不是直接忽略变化。8 项真实权限及冷启动检查通过，篡改和硬链接仍被拒绝。
4. Windows PowerShell 5.1 继承 PowerShell 7 的模块路径导致合成 ACL 脚本失败，已限定测试子进程环境及模块路径。ACL 测试仅操作新建合成目录。

## 验证结果与边界

网关 TypeScript 构建、原生 Host MSVC 构建、helper Rust 测试及格式检查通过。已验证：

| 检查 | 结果 |
|---|---|
| WorkerManager 现有测试 | 28 项通过 |
| 启动超时 | 3 项通过 |
| drain 与退出证据 | 7 项通过，含真实子进程 |
| Windows Host transport | 18 项协议测试通过；不替代 OS 验收 |
| 原生私密文件 / broker / pipe lease | 8 / 23 / 19 项实际 Windows 用户合成检查通过；读取检查含三个全新冷副本 |
| 真实原生 Host | 初始化 marker、并发单飞、双用户进程与目录分离、同用户重启、退出证据和进程消失通过 |
| 真实网关关闭 | 子进程退出、网关成功退出、监听端口关闭通过 |
| 路由及核心 harness 协议回归 | 路由 8 项、harness 网关回归通过 |

真实 Host 检查调用 initialize/thread-list，没有发送模型请求；重启保留目录和线程列表，不代表带消息线程恢复已验收。完整网络拒绝、父进程故障与背压实测、原生 Host 下真实 Turn/设备工具链、可信目录对同用户恶意替换的抵抗，以及 macOS 新流程尚未验收。结果文件见 `spikes/local-dev/harness/verification/central-worker-gateway-qa-2026-09-10.json`。

最终完整候选为 `spikes/local-dev/target/central-gateway/windows-x64-node24-qa1-bf607d2f19af1bc6`，包含 Node v24.20.0、22 个生产依赖、862 个文件及三种原生二进制。manifest SHA256 为 `bf607d2f19af1bc6199c1434c4085b7c54deb5064bada79910ddfb446f3ef640`。独立副本的完整性、额外文件/路径穿越/同长度篡改拒绝、健康检查和端口关闭通过。此处记录哈希供审查，尚未固定进中央 App 受信清单。

## 开发与运行接口

以下命令在 `spikes/local-dev` 执行：

```powershell
cargo test -p central-native-helper
cargo build -p central-native-helper
powershell -NoProfile -File scripts/build-windows-worker-host.ps1
npm run build --workspace @central-codex-spike/test-gateway
npm run workers:drain-smoke
npm run workers:transport-smoke
npm run gateway:shutdown-smoke
```

真实 native smoke 另需设置三组明确的二进制路径及 SHA256：`PLATFORM_WORKER_HOST_BINARY/SHA256`、`PLATFORM_WORKER_BINARY/SHA256`、`PLATFORM_NATIVE_HELPER_BINARY/SHA256`。使用普通单链接副本；然后运行 `npm run workers:native-smoke`。它创建自己的合成凭据及 Worker 目录，不读取本机真实登录。

网关候选模式必须显式设置 `PLATFORM_WORKER_ISOLATION=windows-appcontainer-v1`，同时满足 Windows、已有平台认证/TLS 配置、受保护模型绑定及上述二进制校验。缺配置或隔离失败直接拒绝，不降级为普通进程。Worker 根目录的父目录须已存在；末级根目录与用户目录由原生 Host 创建并检查，不能先用 Node 的 POSIX mode 模拟 Windows ACL。中央 App 尚未生成或应用这套配置。

独立候选包使用下列脚本参数（路径全部为明确的绝对路径）：

```text
node scripts/stage-central-gateway.mjs
  --source-root <本仓库>
  --node-exe <Node24 node.exe>
  --node-license <同一 Node 发行版 LICENSE>
  --worker-host <windows-worker-host.exe>
  --app-server <固定 codex-app-server.exe 普通副本>
  --native-helper <central-native-helper.exe 普通副本>
```

随后用 `node scripts/central-gateway-stage-smoke.mjs --candidate <输出目录>` 检查独立副本。生产依赖文件逐项记录哈希；没有把安装目录内容冒充为已通过 npm tarball integrity 验证。项目完整许可证分发检查和最终受信清单固定仍属于发布前事项。

## 下一步

将最终候选资源固定到中央 App 的原生受信清单，接入模型账号原生管理，再实现服务启动、停止、启动失败、退出未确认和重试状态。完成认证网关下的真实模型与客户端执行验收后，才开放中央 UI 的正式启动入口。已有资源检查页面继续如实显示当前清单尚未具备启动资格。
