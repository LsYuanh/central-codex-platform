// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Windows-only codex-http-client module, pinned by windows-model.patch.
// The integrating transport MUST apply validate_model_pipe_request on every
// request of this model-only client before preparing or sending its body.
#![cfg(windows)]

use crate::{HttpClient, Request, RequestCompression, TransportError};
use codex_utils_rustls_provider::ensure_rustls_crypto_provider;
use http::HeaderMap;
use std::ffi::c_void;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::time::Duration;

pub const MODEL_PIPE_URL: &str = "https://model-broker.invalid/v1/responses";
pub const MODEL_PIPE_TLS_CERTIFICATE_REJECTED: &str = "MODEL_PIPE_TLS_CERTIFICATE_REJECTED";
const PIPE_ENV: &str = "CODEX_REMOTE_MODEL_PIPE";
const CA_ENV: &str = "CODEX_REMOTE_MODEL_CA_PEM";

/// Report certificate rejection only when the actual typed TLS error proves it.
/// An EOF, pipe error, timeout or similarly worded string is not that evidence.
pub fn classify_model_pipe_error(error: &reqwest::Error) -> Option<&'static str> {
    certificate_error_category(error)
}

fn certificate_error_category(error: &(dyn std::error::Error + 'static)) -> Option<&'static str> {
    let mut current = Some(error);
    let mut visited: Vec<&(dyn std::error::Error + 'static)> = Vec::new();
    for _ in 0..32 {
        let error = current?;
        if visited
            .iter()
            .any(|previous| std::ptr::eq(*previous, error))
        {
            return None;
        }
        visited.push(error);
        if matches!(
            error.downcast_ref::<rustls::Error>(),
            Some(rustls::Error::InvalidCertificate(_))
        ) {
            return Some(MODEL_PIPE_TLS_CERTIFICATE_REJECTED);
        }
        // tokio-rustls wraps its rustls::Error in io::Error. Inspect that payload
        // explicitly instead of assuming Error::source exposes the same layer.
        current = error
            .downcast_ref::<io::Error>()
            .and_then(io::Error::get_ref)
            .map(|inner| inner as &(dyn std::error::Error + 'static))
            .or_else(|| error.source());
    }
    None
}

/// None preserves ordinary non-remote clients. Every Windows remote client must
/// be an AppContainer and supply complete broker IPC configuration; missing or
/// invalid isolation/IPC never falls back to TCP.
pub fn maybe_build_model_pipe_client(
    request_url: &str,
    default_headers: HeaderMap,
) -> io::Result<Option<HttpClient>> {
    let remote = std::env::var("CODEX_REMOTE_WORKSPACE").as_deref() == Ok("1");
    if !remote {
        return Ok(None);
    }
    let pipe = std::env::var_os(PIPE_ENV);
    let ca = std::env::var_os(CA_ENV);
    let broker = std::env::var("CODEX_REMOTE_AUTH_MODE").as_deref() == Ok("broker");
    if !activate(
        remote,
        broker,
        is_app_container()?,
        pipe.is_some(),
        ca.is_some(),
    )? {
        return Ok(None);
    }
    if request_url != MODEL_PIPE_URL {
        return Err(invalid("MODEL_PIPE_ENDPOINT_DENIED"));
    }
    validate_headers(&default_headers).map_err(|_| invalid("MODEL_PIPE_HEADERS_DENIED"))?;
    let pipe = pipe
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| invalid("MODEL_PIPE_NAME_REQUIRED"))?;
    let ca = ca
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| invalid("MODEL_PIPE_CERTIFICATE_REQUIRED"))?;
    validate_pipe_name(&pipe)?;
    let certificate = single_certificate(&ca)?;

    // Only the per-worker public certificate is trusted. The private key stays
    // in the scoped central HTTPS listener; every actual pipe connection carries
    // a TLS handshake before any HTTP authorization header or model body.
    // Never use global custom-CA helpers or their default-client fallback here.
    ensure_rustls_crypto_provider();
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .tls_built_in_root_certs(false)
        .add_root_certificate(certificate)
        .https_only(true)
        .windows_named_pipe(pipe)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .http1_only()
        .pool_max_idle_per_host(0)
        .connect_timeout(Duration::from_secs(3))
        .default_headers(default_headers)
        .build()
        .map_err(|_| invalid("MODEL_PIPE_CLIENT_CONFIGURATION_INVALID"))?;
    // Request authorization remains the existing provider/lease header path.
    // This module does not read, replace, store or log a lease token.
    Ok(Some(HttpClient::new_without_request_logging(client)))
}

/// Call only on transport instances created by maybe_build_model_pipe_client.
/// Checking the provider URL once at construction is insufficient for reuse.
pub fn validate_model_pipe_request(request: &Request) -> Result<(), TransportError> {
    if request.method != http::Method::POST
        || request.url != MODEL_PIPE_URL
        || request.compression != RequestCompression::None
    {
        return Err(TransportError::Build("MODEL_PIPE_REQUEST_DENIED".into()));
    }
    validate_headers(&request.headers)
}

fn validate_headers(headers: &HeaderMap) -> Result<(), TransportError> {
    // Authority and content framing are set by the fixed URI and HTTP client.
    // Keep provider authorization and Codex metadata headers unchanged.
    if ["host", "upgrade", "proxy-authorization", "content-encoding"]
        .iter()
        .any(|name| headers.contains_key(*name))
    {
        return Err(TransportError::Build("MODEL_PIPE_HEADERS_DENIED".into()));
    }
    Ok(())
}

fn activate(
    remote: bool,
    broker: bool,
    app_container: bool,
    pipe_present: bool,
    ca_present: bool,
) -> io::Result<bool> {
    if !remote {
        return Ok(false);
    }
    if !app_container {
        return Err(invalid("MODEL_PIPE_REQUIRES_APPCONTAINER"));
    }
    if !broker || !pipe_present || !ca_present {
        return Err(invalid("MODEL_PIPE_BROKER_CONFIGURATION_REQUIRED"));
    }
    Ok(true)
}

fn validate_pipe_name(pipe: &str) -> io::Result<()> {
    let suffix = pipe
        .strip_prefix(r"\\.\pipe\LOCAL\")
        .ok_or_else(|| invalid("MODEL_PIPE_NAME_INVALID"))?;
    if suffix.is_empty()
        || suffix.len() > 180
        || matches!(suffix, "." | "..")
        || !suffix
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        return Err(invalid("MODEL_PIPE_NAME_INVALID"));
    }
    Ok(())
}

fn single_certificate(pem: &str) -> io::Result<reqwest::Certificate> {
    if pem.len() > 16 * 1024 || pem.contains('\0') {
        return Err(invalid("MODEL_PIPE_CERTIFICATE_INVALID"));
    }
    let body = pem
        .trim()
        .strip_prefix("-----BEGIN CERTIFICATE-----")
        .and_then(|value| value.strip_suffix("-----END CERTIFICATE-----"))
        .ok_or_else(|| invalid("MODEL_PIPE_CERTIFICATE_INVALID"))?;
    if body.is_empty()
        || !body.bytes().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, b'+' | b'/' | b'=' | b'\r' | b'\n' | b' ' | b'\t')
        })
    {
        return Err(invalid("MODEL_PIPE_CERTIFICATE_INVALID"));
    }
    // from_pem can contain multiple roots under rustls. Parse a bundle and
    // require exactly one certificate, in addition to the strict envelope.
    let mut certificates = reqwest::Certificate::from_pem_bundle(pem.as_bytes())
        .map_err(|_| invalid("MODEL_PIPE_CERTIFICATE_INVALID"))?;
    if certificates.len() != 1 {
        return Err(invalid("MODEL_PIPE_CERTIFICATE_INVALID"));
    }
    certificates
        .pop()
        .ok_or_else(|| invalid("MODEL_PIPE_CERTIFICATE_INVALID"))
}

