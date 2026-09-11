<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# Windows 模型管道 transport 候选集成

状态：`windows_model_transport.rs` 已通过独立 Windows model overlay 接入固定源码；生成器可重复生成，源码准备通过真实 archive 34 项回归和 rustfmt 检查。此记录未运行 Cargo、TLS 握手或模型请求。下面列出的行为必须由实际隔离验收证明，不能作为已接通的结论。

固定源：Codex `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`，reqwest `0.12.28`。`generate-windows-model-patch.mjs` 从校验归档提取原文件，生成 `windows-model.patch` 和 `windows-model-files.json`；`prepare-patch.mjs` 仅在 Windows 验证 base/home 后调用 `prepare-windows-model.mjs`。原 base/home 补丁和清单保持原值。源码准备记录：`../target/prepare-patch-6ba2tI/result.json`。新增五个文件的完整 LF SHA、模板内容与 reverse check 均强制验证；p0w 源码已应用并验证 25 + 2 + 5 个文件。非 Windows 未运行；代码分支检查确认不会应用此 overlay。

## 接线位置和必须一起进入的限制

1. 将模板作为 `http-client/src/windows_model_transport.rs`，在 `http-client/src/lib.rs` 通过 `#[cfg(windows)]` 导出模块。该 crate 已有 reqwest、http、Rustls provider 和 Windows 依赖；core 没有直接 reqwest 依赖，不应为了接线复制第二套 HTTP 实现。
2. `core/src/client.rs:1124` 的 `build_api_transport`，在 `let request_url = api_provider.url_for_path(endpoint);` 之后、`create_client_for_route` 之前调用 `maybe_build_model_pipe_client(&request_url, codex_login::default_client::default_headers())?`。`Some` 必须构造下述专用 transport，`None` 仅保留非 remote 原行为，`Err` 必须返回给上层。Windows remote 即使完全没配 pipe/CA，也必须是 AppContainer 并提供完整 broker 配置；不能以配置缺失为由回退普通 HTTP。
3. `http-client/src/transport.rs` 的 `ReqwestTransport` 增加模型专用标识或等价固定路由约束。普通构造函数设为 false；新增模型构造函数设为 true。`build(&self, req: Request)` 在准备正文前，仅对模型专用实例调用 `validate_model_pipe_request(&req)`。每个请求都验证 POST、精确 URL、无压缩、无 Host/Upgrade/代理授权/Content-Encoding 覆写。只在构造时检查 provider URL 不足以约束 transport 后续复用。不要用环境变量把所有普通 transport 自动变成模型 transport。
4. URI 固定为 `https://model-broker.invalid/v1/responses`。provider 的 `base_url` 应为 `https://model-broker.invalid/v1`，保留原 lease 的配置及请求授权头路径，不下发中央上游账号凭据。除了设置 `supports_websockets=false`，还应在真实方法 `core/src/client.rs:1049` 的 `pub fn responses_websocket_enabled(&self) -> bool` 开头加入 Windows remote 直接 `return false` 的约束；不存在 `supports_responses_websockets` 这个方法。该 gate 由 prewarm（`:1423`）与正常流请求（`:1965` 等）共享。压缩关闭；compact、Realtime、models 等路径在此阶段直接拒绝。
5. 模板关闭 reqwest 重试，但 Codex 的上层重试独立存在：`model-provider-info/src/lib.rs:315` 和 `codex-client/src/retry.rs:89`。在上述 `build_api_transport` 的 Windows remote 分支同时强制 `api_provider.retry.max_attempts == 0` 及 `self.state.provider.info().stream_max_retries() == 0`，不满足立即返回 `MODEL_PIPE_RETRIES_DENIED`。QA provider 同时设置 `request_max_retries=0`、`stream_max_retries=0`，再以实际请求计数证明断管不重复发送正文。不要把 reqwest `retry(never())` 扩大解释为所有层都不重试。
6. `core/src/client.rs` 的 `handle_unauthorized` 对 Windows remote 直接返回 provider 映射后的原 Transport 错误，不执行 provider auth 恢复或 OAuth 刷新；因此 401 不会进入恢复后重新发送模型正文的循环。现有 provider lease 请求头路径保持不变。

## 端点身份与信任配置

每个 Worker 启动 lease 使用独立 TLS 密钥和证书。中央 scoped HTTPS listener 持有私钥；原生桥只将本地 pipe 字节转给固定 loopback 端口，不解析目标地址，不执行 CONNECT。Worker 仅收到可信启动环境内的 `CODEX_REMOTE_MODEL_PIPE` 和单张公有证书 `CODEX_REMOTE_MODEL_CA_PEM`。证书应包含精确 SAN `model-broker.invalid`、serverAuth 用途和受限有效期；该 Worker 的私钥、其他 Worker 的证书链及租约不得混用。

reqwest 使用 Rustls、关闭全部内置系统/WebPKI 根，只加入这一张证书，HTTPS 和主机名验证保持开启。每个实际 pipe 连接先完成 TLS 身份认证再传 HTTP lease/正文。TLS 对端身份表示该启动 lease 私钥的持有者，不是对进程 PID 的证明；`GetNamedPipeServerProcessId` 可作诊断，但不能用独立预连接 PID 检查证明 reqwest 随后另开连接的身份。

