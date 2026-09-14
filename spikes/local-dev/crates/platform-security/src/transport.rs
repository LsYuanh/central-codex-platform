// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use rustls::pki_types::{CertificateDer, pem::PemObject};
use std::error::Error;

pub(crate) fn config(pem: Option<&[u8]>) -> Result<rustls::ClientConfig, String> {
    let mut roots = rustls::RootCertStore::empty();
    if let Some(pem) = pem {
        let text = std::str::from_utf8(pem).map_err(|_| "CENTRAL_CA_INVALID")?;
        crate::pairing_bundle::validate_ca(text).map_err(|_| "CENTRAL_CA_INVALID")?;
        for cert in CertificateDer::pem_slice_iter(pem) {
            roots
                .add(cert.map_err(|_| "CENTRAL_CA_INVALID")?)
                .map_err(|_| "CENTRAL_CA_INVALID")?;
        }
    } else {
        for cert in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(cert);
        }
    }
    if roots.is_empty() {
        return Err("CENTRAL_CA_UNAVAILABLE".into());
    }
    Ok(
        rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| "CENTRAL_TLS_INIT_FAILED")?
        .with_root_certificates(roots)
        .with_no_client_auth(),
    )
}

pub(crate) fn http(config: rustls::ClientConfig) -> Result<reqwest::Client, String> {
    http_builder(config)
        .build()
        .map_err(|_| "CENTRAL_TLS_INIT_FAILED".into())
}

pub(crate) fn http_builder(config: rustls::ClientConfig) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .no_proxy()
        .retry(reqwest::retry::never())
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
}

// Return only fixed codes, never URL, bearer, certificate contents or raw errors.
pub(crate) fn error_code(error: &(dyn Error + 'static)) -> &'static str {
    fn classify(error: &(dyn Error + 'static), depth: usize) -> Option<&'static str> {
        if depth > 16 {
            return None;
        }
        if let Some(error) = error.downcast_ref::<rustls::Error>() {
            use rustls::CertificateError as Cert;
            return Some(match error {
                rustls::Error::InvalidCertificate(Cert::Expired | Cert::ExpiredContext { .. }) => {
                    "CENTRAL_CERT_EXPIRED"
                }
                rustls::Error::InvalidCertificate(
                    Cert::NotValidYet | Cert::NotValidYetContext { .. },
                ) => "CENTRAL_CERT_NOT_YET_VALID",
                rustls::Error::InvalidCertificate(
                    Cert::NotValidForName | Cert::NotValidForNameContext { .. },
                ) => "CENTRAL_CERT_NAME_MISMATCH",
                rustls::Error::InvalidCertificate(Cert::UnknownIssuer) => "CENTRAL_CERT_UNTRUSTED",
                rustls::Error::InvalidCertificate(_) => "CENTRAL_CERT_INVALID",
                _ => "CENTRAL_TLS_HANDSHAKE_FAILED",
            });
        }
        if let Some(io) = error.downcast_ref::<std::io::Error>() {
            if let Some(inner) = io.get_ref().and_then(|inner| classify(inner, depth + 1)) {
                return Some(inner);
            }
            match io.kind() {
                std::io::ErrorKind::ConnectionRefused => return Some("CENTRAL_CONNECTION_REFUSED"),
                std::io::ErrorKind::TimedOut => return Some("CENTRAL_CONNECTION_TIMEOUT"),
                _ => {}
            }
        }
        error
            .source()
            .and_then(|source| classify(source, depth + 1))
    }
    classify(error, 0).unwrap_or("CENTRAL_CONNECTION_FAILED")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_errors_keep_only_safe_categories() {
        for (cert, code) in [
            (rustls::CertificateError::Expired, "CENTRAL_CERT_EXPIRED"),
            (
                rustls::CertificateError::NotValidYet,
                "CENTRAL_CERT_NOT_YET_VALID",
            ),
            (
                rustls::CertificateError::NotValidForName,
                "CENTRAL_CERT_NAME_MISMATCH",
            ),
            (
                rustls::CertificateError::UnknownIssuer,
                "CENTRAL_CERT_UNTRUSTED",
            ),
        ] {
            let error = std::io::Error::other(rustls::Error::InvalidCertificate(cert));
            assert_eq!(error_code(&error), code);
        }
        assert_eq!(
            error_code(&std::io::Error::other("https://secret bearer=private")),
            "CENTRAL_CONNECTION_FAILED"
        );
        assert_eq!(
            error_code(&std::io::Error::from(std::io::ErrorKind::ConnectionRefused)),
            "CENTRAL_CONNECTION_REFUSED"
        );
    }
}
