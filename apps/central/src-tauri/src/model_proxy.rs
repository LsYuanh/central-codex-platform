// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Read-only transport settings. Never import Codex providers, tools or shell settings.
use crate::config::{Result, failure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::Read, path::Path};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelProxy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_proxy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub https_proxy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_proxy: Option<String>,
}

fn enabled(text: &str) -> Result<bool> {
    let value: toml::Value =
        toml::from_str(text).map_err(|_| failure("MODEL_PROXY_CONFIG_INVALID"))?;
    if value.get("features").is_some_and(|v| !v.is_table()) {
        return Err(failure("MODEL_PROXY_CONFIG_INVALID"));
    }
    match value
        .get("features")
        .and_then(|v| v.get("respect_system_proxy"))
    {
        None => Ok(false),
        Some(toml::Value::Boolean(value)) => Ok(*value),
        _ => Err(failure("MODEL_PROXY_CONFIG_INVALID")),
    }
}

fn read_enabled(path: &Path) -> Result<bool> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(failure("MODEL_PROXY_CONFIG_UNAVAILABLE")),
    };
    let mut text = String::new();
    file.take(1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|_| failure("MODEL_PROXY_CONFIG_INVALID"))?;
    if text.len() > 1024 * 1024 {
        return Err(failure("MODEL_PROXY_CONFIG_INVALID"));
    }
    enabled(&text)
}

impl ModelProxy {
    fn validate(mut self) -> Result<Self> {
        for raw in [&self.http_proxy, &self.https_proxy].into_iter().flatten() {
            let url = url::Url::parse(raw).map_err(|_| failure("MODEL_PROXY_URL_INVALID"))?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err(failure("MODEL_PROXY_SYSTEM_UNSUPPORTED"));
            }
            if raw.len() > 4096
                || raw.chars().any(char::is_control)
                || url.host_str().is_none()
                || url.query().is_some()
                || url.fragment().is_some()
                || url.path() != "/"
            {
                return Err(failure("MODEL_PROXY_URL_INVALID"));
            }
        }
        if self
            .no_proxy
            .as_ref()
            .is_some_and(|s| s.len() > 16384 || s.chars().any(char::is_control))
        {
            return Err(failure("MODEL_PROXY_SYSTEM_UNSUPPORTED"));
        }
        // System settings commonly use *.example.com; reqwest accepts a domain suffix.
        if let Some(bypass) = &mut self.no_proxy {
            let rules: Vec<_> = bypass
                .split(',')
                .map(str::trim)
                .map(|s| s.strip_prefix("*.").unwrap_or(s))
                .collect();
            if rules.iter().any(|s| {
                (*s != "*" && s.contains('*'))
                    || (s.contains(['<', '>']) && !s.eq_ignore_ascii_case("<local>"))
            }) {
                return Err(failure("MODEL_PROXY_SYSTEM_UNSUPPORTED"));
            }
            *bypass = rules.join(",");
        }
        Ok(self)
    }

    pub(crate) fn environment(&self) -> Vec<(&'static str, &str)> {
        [
            ("HTTP_PROXY", &self.http_proxy),
            ("HTTPS_PROXY", &self.https_proxy),
            ("NO_PROXY", &self.no_proxy),
        ]
        .into_iter()
        .filter_map(|(key, value)| value.as_deref().map(|v| (key, v)))
        .collect()
    }

    pub(crate) fn client(
        &self,
        builder: reqwest::blocking::ClientBuilder,
    ) -> Result<reqwest::blocking::ClientBuilder> {
        // Explicit settings avoid reqwest independently discovering a different proxy.
        let mut builder = builder.no_proxy();
        let rules = self.no_proxy.as_deref().unwrap_or("");
        let simple_hosts = rules
            .split(',')
            .any(|r| r.trim().eq_ignore_ascii_case("<local>"));
        let regular = rules
            .split(',')
            .filter(|r| !r.trim().eq_ignore_ascii_case("<local>"))
            .collect::<Vec<_>>()
            .join(",");
        let bypass = reqwest::NoProxy::from_string(&regular);
        for (is_https, address) in [(false, &self.http_proxy), (true, &self.https_proxy)] {
            if let Some(address) = address {
                if simple_hosts {
                    // <local> means unqualified hostnames, not all local domains
                    // or all IPs. Keep reqwest's other domain/CIDR rules intact.
                    let address = address.clone();
                    let proxy = reqwest::Proxy::custom(move |url| {
                        let scheme = if is_https { "https" } else { "http" };
                        (url.scheme() == scheme && !url.host_str().is_some_and(simple_hostname))
                            .then(|| address.clone())
                    });
                    builder = builder.proxy(proxy.no_proxy(bypass.clone()));
                    continue;
                }
                let proxy = if is_https {
                    reqwest::Proxy::https(address)
                } else {
                    reqwest::Proxy::http(address)
                }
                .map_err(|_| failure("MODEL_PROXY_URL_INVALID"))?;
                builder = builder.proxy(proxy.no_proxy(bypass.clone()));
            }
        }
        Ok(builder)
    }
}

