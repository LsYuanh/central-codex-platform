// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Reproducible, Windows-only model IPC overlay over the verified archive.
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isolatedGitEnvironment} from './patch-git-env.mjs';
import {windowsModelTemplate} from './prepare-windows-model.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const pin=JSON.parse(readFileSync(join(here,'upstream.json'),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const lf=value=>value.replace(/\r\n/g,'\n');
if(!process.argv[2]) throw Error('Pass the pinned upstream tar.gz');
const archive=resolve(process.argv[2]);
const version=process.argv[3];
const candidate=version===undefined?undefined:pin.candidatePatches?.[version];
if(version!==undefined&&(!candidate||version!=='0.162.1'))throw Error('Unreviewed Windows candidate');
const commit=candidate?.commit??pin.commit;
if(hash(readFileSync(archive))!==(candidate?.archiveSha256??pin.archive.sha256)) throw Error('Archive hash mismatch');
const replace=(text,anchor,value)=> {
  if(text.split(anchor).length!==2) throw Error(`Pinned model anchor mismatch: ${anchor.slice(0,100)}`);
  return text.replace(anchor,value);
};
const changes=new Map();
changes.set('codex-rs/http-client/src/lib.rs',text=>replace(text,'mod transport;','mod transport;\n#[cfg(windows)]\npub mod windows_model_transport;'));
changes.set('codex-rs/http-client/src/transport.rs',text=> {
  if(candidate) {
    // Keep the upstream route-aware implementation intact. The model-only branch
    // never enters a route pool, even if a future caller supplies a routed client.
    text=replace(text,'    Fixed(HttpClient),','    Fixed(HttpClient),\n    #[cfg(windows)]\n    ModelPipe(HttpClient),');
    text=replace(text,'    async fn send(&self, req: Request) -> Result<HttpResponse, TransportError> {',`    #[cfg(windows)]
    pub fn from_model_pipe_http_client(client: HttpClient) -> Self {
        Self { client: TransportClient::ModelPipe(client) }
    }

    async fn send(&self, req: Request) -> Result<HttpResponse, TransportError> {
        #[cfg(windows)]
        if matches!(&self.client, TransportClient::ModelPipe(_)) {
            crate::windows_model_transport::validate_model_pipe_request(&req)?;
        }`);
    text=replace(text,'            TransportClient::Fixed(client) => match &client.backend {',`            #[cfg(windows)]
            TransportClient::ModelPipe(client) => {
                let HttpClientBackend::Direct(client) = &client.backend else {
                    return Err(TransportError::Build("MODEL_PIPE_ROUTE_DENIED".into()));
                };
                let request = request.build(client)
                    .map_err(|error| Self::map_error(error.into()))?;
                client.execute_without_request_logging(request).await
                    .map(HttpResponse::from)
                    .map_err(|error| {
                        if let Some(category) = crate::windows_model_transport::classify_model_pipe_error(&error) {
                            TransportError::Network(category.into())
                        } else {
                            Self::map_error(error.into())
                        }
                    })
            }
            TransportClient::Fixed(client) => match &client.backend {`);
    text=replace(text,'            TransportClient::Fixed(client) => client.request_logging_enabled(),',`            #[cfg(windows)]
            TransportClient::ModelPipe(_) => false,
            TransportClient::Fixed(client) => client.request_logging_enabled(),`);
    text+=`
#[cfg(all(test, windows))]
mod model_pipe_transport_tests {
    use super::*;

    #[tokio::test]
    async fn reused_model_transport_rejects_alternate_requests_before_io() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let client = HttpClient::new_without_request_logging(reqwest::Client::new());
        let transport = ReqwestTransport::from_model_pipe_http_client(client);
        let allowed = crate::windows_model_transport::MODEL_PIPE_URL;
        let requests = [
            Request::new(Method::POST, format!("http://{}/v1/responses", listener.local_addr().unwrap())),
            Request::new(Method::GET, allowed.into()),
            Request::new(Method::POST, allowed.into()).with_compression(crate::RequestCompression::Zstd),
            {
                let mut request = Request::new(Method::POST, allowed.into());
                request.headers.insert("host", "other.invalid".parse().unwrap());
                request
            },
        ];
        for request in requests {
            assert!(matches!(transport.execute(request.clone()).await, Err(TransportError::Build(code)) if code.starts_with("MODEL_PIPE_")));
            assert!(matches!(transport.stream(request).await, Err(TransportError::Build(code)) if code.starts_with("MODEL_PIPE_")));
        }
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    }
}
`;
    return text;
  }
  text=replace(text,'pub struct ReqwestTransport {\n    client: HttpClient,\n}',`pub struct ReqwestTransport {
    client: HttpClient,
    #[cfg(windows)]
    model_pipe: bool,
}`);
  text=replace(text,'client: HttpClient::new(client),','client: HttpClient::new(client),\n            #[cfg(windows)]\n            model_pipe: false,');
  text=replace(text,'pub fn from_http_client(client: HttpClient) -> Self {\n        Self { client }\n    }',`pub fn from_http_client(client: HttpClient) -> Self {
        Self { client, #[cfg(windows)] model_pipe: false }
    }

    #[cfg(windows)]
    pub fn from_model_pipe_http_client(client: HttpClient) -> Self {
        Self { client, model_pipe: true }
    }`);
  text=replace(text,'        let prepared = req.prepare_body_for_send().map_err(TransportError::Build)?;',`        #[cfg(windows)]
        if self.model_pipe {
            crate::windows_model_transport::validate_model_pipe_request(&req)?;
        }
        let prepared = req.prepare_body_for_send().map_err(TransportError::Build)?;`);
  text=replace(text,'    fn map_error(err: reqwest::Error) -> TransportError {',`    fn map_send_error(&self, err: reqwest::Error) -> TransportError {
        #[cfg(windows)]
        if self.model_pipe {
            if let Some(category) = crate::windows_model_transport::classify_model_pipe_error(&err) {
                return TransportError::Network(category.into());
            }
        }
        Self::map_error(err)
    }

    fn map_error(err: reqwest::Error) -> TransportError {`);
  const send='let resp = builder.send().await.map_err(Self::map_error)?;';
  if(text.split(send).length!==3) throw Error('Expected exactly execute and stream send anchors');
  return text.replaceAll(send,'let resp = builder.send().await.map_err(|err| self.map_send_error(err))?;');
});
changes.set('codex-rs/core/src/client.rs',text=> {
  text=replace(text,'    pub fn responses_websocket_enabled(&self) -> bool {',`    pub fn responses_websocket_enabled(&self) -> bool {
        #[cfg(windows)]
        if crate::remote_workspace::enabled() {
            return false;
        }`);
  text=replace(text,'        redirect_policy: ClientRedirectPolicy,\n    ) -> Result<ReqwestTransport> {',`        redirect_policy: ClientRedirectPolicy,
    ) -> Result<ReqwestTransport> {
        #[cfg(windows)]
        {
            let request_url = api_provider.url_for_path(endpoint);
            if crate::remote_workspace::enabled()
                && (api_provider.retry.max_attempts != 0
                    || self.state.provider.info().stream_max_retries() != 0)
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "MODEL_PIPE_RETRIES_DENIED",
                ).into());
            }
            if let Some(client) = codex_http_client::windows_model_transport::maybe_build_model_pipe_client(
                &request_url,
                codex_login::default_client::default_headers(),
            )? {
                return Ok(ReqwestTransport::from_model_pipe_http_client(client));
            }
        }`);
  return replace(text,'    let debug = extract_response_debug_context(&transport);',`    #[cfg(windows)]
    if crate::remote_workspace::enabled() {
        return Err(provider.map_api_error(ApiError::Transport(transport)));
    }
    let debug = extract_response_debug_context(&transport);`);
});
changes.set('codex-rs/codex-api/src/sse/responses.rs',text=> {
  // Upstream 0.156.1 includes cancellation; retain our regression test.
  if(!text.includes('_ = tx_event.closed() => return,')) throw Error('Upstream SSE cancellation missing');
  return replace(text,'    #[tokio::test]\n    async fn parses_items_and_completed()',`    #[tokio::test]
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
        timeout(Duration::from_secs(1), started_rx).await.unwrap().unwrap();
        drop(rx);
        timeout(Duration::from_secs(1), task).await.unwrap().unwrap();
        timeout(Duration::from_secs(1), dropped_rx).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn parses_items_and_completed()`);
});
const parent=join(here,'../target'); mkdirSync(parent,{recursive:true});
const scratch=mkdtempSync(join(parent,'generate-windows-model-'));
let patch=''; const manifest=[];
for(const [path,change] of changes) {
  const extracted=spawnSync('tar',['-xOf',archive,`codex-${commit}/${path}`],{maxBuffer:4*1024*1024});
  if(extracted.status!==0) throw Error(`Pinned extraction failed: ${path}`);
  const before=lf(extracted.stdout.toString('utf8'));
  const formatted=spawnSync('rustfmt',['--edition','2024','--config','skip_children=true','--emit','stdout'],
    {input:change(before),encoding:'utf8',maxBuffer:4*1024*1024});
  if(formatted.status!==0) throw Error(formatted.stderr);
  const after=lf(formatted.stdout);
  writeFileSync(join(scratch,'before'),before); writeFileSync(join(scratch,'after'),after);
  const diff=spawnSync('git',['-c','core.autocrlf=false','diff','--no-index','--no-prefix','--no-ext-diff','--no-textconv','--','before','after'],
    {cwd:scratch,env:isolatedGitEnvironment(scratch),encoding:'utf8',maxBuffer:4*1024*1024});
  if(diff.status!==1) throw Error(`Expected changed diff: ${path}: ${diff.stderr}`);
  patch+=lf(diff.stdout).replace('diff --git before after',`diff --git a/${path} b/${path}`)
    .replace('--- before',`--- a/${path}`).replace('+++ after',`+++ b/${path}`);
  manifest.push({path,upstreamSha256:hash(extracted.stdout),patchedSha256:hash(after)});
}
const helperPath='codex-rs/http-client/src/windows_model_transport.rs';
const helper=windowsModelTemplate(version);
const lines=helper.replace(/\n$/,'').split('\n');
patch+=`diff --git a/${helperPath} b/${helperPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${helperPath}\n@@ -0,0 +1,${lines.length} @@\n`
  +lines.map(line=>'+'+line).join('\n')+'\n';
manifest.push({path:helperPath,upstreamSha256:null,patchedSha256:hash(helper),template:'windows_model_transport.rs'});
const patchPath=candidate?`adaptations/${version}-windows-model.patch`:'windows-model.patch';
const filesPath=candidate?`adaptations/${version}-windows-model-files.json`:'windows-model-files.json';
writeFileSync(join(here,patchPath),patch);
writeFileSync(join(here,filesPath),JSON.stringify(manifest,null,2)+'\n');
const spec={path:patchPath,sha256:hash(patch),scope:'Windows remote AppContainer model-only authenticated TLS named pipe transport'};
if(candidate)candidate.windowsModelPatch={...spec,files:filesPath};
else pin.windowsModelPatch=spec;
writeFileSync(join(here,'upstream.json'),JSON.stringify(pin,null,2)+'\n');
console.log(JSON.stringify(spec));