已核固定 reqwest 源码：`connect.rs:717–727` 内部每次 `ClientOptions::new().open(pipe)`，公开 `windows_named_pipe` 接受路径，不接受已验证 HANDLE；`:933` 的本地 transport 分支直接返回，不进入 TCP/代理连接分支。HTTPS 会在 pipe 上继续执行 TLS；`async_impl/client.rs:1914` 的 `tls_built_in_root_certs(false)` 同时关闭 native/WebPKI 内置信任。模板不调用全局 CA、cookies 或失败后构造默认客户端的 helper。

单独的 pipe ACL/随机名称/预创建实例仍必须保留，但它们不承担本模板的 TLS 对端证明。reqwest 所用 Tokio 泛写权限涉及创建额外实例的能力，不能把这一点从风险说明中删除。冒充 pipe 实例必须因为没有对应 TLS 私钥而在 HTTP 数据发送前失败。参见 [Microsoft 管道权限说明](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) 和 [服务端 PID 查询](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid)。

scoped listener 应把当前 pipe/启动实例绑定到唯一 Worker lease，除了原代理校验有效 token，还要拒绝该端点上的其他有效用户 token。停用、撤销或 Worker 退出时应关闭 TLS listener、现存连接及原生桥，并取消现有代理上游请求。单纯让客户端以后握手失败不会终止已建立的 SSE。

## TLS 与网络验收矩阵（待执行）

证书失败分类使用 `rustls::Error::InvalidCertificate` 的实际错误类型，通过有界、检测环的错误链遍历及 `io::Error::get_ref()` 识别；只有模型实例的 execute/stream 初始 send 失败会输出 `MODEL_PIPE_TLS_CERTIFICATE_REJECTED`。EOF、拒绝访问、超时、普通 Rustls 错误以及含同名文本的错误均不能生成该分类。分类单测只证明映射规则，实际 wrong-CA 验收仍须以当前 patch 对应二进制的分类码、管道连接次数及 broker HTTP 零请求联合证明。分类增强后的源码准备回归：`../target/prepare-patch-eE0gGc/result.json`（34 项；model pin `9d22bc3e6456c936831c54dce2f4fe8e1d531efdf07163a05410fa57e0bd38b9`）。

- A pipe + A 公有证书 + A 服务端密钥成功；借 A 端点请求 B 有效 lease 仍拒绝。
- A pipe + B 证书、服务端被换成 B、错误 SAN、过期证书、系统受信任但不属于 A 的证书均失败。失败服务端计数必须确认未收到解密后的 HTTP Authorization 或请求正文。
- 原 pipe 断开后重建新实例，重复上述错误对端检查；不能只验证第一次握手。
- 缺证书、多个 PEM、私钥 PEM、非法 pipe、非固定 URL 和 Host 覆写在发送前拒绝。单元模板只验证配置/路由，不代替这些握手测试。
- 设置系统代理和其他全局 CA 环境后，错误证书仍失败；管道拒绝/不存在时无 DNS/TCP/代理回退。实际 AppContainer 保持无 network capability，并复核 Worker 直连 loopback/LAN/外网拒绝。
- 成功 SSE、静默 SSE、慢读、断管、Turn 中断、撤销均有明确终态；桥/代理连接和并发计数归零。测试只使用合成 lease/响应，完成身份负例前不接真实凭据或模型。

## 静默 SSE 的最小取消补丁

`codex-api/src/sse/responses.rs:577` 的等待改为：

```rust
let response = tokio::select! {
    biased;
    _ = tx_event.closed() => return,
    response = timeout(idle_timeout, stream.next()) => response,
};
```

接收方关闭时直接返回并析构底层 response stream；正常数据、idle timeout 和 telemetry 分支保持原有处理。不要为取消发送伪完成事件。以下测试应加入原文件既有 `tests` 模块并运行；目前仅为待集成模板：

```rust
#[tokio::test]
async fn receiver_drop_releases_silent_sse_body_without_waiting_idle_timeout() {
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::sync::oneshot;

    struct SilentBody {
        polled: Option<oneshot::Sender<()>>,
        dropped: Option<oneshot::Sender<()>>,
    }
    impl futures::Stream for SilentBody {
        type Item = Result<Bytes, TransportError>;
        fn poll_next(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            if let Some(polled) = self.polled.take() { let _ = polled.send(()); }
            Poll::Pending
        }
    }
    impl Drop for SilentBody {
        fn drop(&mut self) {
            if let Some(dropped) = self.dropped.take() { let _ = dropped.send(()); }
        }
    }

    let (started_tx, started_rx) = oneshot::channel();
    let (dropped_tx, dropped_rx) = oneshot::channel();
    let (tx, rx) = mpsc::channel::<Result<ResponseEvent, ApiError>>(1);
    let body = SilentBody { polled: Some(started_tx), dropped: Some(dropped_tx) };
    let task = tokio::spawn(process_sse(Box::pin(body), tx, Duration::from_secs(3600), None));
    tokio::time::timeout(Duration::from_secs(1), started_rx).await.unwrap().unwrap();
    drop(rx);
    tokio::time::timeout(Duration::from_secs(1), task).await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(1), dropped_rx).await.unwrap().unwrap();
}
```

这个测试先确认上游流已被实际轮询且保持静默，再关闭接收方，并同时断言任务结束和底层流析构；旧实现会等待 3600 秒，不能依靠输入新 SSE 事件使其碰巧结束。后续还须在真实管道链验证析构传播到桥、Node 请求和上游 abort。