fn simple_hostname(host: &str) -> bool {
    !host.is_empty()
        && !host.contains('.')
        && host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_err()
}

fn resolve_with(
    enabled: bool,
    env: &BTreeMap<String, String>,
    system: impl FnOnce() -> Result<ModelProxy>,
) -> Result<ModelProxy> {
    let get = |lower: &str, upper: &str| {
        env.get(lower)
            .or_else(|| env.get(upper))
            .filter(|v| !v.is_empty())
            .cloned()
    };
    let all = get("all_proxy", "ALL_PROXY");
    let mut result = ModelProxy {
        http_proxy: get("http_proxy", "HTTP_PROXY").or_else(|| all.clone()),
        https_proxy: get("https_proxy", "HTTPS_PROXY").or(all),
        no_proxy: get("no_proxy", "NO_PROXY"),
    };
    // Explicit transport environment takes precedence. No arbitrary env is imported.
    if enabled && (result.http_proxy.is_none() || result.https_proxy.is_none()) {
        let system = system()?;
        result.http_proxy = result.http_proxy.or(system.http_proxy);
        result.https_proxy = result.https_proxy.or(system.https_proxy);
        result.no_proxy = result.no_proxy.or(system.no_proxy);
    }
    result.validate()
}

pub(crate) fn resolve() -> Result<ModelProxy> {
    let enabled = read_enabled(&crate::model_accounts::codex_config_path()?)?;
    let env = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ]
    .into_iter()
    .filter_map(|name| std::env::var(name).ok().map(|v| (name.into(), v)))
    .collect();
    resolve_with(enabled, &env, system_proxy)
}

// scutil is queried only; no networksetup/VPN commands or settings writes occur.
#[cfg(target_os = "macos")]
fn system_proxy() -> Result<ModelProxy> {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let mut child = Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| failure("MODEL_PROXY_SYSTEM_UNAVAILABLE"))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failure("MODEL_PROXY_SYSTEM_UNAVAILABLE"));
            }
        }
    }
    let mut text = String::new();
    child
        .stdout
        .take()
        .ok_or_else(|| failure("MODEL_PROXY_SYSTEM_UNAVAILABLE"))?
        .take(65537)
        .read_to_string(&mut text)
        .map_err(|_| failure("MODEL_PROXY_SYSTEM_UNAVAILABLE"))?;
    if text.len() > 65536 {
        return Err(failure("MODEL_PROXY_SYSTEM_UNAVAILABLE"));
    }
    parse_macos(&text)
}

#[cfg(any(test, target_os = "macos"))]
fn parse_macos(text: &str) -> Result<ModelProxy> {
    if !text.trim_start().starts_with("<dictionary> {") {
        return Err(failure("MODEL_PROXY_SYSTEM_UNAVAILABLE"));
    }
    let mut values = BTreeMap::new();
    let mut exceptions = Vec::new();
    let mut depth = 0usize;
    let mut in_exceptions = false;
    for line in text.lines().map(str::trim) {
        if line.ends_with('{') {
            if depth == 1 {
                in_exceptions = line.starts_with("ExceptionsList :");
                if line.starts_with("__SUPPLEMENTAL__ :") {
                    return Err(failure("MODEL_PROXY_SYSTEM_UNSUPPORTED"));
                }
            }
            depth += 1;
        } else if line == "}" {
            depth = depth.saturating_sub(1);
            if depth <= 1 {
                in_exceptions = false;
            }
        } else if let Some((key, value)) = line.split_once(" : ") {
            // Per-interface dictionaries must not overwrite the global proxy.
            if depth == 1 {
                values.insert(key, value);
            }
            if depth == 2 && in_exceptions {
                exceptions.push(value);
            }
        }
    }
    if depth != 0 {
        return Err(failure("MODEL_PROXY_SYSTEM_UNAVAILABLE"));
    }
    let on = |key: &str| values.get(key) == Some(&"1");
    if on("ProxyAutoConfigEnable") || on("ProxyAutoDiscoveryEnable") || on("ExcludeSimpleHostnames")
    {
        return Err(failure("MODEL_PROXY_SYSTEM_UNSUPPORTED"));
    }
    let endpoint = |kind: &str| -> Result<Option<String>> {
        if !on(format!("{kind}Enable").as_str()) {
            return Ok(None);
        }
        let host = values
            .get(format!("{kind}Proxy").as_str())
            .ok_or_else(|| failure("MODEL_PROXY_URL_INVALID"))?;
        let port = values
            .get(format!("{kind}Port").as_str())
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p > 0)
            .ok_or_else(|| failure("MODEL_PROXY_URL_INVALID"))?;
        // macOS HTTPSProxy denotes an HTTP CONNECT proxy, not a TLS-wrapped proxy.
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        Ok(Some(format!("http://{host}:{port}")))
    };
    let result = ModelProxy {
        http_proxy: endpoint("HTTP")?,
        https_proxy: endpoint("HTTPS")?,
        no_proxy: None,
    };
    if result.http_proxy.is_none() && result.https_proxy.is_none() && on("SOCKSEnable") {
        return Err(failure("MODEL_PROXY_SYSTEM_UNSUPPORTED"));
    }
    ModelProxy {
        no_proxy: (!exceptions.is_empty()).then(|| exceptions.join(",")),
        ..result
    }
    .validate()
}