fn invalid(code: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, code)
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
    fn GetTokenInformation(
        token: *mut c_void,
        class: i32,
        info: *mut c_void,
        size: u32,
        returned: *mut u32,
    ) -> i32;
}

fn is_app_container() -> io::Result<bool> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut enabled: u32 = 0;
    let mut returned = 0;
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            29,
            (&mut enabled as *mut u32).cast(),
            4,
            &mut returned,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if returned != 4 || enabled > 1 {
        return Err(invalid("MODEL_PIPE_TOKEN_INFORMATION_INVALID"));
    }
    Ok(enabled == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_certificate_errors_survive_nested_io_and_source_wrappers() {
        #[derive(Debug)]
        struct Wrapper(io::Error);
        impl std::fmt::Display for Wrapper {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("synthetic outer error")
            }
        }
        impl std::error::Error for Wrapper {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        for cause in [
            rustls::CertificateError::UnknownIssuer,
            rustls::CertificateError::Expired,
            rustls::CertificateError::NotValidForName,
        ] {
            let error = rustls::Error::InvalidCertificate(cause);
            assert_eq!(
                certificate_error_category(&error),
                Some(MODEL_PIPE_TLS_CERTIFICATE_REJECTED)
            );
            let wrapped = Wrapper(io::Error::new(io::ErrorKind::InvalidData, error));
            assert_eq!(
                certificate_error_category(&wrapped),
                Some(MODEL_PIPE_TLS_CERTIFICATE_REJECTED)
            );
        }
    }

    #[test]
    fn certificate_classifier_rejects_plain_errors_and_deceptive_text() {
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::ConnectionReset,
            io::ErrorKind::UnexpectedEof,
            io::ErrorKind::TimedOut,
        ] {
            let error = io::Error::new(
                kind,
                "InvalidCertificate UnknownIssuer MODEL_PIPE_TLS_CERTIFICATE_REJECTED",
            );
            assert_eq!(certificate_error_category(&error), None);
        }
        let tls_error = rustls::Error::General("InvalidCertificate UnknownIssuer".into());
        assert_eq!(certificate_error_category(&tls_error), None);
        let os_error = io::Error::from_raw_os_error(5);
        assert_eq!(certificate_error_category(&os_error), None);
    }

    #[test]
    fn certificate_classifier_stops_cycles_and_excessively_deep_chains() {
        #[derive(Debug)]
        struct Cycle;
        impl std::fmt::Display for Cycle {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("cycle")
            }
        }
        impl std::error::Error for Cycle {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(self)
            }
        }
        assert_eq!(certificate_error_category(&Cycle), None);
        let mut deep = io::Error::new(
            io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer),
        );
        for _ in 0..40 {
            deep = io::Error::other(deep);
        }
        assert_eq!(certificate_error_category(&deep), None);
    }

    #[test]
    fn incomplete_remote_broker_config_never_selects_normal_transport() {
        assert!(activate(true, true, true, true, true).unwrap());
        for flags in [
            (false, true, true),
            (true, false, true),
            (true, true, false),
        ] {
            assert!(activate(true, flags.0, true, flags.1, flags.2).is_err());
        }
        assert!(activate(true, true, false, true, true).is_err());
        assert!(!activate(false, false, false, false, false).unwrap());
        assert!(activate(true, false, false, false, false).is_err());
        assert!(activate(true, true, false, false, false).is_err());
        assert!(activate(true, true, true, false, false).is_err());
    }

    #[test]
    fn pipe_name_rejects_network_and_unscoped_names() {
        assert!(validate_pipe_name(r"\\.\pipe\LOCAL\YuanZhou-model-0123").is_ok());
        for pipe in [
            r"\\server\pipe\LOCAL\model",
            r"\\.\pipe\model",
            r"\\.\pipe\LOCAL\",
            r"\\.\pipe\LOCAL\..",
            r"\\.\pipe\LOCAL\model\child",
            "http://127.0.0.1:1234",
        ] {
            assert!(validate_pipe_name(pipe).is_err());
        }
    }

    #[test]
    fn only_exact_post_route_with_unmodified_authority_is_allowed() {
        let mut request = Request {
            method: http::Method::POST,
            url: MODEL_PIPE_URL.into(),
            headers: HeaderMap::new(),
            body: None,
            compression: RequestCompression::None,
            timeout: None,
        };
        request
            .headers
            .insert("authorization", "Bearer synthetic-lease".parse().unwrap());
        assert!(validate_model_pipe_request(&request).is_ok());
        for url in [
            "http://model-broker.invalid/v1/responses",
            "https://127.0.0.1/v1/responses",
            "https://model-broker.invalid/v1/responses?next=/auth/admin",
            "https://model-broker.invalid:443/v1/responses",
            "https://model-broker.invalid/v1/responses/",
            "https://model-broker.invalid/v1/responses/compact",
        ] {
            request.url = url.into();
            assert!(validate_model_pipe_request(&request).is_err());
        }
        request.url = MODEL_PIPE_URL.into();
        request.method = http::Method::CONNECT;
        assert!(validate_model_pipe_request(&request).is_err());
        request.method = http::Method::POST;
        request
            .headers
            .insert("host", "attacker.invalid".parse().unwrap());
        assert!(validate_model_pipe_request(&request).is_err());
        request.headers.remove("host");
        request.compression = RequestCompression::Zstd;
        assert!(validate_model_pipe_request(&request).is_err());
    }

    #[test]
    fn ca_accepts_one_public_certificate_and_rejects_bundles_and_keys() {
        let certificate = rcgen::generate_simple_self_signed(vec!["model-broker.invalid".into()])
            .unwrap()
            .cert
            .pem();
        assert!(single_certificate(&certificate).is_ok());
        assert!(single_certificate(&(certificate.clone() + &certificate)).is_err());
        assert!(
            single_certificate("-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----")
                .is_err()
        );
        assert!(single_certificate("not a certificate").is_err());
    }
}
