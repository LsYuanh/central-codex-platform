// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Explicit QA utility: secrets enter stdin and stay in the native credential vault.
use serde_json::{Value, json};
use std::io::Read;
#[tokio::main]
async fn main() -> Result<(), String> {
    let mut raw = String::new();
    std::io::stdin()
        .take(128 * 1024)
        .read_to_string(&mut raw)
        .map_err(|_| "stdin")?;
    let input: Value = serde_json::from_str(&raw).map_err(|_| "input")?;
    let s = |key: &str| input[key].as_str().unwrap_or("");
    let ns = s("namespace");
    if !ns.starts_with("com.centralcodex.harnessqa") {
        return Err("QA namespace required".into());
    }
    let gateway = s("gateway");
    let ca = s("ca");
    let result = match s("action") {
        "tls-probe" => {
            let url = url::Url::parse(gateway).map_err(|_| "QA_URL_INVALID")?;
            if !matches!(url.host_str(), Some("localhost" | "127.0.0.1")) {
                return Err("QA_LOOPBACK_REQUIRED".into());
            }
            let error = if s("transport") == "wss" {
                platform_security::socket(gateway, ca, "qa-nonsecret-invalid-token")
                    .await
                    .err()
            } else {
                platform_security::post(gateway, ca, "/auth/device/status", json!({}), None)
                    .await
                    .err()
            };
            json!({"errorCode":error})
        }
        "token-pair" | "token-pair-bundle" | "token-status" | "token-disconnect"
        | "token-cleanup" | "bundle-encode" | "token-socket" => {
            let directory = std::path::PathBuf::from(s("token-root"));
            if !directory.is_absolute() {
                return Err("absolute token-root required".into());
            }
            match s("action") {
                "token-socket" => {
                    let credential =
                        platform_security::device_token::load(&directory, ns, gateway)?;
                    let bundled =
                        platform_security::device_token::bundled_ca_path(&directory, ns, gateway)?;
                    let mut socket = platform_security::socket(
                        gateway,
                        bundled.as_ref().and_then(|p| p.to_str()).unwrap_or(ca),
                        credential.bearer(),
                    )
                    .await?;
                    socket
                        .close(None)
                        .await
                        .map_err(|_| "QA_SOCKET_CLOSE_FAILED")?;
                    json!({"connected":true,"rustls":matches!(socket.get_ref(),tokio_tungstenite::MaybeTlsStream::Rustls(_))})
                }
                "bundle-encode" => {
                    json!({"code":platform_security::pairing_bundle::Bundle::new(gateway.into(),s("caPem").into(),s("code").into(),input["expiresAt"].as_u64().unwrap_or(0))?.encode()?})
                }
                "token-pair-bundle" => {
                    let bundle = platform_security::pairing_bundle::Bundle::decode(s("code"))?;
                    if bundle.gateway != gateway {
                        return Err("QA bundle target mismatch".into());
                    }
                    platform_security::device_token::pair_bundle(&directory, ns, &bundle, s("name"))
                        .await?
                        .public()
                }
                "token-pair" => platform_security::device_token::pair(
                    &directory,
                    ns,
                    gateway,
                    ca,
                    s("code"),
                    s("name"),
                )
                .await?
                .public(),
                "token-status" => {
                    let bundled =
                        platform_security::device_token::bundled_ca_path(&directory, ns, gateway)?;
                    platform_security::device_token::status(
                        &directory,
                        ns,
                        gateway,
                        bundled.as_ref().and_then(|p| p.to_str()).unwrap_or(ca),
                    )
                    .await
                }
                "token-disconnect" => {
                    let bundled =
                        platform_security::device_token::bundled_ca_path(&directory, ns, gateway)?;
                    platform_security::device_token::disconnect(
                        &directory,
                        ns,
                        gateway,
                        bundled.as_ref().and_then(|p| p.to_str()).unwrap_or(ca),
                    )
                    .await?
                }
                _ => {
                    platform_security::device_token::remove(&directory, ns, gateway)?;
                    json!({"removed":true})
                }
            }
        }
        "fixture-set" => {
            if ns != "com.centralcodex.harnessqa.p5.bootstrap" {
                return Err("fixed QA bootstrap only".into());
            }
            platform_security::entry(ns, gateway)?
                .set_password(s("password"))
                .map_err(|_| "QA vault save")?;
            json!({"stored":true})
        }
        "fixture-get" => {
            if ns != "com.centralcodex.harnessqa.p5.bootstrap" {
                return Err("fixed QA bootstrap only".into());
            }
            json!({"password":platform_security::entry(ns,gateway)?.get_password().map_err(|_|"QA vault read")?})
        }
        "setup" => {
            platform_security::login(ns, gateway, ca, s("username"), s("password")).await?;
            let c = platform_security::pair(ns, gateway, ca, s("name")).await?;
            json!({"deviceId":c.device_id,"deviceKey":c.device_key,"userId":c.user["id"],"sessionId":c.session_id,
                "certificate":platform_security::device_certificate::public(ns,gateway,&c.device_id)})
        }
        "certificate-status" => {
            let c = platform_security::load(ns, gateway)?;
            platform_security::device_certificate::public(ns, gateway, &c.device_id)
        }
        "renew" => {
            let c = platform_security::load(ns, gateway)?;
            let renewed =
                platform_security::device_certificate::renew_if_due(ns, gateway, ca, &c.device_id)
                    .await?;
            json!({"renewed":renewed,"certificate":platform_security::device_certificate::public(ns,gateway,&c.device_id)})
        }
        "refresh" => {
            let c = platform_security::current(ns, gateway, ca).await?;
            json!({"userId":c.user["id"],"deviceId":c.device_id})
        }
        "logout" => {
            let c = platform_security::current(ns, gateway, ca).await?;
            platform_security::post(
                gateway,
                ca,
                "/auth/logout",
                json!({}),
                Some(&c.access_token),
            )
            .await?;
            platform_security::device_certificate::remove(ns, gateway, &c.device_id)?;
            platform_security::entry(ns, gateway)?
                .delete_credential()
                .map_err(|_| "vault cleanup")?;
            json!({"loggedOut":true})
        }
        "cleanup" => {
            if let Ok(c) = platform_security::load(ns, gateway) {
                platform_security::device_certificate::remove(ns, gateway, &c.device_id)?;
            }
            platform_security::entry(ns, gateway)?
                .delete_credential()
                .map_err(|_| "vault cleanup")?;
            json!({"removed":true})
        }
        _ => return Err("QA action required".into()),
    };
    println!("{}", json!({"ok":true,"data":result}));
    Ok(())
}