#[cfg(windows)]
fn system_proxy() -> Result<ModelProxy> {
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, KEY_READ},
    };
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            KEY_READ,
        )
        .map_err(|_| failure("MODEL_PROXY_SYSTEM_UNAVAILABLE"))?;
    if key
        .get_value::<String, _>("AutoConfigURL")
        .ok()
        .is_some_and(|s| !s.is_empty())
    {
        return Err(failure("MODEL_PROXY_SYSTEM_UNSUPPORTED"));
    }
    if key.get_value::<u32, _>("ProxyEnable").unwrap_or(0) == 0 {
        return Ok(ModelProxy::default());
    }
    let server: String = key
        .get_value("ProxyServer")
        .map_err(|_| failure("MODEL_PROXY_SYSTEM_UNAVAILABLE"))?;
    parse_windows(&server, key.get_value::<String, _>("ProxyOverride").ok())
}

#[cfg(any(test, windows))]
fn parse_windows(server: &str, bypass: Option<String>) -> Result<ModelProxy> {
    let mut result = ModelProxy {
        no_proxy: bypass.map(|v| v.replace(';', ",")),
        ..Default::default()
    };
    let url = |value: &str| {
        if value.contains("://") {
            value.to_string()
        } else {
            format!("http://{value}")
        }
    };
    if !server.contains('=') {
        result.http_proxy = Some(url(server));
        result.https_proxy = result.http_proxy.clone();
    } else {
        for item in server.split(';').filter(|s| !s.trim().is_empty()) {
            let (kind, value) = item
                .trim()
                .split_once('=')
                .ok_or_else(|| failure("MODEL_PROXY_URL_INVALID"))?;
            match kind {
                "http" => result.http_proxy = Some(url(value)),
                "https" => result.https_proxy = Some(url(value)),
                "socks" => {}
                _ => return Err(failure("MODEL_PROXY_SYSTEM_UNSUPPORTED")),
            }
        }
        if result.http_proxy.is_none() && result.https_proxy.is_none() {
            return Err(failure("MODEL_PROXY_SYSTEM_UNSUPPORTED"));
        }
    }
    result.validate()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn system_proxy() -> Result<ModelProxy> {
    Err(failure("MODEL_PROXY_SYSTEM_UNSUPPORTED"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oauth_client_uses_explicit_proxy_and_bypasses_loopback() {
        use std::{io::Write, net::TcpListener, time::Duration};
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = proxy.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = proxy.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = [0; 4096];
            let count = stream.read(&mut bytes).unwrap();
            assert!(
                String::from_utf8_lossy(&bytes[..count])
                    .starts_with("GET http://oauth.fixture.invalid/probe HTTP/1.1")
            );
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        let settings = ModelProxy {
            http_proxy: Some(format!("http://{address}")),
            no_proxy: Some("127.0.0.0/8".into()),
            ..Default::default()
        };
        let client = settings
            .client(reqwest::blocking::Client::builder())
            .unwrap()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        assert_eq!(
            client
                .get("http://oauth.fixture.invalid/probe")
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "ok"
        );
        server.join().unwrap();
        // The proxy listener is now closed: a loopback exclusion must still reach the target.
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_address = target.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = target.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = [0; 4096];
            let count = stream.read(&mut bytes).unwrap();
            assert!(String::from_utf8_lossy(&bytes[..count]).starts_with("GET /probe HTTP/1.1"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        assert_eq!(
            client
                .get(format!("http://{target_address}/probe"))
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "ok"
        );
        server.join().unwrap();
    }
    #[test]
    fn reads_only_typed_feature_and_handles_missing_file() {
        assert!(
            !enabled("model='ignored'\n[shell_environment_policy.set]\nHTTPS_PROXY='ignored'")
                .unwrap()
        );
        assert!(enabled("[features]\nrespect_system_proxy=true").unwrap());
        assert!(!enabled("[features]\nrespect_system_proxy=false").unwrap());
        assert!(enabled("[features]\nrespect_system_proxy='true'").is_err());
        assert!(enabled("malformed!").is_err());
        assert!(!read_enabled(&tempfile::tempdir().unwrap().path().join("absent")).unwrap());
    }
    #[test]
    fn opt_out_does_not_query_system_and_env_wins() {
        let env = BTreeMap::from([("https_proxy".into(), "http://localhost:1234".into())]);
        let result = resolve_with(false, &env, || panic!("must not query system")).unwrap();
        assert_eq!(result.https_proxy.as_deref(), Some("http://localhost:1234"));
        let result = resolve_with(true, &env, || {
            Ok(ModelProxy {
                http_proxy: Some("http://localhost:5678".into()),
                https_proxy: Some("http://localhost:5678".into()),
                no_proxy: Some("localhost".into()),
            })
        })
        .unwrap();
        assert_eq!(result.https_proxy.as_deref(), Some("http://localhost:1234"));
        assert_eq!(result.http_proxy.as_deref(), Some("http://localhost:5678"));
        assert_eq!(result.no_proxy.as_deref(), Some("localhost"));
    }
    #[test]
    fn mac_connect_proxy_and_exceptions_without_socks_downgrade() {
        let text = "<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : 10808\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 10808\n SOCKSEnable : 1\n ExceptionsList : <array> {\n 0 : localhost\n 1 : 127.0.0.0/8\n 2 : ::1\n }\n}";
        let result = parse_macos(text).unwrap();
        assert_eq!(
            result.https_proxy.as_deref(),
            Some("http://127.0.0.1:10808")
        );
        assert_eq!(
            result.no_proxy.as_deref(),
            Some("localhost,127.0.0.0/8,::1")
        );
        for bad in [
            "SOCKSEnable : 1",
            "ProxyAutoConfigEnable : 1",
            "HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 0",
        ] {
            assert!(parse_macos(&format!("<dictionary> {{\n{bad}\n}}")).is_err());
        }
        let scoped = text.replace("\n}", "\n __SCOPED__ : <dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : ignored.invalid\n HTTPSPort : 9999\n }\n}");
        assert_eq!(
            parse_macos(&scoped).unwrap().https_proxy,
            result.https_proxy
        );
    }
    #[test]
    fn local_exception_preserves_simple_host_semantics() {
        let settings = parse_macos("<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : 1\n ExceptionsList : <array> {\n 0 : <local>\n }\n}").unwrap();
        assert_eq!(settings.no_proxy.as_deref(), Some("<local>"));
        assert!(simple_hostname("localhost"));
        assert!(simple_hostname("intranet"));
        assert!(!simple_hostname("host.example"));
        assert!(!simple_hostname("127.0.0.1"));
        assert!(!simple_hostname("[::1]"));
        use std::{io::Write, net::TcpListener, time::Duration};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = [0; 1024];
            stream.read(&mut bytes).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        let client = settings
            .client(reqwest::blocking::Client::builder())
            .unwrap()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        assert_eq!(
            client
                .get(format!("http://localhost:{port}/"))
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "ok"
        );
        server.join().unwrap();
    }
    #[test]
    fn windows_static_proxy_and_invalid_transports() {
        let result = parse_windows(
            "http=127.0.0.1:1234;https=127.0.0.1:5678",
            Some("localhost;127.0.0.1".into()),
        )
        .unwrap();
        assert_eq!(result.https_proxy.as_deref(), Some("http://127.0.0.1:5678"));
        assert_eq!(result.no_proxy.as_deref(), Some("localhost,127.0.0.1"));
        for value in [
            "socks5://localhost:1080",
            "http://localhost:1234/path",
            "http://localhost:1234?secret=1",
        ] {
            assert!(
                ModelProxy {
                    https_proxy: Some(value.into()),
                    ..Default::default()
                }
                .validate()
                .is_err()
            );
        }
    }
}
