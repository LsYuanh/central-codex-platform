// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Native-only TLS material validation. No network connections or OS trust changes.

// Synthetic public test material generated locally for these tests. These private
// keys never protected a real account or deployment. The explicitly ignored
// lifecycle QA may bind a synthetic loopback-only server with this material.
#[cfg(all(test, any(windows, target_os = "macos")))]
mod certificate_tests {
    use super::*;
    fn private_temp() -> tempfile::TempDir {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        temp
    }
    pub(crate) fn store_service_fixture(app_data: &Path) -> String {
        let root = crate::config::resource_root(app_data, true).unwrap();
        let bytes = Zeroizing::new(serde_json::to_vec(&bundle()).unwrap());
        platform_security::central_secret_store::create(&root, NAMESPACE, &bytes).unwrap()
    }
    const CA: &str = "-----BEGIN CERTIFICATE-----\nMIIBtTCCAVugAwIBAgIUJ6HbdMSWegM0epZSBEbvFgNfHPwwCgYIKoZIzj0EAwIw\nKDEmMCQGA1UEAwwdQ2VudHJhbCBUTFMgU3ludGhldGljIFVuaXQgQ0EwHhcNMjYw\nOTEwMDYyMzA1WhcNMjYxMDEwMDYyMzA1WjAoMSYwJAYDVQQDDB1DZW50cmFsIFRM\nUyBTeW50aGV0aWMgVW5pdCBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABELQ\ncNrzjwv8ZrzFPN8OCbaIS4jCWsaeRJ7kC8x44Px29uFTompNtlGpVrWwcRk4zX8t\nhj9564Oz7mzJ1sfK/G2jYzBhMB0GA1UdDgQWBBQRAd159yPPAx6NFuE9L/QMwx82\n8DAfBgNVHSMEGDAWgBQRAd159yPPAx6NFuE9L/QMwx828DAPBgNVHRMBAf8EBTAD\nAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNIADBFAiEAwziJvMaEnGgp\n4EF48T2bazjm8f5xtD5jnjRfY50Np3kCIG7lzaYScMNh4BdOy8MUApzhBUUFyCpJ\nCREm1WKzlXsX\n-----END CERTIFICATE-----\n";
    const KEY: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgqpQ/ArQL9ycW4Vho\nDMH59o9B7xFrKdrCnpGRfp435AyhRANCAAT+Ei6C00WZ+WhXVjs6m2tuUW8H5tde\ncbzldFGyx6CmK9CnyFtOIr/FTDofWKKkOSs9PlJ/XBLjRnHy2M9yN6vI\n-----END PRIVATE KEY-----\n";
    const WRONG_KEY: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgbLcCd23QPOHCRUtv\n/UaN7eGBF/XmptpcjlGbBHE2XpehRANCAARC0HDa848L/Ga8xTzfDgm2iEuIwlrG\nnkSe5AvMeOD8dvbhU6JqTbZRqVa1sHEZOM1/LYY/eeuDs+5sydbHyvxt\n-----END PRIVATE KEY-----\n";
    const SERVER: &str = "-----BEGIN CERTIFICATE-----\nMIIB1TCCAXqgAwIBAgIBAjAKBggqhkjOPQQDAjAoMSYwJAYDVQQDDB1DZW50cmFs\nIFRMUyBTeW50aGV0aWMgVW5pdCBDQTAeFw0yNjA5MTAwNjIzMDVaFw0yNjA5MzAw\nNjIzMDVaMB8xHTAbBgNVBAMMFGNlbnRyYWwtdGVzdC5pbnZhbGlkMFkwEwYHKoZI\nzj0CAQYIKoZIzj0DAQcDQgAE/hIugtNFmfloV1Y7OptrblFvB+bXXnG85XRRsseg\npivQp8hbTiK/xUw6H1iipDkrPT5Sf1wS40Zx8tjPcjeryKOBnTCBmjAMBgNVHRMB\nAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAlBgNV\nHREEHjAcghRjZW50cmFsLXRlc3QuaW52YWxpZIcEwAACCjAdBgNVHQ4EFgQULZuC\nrToLxhaz2rD6CQ9VOBanLXgwHwYDVR0jBBgwFoAUEQHdefcjzwMejRbhPS/0DMMf\nNvAwCgYIKoZIzj0EAwIDSQAwRgIhAPTPjbVt6QwJfqrFWLoUhupI2HbpkhWBcWHV\niEO7/R48AiEAlQ8ohsQFrcUiZxaisjpJmaStStRoNthYWbrN9XqUeUU=\n-----END CERTIFICATE-----\n";
    const OTHER_CA: &str = "-----BEGIN CERTIFICATE-----\nMIIBsTCCAVegAwIBAgIUZR0b02ZDRqggzDAeIwJLl6SiZp8wCgYIKoZIzj0EAwIw\nJjEkMCIGA1UEAwwbVW5yZWxhdGVkIFN5bnRoZXRpYyBVbml0IENBMB4XDTI2MDkx\nMDA2MjUwNVoXDTI2MTAxMDA2MjUwNVowJjEkMCIGA1UEAwwbVW5yZWxhdGVkIFN5\nbnRoZXRpYyBVbml0IENBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAElc2bWsid\nE2Y7gI9T2/kA6YP4c+BLckkO1Ql91V3/lbEuKV3qOGzKhE9QEcejXzfv4yI/aH0k\n5gfBQ4jUJKunUKNjMGEwHQYDVR0OBBYEFDwyNF1Dw1OwBw0Gunu6dgzmL1mIMB8G\nA1UdIwQYMBaAFDwyNF1Dw1OwBw0Gunu6dgzmL1mIMA8GA1UdEwEB/wQFMAMBAf8w\nDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCIQCbeDxPM8o15AhJu3yV\na12Iy/SO4IOWCZXC2QNfGgXLWgIgbTRAaLv5AhEynV+k7xrfBWNrnWIdyP7zrpSB\nkI4L40k=\n-----END CERTIFICATE-----\n";
    const CLIENT_ONLY: &str = "-----BEGIN CERTIFICATE-----\nMIIBzjCCAXSgAwIBAgIBAzAKBggqhkjOPQQDAjAoMSYwJAYDVQQDDB1DZW50cmFs\nIFRMUyBTeW50aGV0aWMgVW5pdCBDQTAeFw0yNjA5MTAwNjIzMDVaFw0yNjA5MzAw\nNjIzMDVaMB8xHTAbBgNVBAMMFGNlbnRyYWwtdGVzdC5pbnZhbGlkMFkwEwYHKoZI\nzj0CAQYIKoZIzj0DAQcDQgAE/hIugtNFmfloV1Y7OptrblFvB+bXXnG85XRRsseg\npivQp8hbTiK/xUw6H1iipDkrPT5Sf1wS40Zx8tjPcjeryKOBlzCBlDAMBgNVHRMB\nAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDAjAfBgNV\nHREEGDAWghRjZW50cmFsLXRlc3QuaW52YWxpZDAdBgNVHQ4EFgQULZuCrToLxhaz\n2rD6CQ9VOBanLXgwHwYDVR0jBBgwFoAUEQHdefcjzwMejRbhPS/0DMMfNvAwCgYI\nKoZIzj0EAwIDSAAwRQIhAKxlthRAGasBBo6jc1nQdlS6qtjRCKzSKPW42zNlXgJM\nAiB2ubRIwHxF5NSU61A/wXhO+FOfi7Y3q8d/TfAt3nuLTg==\n-----END CERTIFICATE-----\n";
    const WRONG_USAGE_CA: &str = "-----BEGIN CERTIFICATE-----\nMIIBtTCCAVugAwIBAgIUFqo3tkPNDy77mh58Mq68M9CZ2OYwCgYIKoZIzj0EAwIw\nKDEmMCQGA1UEAwwdQ2VudHJhbCBUTFMgU3ludGhldGljIFVuaXQgQ0EwHhcNMjYw\nOTEwMDYyODA2WhcNMjYxMDEwMDYyODA2WjAoMSYwJAYDVQQDDB1DZW50cmFsIFRM\nUyBTeW50aGV0aWMgVW5pdCBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABELQ\ncNrzjwv8ZrzFPN8OCbaIS4jCWsaeRJ7kC8x44Px29uFTompNtlGpVrWwcRk4zX8t\nhj9564Oz7mzJ1sfK/G2jYzBhMB0GA1UdDgQWBBQRAd159yPPAx6NFuE9L/QMwx82\n8DAfBgNVHSMEGDAWgBQRAd159yPPAx6NFuE9L/QMwx828DAPBgNVHRMBAf8EBTAD\nAQH/MA4GA1UdDwEB/wQEAwIHgDAKBggqhkjOPQQDAgNIADBFAiEAqyjAehnSiPah\nqD+PhOtLPSuKqZlxQ1vuDFtFqD2H44ICIHkLImRKJnwt1KsPEMPx6zYmFAsoZO3n\nk0F+pp3byFuj\n-----END CERTIFICATE-----\n";
    const AT: u64 = 1789128000000;
    const URL: &str = "wss://central-test.invalid:4510/ws";
    #[test]
    fn portable_der_checks_ca_time_usage_and_trailing_bytes() {
        let ca = certificates(CA).unwrap().remove(0);
        let server = certificates(SERVER).unwrap().remove(0);
        assert!(certificate_der::expiry(ca.as_ref(), AT, true).is_ok());
        assert!(certificate_der::expiry(server.as_ref(), AT, false).is_ok());
        assert!(certificate_der::expiry(server.as_ref(), AT, true).is_err());
        assert!(certificate_der::expiry(ca.as_ref(), 0, true).is_err());
        assert!(certificate_der::expiry(ca.as_ref(), 7258118400000, true).is_err());
        let wrong = certificates(WRONG_USAGE_CA).unwrap().remove(0);
        assert!(certificate_der::expiry(wrong.as_ref(), AT, true).is_err());
        let mut trailing = ca.as_ref().to_vec();
        trailing.push(0);
        assert!(certificate_der::expiry(&trailing, AT, true).is_err());
    }
    fn bundle() -> Bundle {
        Bundle {
            schema_version: 1,
            chain_pem: SERVER.into(),
            key_pem: KEY.into(),
            ca_pem: CA.into(),
        }
    }
    fn checked(b: &Bundle, url: &str, time: u64) -> Result<CertificateReport> {
        verify(b, url, "synthetic-certificate", Some(7), time)
    }
    #[test]
    fn verifies_chain_name_ip_time_and_matching_key_without_exposing_material() {
        let b = bundle();
        let report = checked(&b, URL, AT).unwrap();
        assert_eq!(report.leaf_fingerprint_sha256.len(), 64);
        assert_eq!(report.config_revision, Some(7));
        assert!(report.leaf_expires_at > AT);
        assert!(!report.private_key_persisted);
        assert!(!report.runtime_ready);
        assert!(!report.revocation_checked);
        let public = serde_json::to_string(&report).unwrap();
        assert!(!public.contains("PRIVATE KEY"));
        assert!(!public.contains("CERTIFICATE-----"));
        assert!(checked(&b, "wss://192.0.2.10:4510/ws", AT).is_ok());
    }
    #[test]
    fn rejects_hostname_mismatch() {
        assert_eq!(
            checked(&bundle(), "wss://other.invalid:4510/ws", AT)
                .err()
                .unwrap()
                .code,
            "TLS_HOSTNAME_MISMATCH"
        );
    }
    #[test]
    fn rejects_wrong_private_key() {
        let mut b = bundle();
        b.key_pem = WRONG_KEY.into();
        assert_eq!(
            checked(&b, URL, AT).err().unwrap().code,
            "TLS_PRIVATE_KEY_MISMATCH"
        );
    }
    #[test]
    fn rejects_unrelated_trust_anchor_and_leaf_as_ca() {
        let mut b = bundle();
        b.ca_pem = OTHER_CA.into();
        assert_eq!(
            checked(&b, URL, AT).err().unwrap().code,
            "TLS_CHAIN_INVALID"
        );
        b.ca_pem = SERVER.into();
        assert_eq!(
            checked(&b, URL, AT).err().unwrap().code,
            "TLS_CHAIN_INVALID"
        );
    }
    #[test]
    fn rejects_client_only_usage_for_server() {
        let mut b = bundle();
        b.chain_pem = CLIENT_ONLY.into();
        assert_eq!(
            checked(&b, URL, AT).err().unwrap().code,
            "TLS_CHAIN_INVALID"
        );
    }
    #[test]
    fn rejects_ca_without_certificate_signing_usage() {
        let mut b = bundle();
        b.ca_pem = WRONG_USAGE_CA.into();
        assert_eq!(
            checked(&b, URL, AT).err().unwrap().code,
            "TLS_CHAIN_INVALID"
        );
    }
    #[test]
    fn rejects_expired_and_not_yet_valid_material() {
        for time in [0, 7258118400000] {
            assert_eq!(
                checked(&bundle(), URL, time).err().unwrap().code,
                "TLS_CERTIFICATE_TIME_INVALID"
            );
        }
    }
    #[test]
    fn public_ca_export_never_contains_private_key() {
        let directory = private_temp();
        let b = bundle();
        let bytes = Zeroizing::new(serde_json::to_vec(&b).unwrap());
        let resource_root = crate::config::resource_root(directory.path(), true).unwrap();
        let id = platform_security::central_secret_store::create(&resource_root, NAMESPACE, &bytes)
            .unwrap();
        let exported = public_ca(directory.path(), &id).unwrap();
        assert_eq!(exported, CA);
        assert!(!exported.contains("PRIVATE KEY"));
        let decoded = load_bundle(directory.path(), &id).unwrap();
        assert!(checked(&decoded, URL, AT).is_ok());
    }

    #[test]
    fn imports_directory_recovers_inventory_and_rejects_bad_host_without_writing() {
        // The fixture has fixed certificate dates. Pin only this test thread's
        // clock; production code and the ignored interactive QA retain real time.
        struct ClockGuard(Option<u64>);
        impl Drop for ClockGuard {
            fn drop(&mut self) {
                TEST_CHECKED_AT.with(|clock| clock.set(self.0));
            }
        }
        let _clock = ClockGuard(TEST_CHECKED_AT.with(|clock| clock.replace(Some(AT))));
        let input = private_temp();
        let output = private_temp();
        fs::write(input.path().join("server.pem"), SERVER).unwrap();
        fs::write(input.path().join("server-key.pem"), KEY).unwrap();
        fs::write(input.path().join("ca.pem"), CA).unwrap();
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::PermissionsExt;
            for name in ["server.pem", "server-key.pem", "ca.pem"] {
                fs::set_permissions(input.path().join(name), fs::Permissions::from_mode(0o600))
                    .unwrap();
            }
        }

        let imported = import_directory(output.path(), input.path(), URL).unwrap();
        assert!(imported.private_key_persisted);
        assert_eq!(imported.status, "imported");
        assert!(!imported.runtime_ready);
        assert!(!imported.revocation_checked);
        let entries = list(output.path(), URL).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].certificate_id, imported.certificate_id);
        assert!(entries[0].failure.is_none());
        let recovered = entries[0].report.as_ref().unwrap();
        assert_eq!(
            recovered.leaf_fingerprint_sha256,
            imported.leaf_fingerprint_sha256
        );
        assert!(recovered.private_key_persisted);

        let config: CentralConfig = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "revision": 3,
            "dataDirectory": output.path().join("central-data").to_string_lossy(),
            "listen": { "host": "127.0.0.1", "port": 4510 },
            "clientUrl": URL, "tls": { "certificateId": imported.certificate_id },
            "runtimePackageId": "synthetic-runtime",
            "limits": { "maxWorkers": 1, "perUserTurns": 1, "totalTurns": 1 },
            "shutdown": { "graceMs": 1000, "forceMs": 1000 }
        }))
        .unwrap();
        let inspected = inspect_stored(output.path(), &config).unwrap();
        assert_eq!(inspected.config_revision, Some(3));
        assert_eq!(
            inspected.leaf_fingerprint_sha256,
            imported.leaf_fingerprint_sha256
        );
        let exported = public_ca(output.path(), &config.tls.certificate_id).unwrap();
        assert_eq!(exported, CA);
        assert!(!exported.contains("PRIVATE KEY"));

        let resource_root = crate::config::resource_root(output.path(), false).unwrap();
        let before =
            platform_security::central_secret_store::list(&resource_root, NAMESPACE).unwrap();
        let rejected = import_directory(output.path(), input.path(), "wss://wrong.invalid:4510/ws");
        assert_eq!(rejected.err().unwrap().code, "TLS_HOSTNAME_MISMATCH");
        let after =
            platform_security::central_secret_store::list(&resource_root, NAMESPACE).unwrap();
        assert_eq!(before, after);
        assert_eq!(list(output.path(), URL).unwrap().len(), 1);
    }

    /// Explicit, ignored UI fixture preparation. The fixed QA namespace is the
    /// only permitted destination; this never starts a server or changes trust.
    #[test]
    #[ignore = "writes only the explicitly named synthetic resource UI QA profile"]
    fn prepare_resource_ui_qa() {
        use crate::config;
        use serde_json::json;
        const PROFILE: &str = "com.yuanzhou.central.resource-qa-20260910";
        const CLIENT_URL: &str = "wss://central-test.invalid:14523/ws";
        let appdata =
            std::path::PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA is required"));
        assert!(appdata.is_absolute(), "APPDATA must be absolute");
        let root = appdata.join(PROFILE);
        assert_eq!(root.parent(), Some(appdata.as_path()));
        assert_eq!(root.file_name().and_then(|s| s.to_str()), Some(PROFILE));
        let data_directory = root.join("central-data").to_string_lossy().into_owned();
        let expected = |certificate_id: &str, revision: u64| {
            json!({
                "schemaVersion": 1, "revision": revision,
                "dataDirectory": data_directory,
                "listen": { "host": "127.0.0.1", "port": 14523 },
                "clientUrl": CLIENT_URL,
                "tls": { "certificateId": certificate_id },
                "runtimePackageId": "windows-x64-codex-0.153.4-qa1",
                "limits": { "maxWorkers": 4, "perUserTurns": 1, "totalTurns": 4 },
                "shutdown": { "graceMs": 15000, "forceMs": 5000 }
            })
        };
        let current = serde_json::to_value(config::read(&root).unwrap()).unwrap();
        if !current["config"].is_null() {
            let saved: CentralConfig = serde_json::from_value(current["config"].clone()).unwrap();
            assert_eq!(
                current["config"],
                expected(&saved.tls.certificate_id, saved.revision),
                "Existing QA profile differs; refusing to alter it"
            );
            let stored = load_bundle(&root, &saved.tls.certificate_id).unwrap();
            assert!(
                stored.schema_version == 1
                    && stored.chain_pem == SERVER
                    && stored.key_pem == KEY
                    && stored.ca_pem == CA,
                "Existing QA certificate differs; refusing to alter it"
            );
            inspect_stored(&root, &saved).unwrap();
            return;
        }
        let fixture = bundle();
        verify(&fixture, CLIENT_URL, "synthetic-qa", None, now()).unwrap();
        let bytes = Zeroizing::new(serde_json::to_vec(&fixture).unwrap());
        let resource_root = config::resource_root(&root, true).unwrap();
        let id = platform_security::central_secret_store::create(&resource_root, NAMESPACE, &bytes)
            .unwrap();
        let stored = load_bundle(&root, &id).unwrap();
        verify(&stored, CLIENT_URL, &id, None, now()).unwrap();
        config::save(
            &root,
            "prepare-resource-ui-qa-20260910".into(),
            0,
            expected(&id, 0),
        )
        .unwrap();
        let saved = serde_json::to_value(config::read(&root).unwrap()).unwrap();
        assert_eq!(saved["config"], expected(&id, 1));
    }
}

#[cfg(all(test, windows))]
pub(crate) use certificate_tests::store_service_fixture;

use crate::config::{CentralConfig, Result, failure};
use rustls::{
    RootCertStore,
    client::{WebPkiServerVerifier, danger::ServerCertVerifier},
    pki_types::{
        CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime, pem::PemObject,
    },
    sign::CertifiedKey,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, Zeroizing};

const MAX_PEM: u64 = 512 * 1024;
const MAX_CERTIFICATES: usize = 12;

// Never derive Debug or expose this object through IPC.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    schema_version: u64,
    chain_pem: String,
    key_pem: String,
    ca_pem: String,
}
impl Drop for Bundle {
    fn drop(&mut self) {
        self.key_pem.zeroize();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateReport {
    pub certificate_id: String,
    pub config_revision: Option<u64>,
    pub client_url: String,
    pub checked_at: u64,
    pub leaf_fingerprint_sha256: String,
    pub leaf_expires_at: u64,
    pub certificate_count: usize,
    pub ca_certificate_count: usize,
    pub private_key_persisted: bool,
    pub runtime_ready: bool,
    pub revocation_checked: bool,
    pub status: &'static str,
}

#[cfg(test)]
std::thread_local! {
    static TEST_CHECKED_AT: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

fn now() -> u64 {
    #[cfg(test)]
    if let Some(value) = TEST_CHECKED_AT.with(std::cell::Cell::get) {
        return value;
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// Restrict each source to the expected PEM blocks. In particular, public CA export
// cannot accidentally include private material or arbitrary trailing source text.
fn pem_shape(text: &str, label: &str, maximum: usize) -> Result<()> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let (mut open, mut count, mut body) = (false, 0, false);
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line == begin && !open {
            open = true;
            body = false;
        } else if line == end && open && body {
            open = false;
            count += 1;
        } else if open
            && line
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
        {
            body = true;
        } else {
            return Err(failure("TLS_FORMAT_INVALID"));
        }
    }
    if open || count == 0 || count > maximum {
        return Err(failure("TLS_FORMAT_INVALID"));
    }
    Ok(())
}

fn certificates(text: &str) -> Result<Vec<CertificateDer<'static>>> {
    pem_shape(text, "CERTIFICATE", MAX_CERTIFICATES)?;
    CertificateDer::pem_slice_iter(text.as_bytes())
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| failure("TLS_FORMAT_INVALID"))
}

fn read_pem(directory: &Path, filename: &str) -> Result<String> {
    let path = directory.join(filename);
    #[cfg(target_os = "macos")]
    {
        let bytes =
            platform_security::central_secret_store::macos::read_private(&path, MAX_PEM as usize)
                .map_err(|_| failure("TLS_FILES_UNSAFE"))?;
        return std::str::from_utf8(&bytes)
            .map(str::to_owned)
            .map_err(|_| failure("TLS_FORMAT_INVALID"));
    }
    let metadata = fs::symlink_metadata(&path).map_err(|_| failure("TLS_FILES_MISSING"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PEM {
        return Err(failure("TLS_FILES_UNSAFE"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(failure("TLS_FILES_UNSAFE"));
        }
    }
    let mut bytes = Zeroizing::new(Vec::new());
    File::open(&path)
        .map_err(|_| failure("TLS_FILES_MISSING"))?
        .take(MAX_PEM + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("TLS_FILES_UNSAFE"))?;
    if bytes.len() as u64 > MAX_PEM {
        return Err(failure("TLS_FILES_UNSAFE"));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| failure("TLS_FORMAT_INVALID"))?;
    Ok(text.to_owned())
}

fn read_bundle(directory: &Path) -> Result<Bundle> {
    let metadata = fs::symlink_metadata(directory).map_err(|_| failure("TLS_FILES_MISSING"))?;
    if !directory.is_absolute() || !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure("TLS_FILES_UNSAFE"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(failure("TLS_FILES_UNSAFE"));
        }
    }
    // Read private material last, so earlier read errors never leave an unguarded key.
    let chain_pem = read_pem(directory, "server.pem")?;
    let ca_pem = read_pem(directory, "ca.pem")?;
    let key_pem = read_pem(directory, "server-key.pem")?;
    Ok(Bundle {
        schema_version: 1,
        chain_pem,
        key_pem,
        ca_pem,
    })
}

#[cfg(windows)]
fn certificate_expiry(cert: &CertificateDer<'_>, checked_at: u64, require_ca: bool) -> Result<u64> {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        Security::Cryptography::{
            CERT_BASIC_CONSTRAINTS2_INFO, CERT_KEY_CERT_SIGN_KEY_USAGE,
            CertCreateCertificateContext, CertFindExtension, CertFreeCertificateContext,
            CertGetIntendedKeyUsage, CertVerifyTimeValidity, CryptDecodeObjectEx,
            X509_ASN_ENCODING, X509_BASIC_CONSTRAINTS2, szOID_BASIC_CONSTRAINTS2, szOID_KEY_USAGE,
        },
    };
    unsafe {
        let context = CertCreateCertificateContext(
            X509_ASN_ENCODING,
            cert.as_ref().as_ptr(),
            cert.as_ref().len() as u32,
        );
        if context.is_null() {
            return Err(failure("TLS_FORMAT_INVALID"));
        }
        let ticks = checked_at
            .checked_mul(10_000)
            .and_then(|t| t.checked_add(116_444_736_000_000_000));
        let Some(ticks) = ticks else {
            CertFreeCertificateContext(context);
            return Err(failure("TLS_INVALID"));
        };
        let time = FILETIME {
            dwLowDateTime: ticks as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        };
        let info = (*context).pCertInfo;
        if require_ca {
            let extension = CertFindExtension(
                szOID_BASIC_CONSTRAINTS2,
                (*info).cExtension,
                (*info).rgExtension,
            );
            let mut constraints = CERT_BASIC_CONSTRAINTS2_INFO::default();
            let mut length = std::mem::size_of::<CERT_BASIC_CONSTRAINTS2_INFO>() as u32;
            if extension.is_null()
                || CryptDecodeObjectEx(
                    X509_ASN_ENCODING,
                    X509_BASIC_CONSTRAINTS2,
                    (*extension).Value.pbData,
                    (*extension).Value.cbData,
                    0,
                    std::ptr::null(),
                    (&mut constraints as *mut CERT_BASIC_CONSTRAINTS2_INFO).cast(),
                    &mut length,
                ) == 0
                || constraints.fCA == 0
            {
                CertFreeCertificateContext(context);
                return Err(failure("TLS_CHAIN_INVALID"));
            }
            let usage_extension =
                CertFindExtension(szOID_KEY_USAGE, (*info).cExtension, (*info).rgExtension);
            let mut usage = [0u8; 2];
            if !usage_extension.is_null()
                && (CertGetIntendedKeyUsage(
                    X509_ASN_ENCODING,
                    info,
                    usage.as_mut_ptr(),
                    usage.len() as u32,
                ) == 0
                    || usage[0] & CERT_KEY_CERT_SIGN_KEY_USAGE as u8 == 0)
            {
                CertFreeCertificateContext(context);
                return Err(failure("TLS_CHAIN_INVALID"));
            }
        }
        let validity = CertVerifyTimeValidity(&time, info);
        let end = (*info).NotAfter;
        let expiry = (((end.dwHighDateTime as u64) << 32) | end.dwLowDateTime as u64)
            .checked_sub(116_444_736_000_000_000)
            .map(|n| n / 10_000);
        CertFreeCertificateContext(context);
        if validity != 0 {
            return Err(failure("TLS_CERTIFICATE_TIME_INVALID"));
        }
        expiry.ok_or_else(|| failure("TLS_CERTIFICATE_TIME_INVALID"))
    }
}
#[cfg(any(test, target_os = "macos"))]
#[path = "certificate_der.rs"]
mod certificate_der;

#[cfg(target_os = "macos")]
fn certificate_expiry(cert: &CertificateDer<'_>, checked_at: u64, require_ca: bool) -> Result<u64> {
    certificate_der::expiry(cert.as_ref(), checked_at, require_ca)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn certificate_expiry(_: &CertificateDer<'_>, _: u64, _: bool) -> Result<u64> {
    Err(failure("TLS_PLATFORM_UNSUPPORTED"))
}

fn verify(
    bundle: &Bundle,
    client_url: &str,
    certificate_id: &str,
    revision: Option<u64>,
    checked_at: u64,
) -> Result<CertificateReport> {
    if bundle.schema_version != 1 {
        return Err(failure("TLS_FORMAT_INVALID"));
    }
    let chain = certificates(&bundle.chain_pem)?;
    let ca = certificates(&bundle.ca_pem)?;
    pem_shape(&bundle.key_pem, "PRIVATE KEY", 1)?;
    let key = Zeroizing::new(
        PrivatePkcs8KeyDer::from_pem_slice(bundle.key_pem.as_bytes())
            .map_err(|_| failure("TLS_FORMAT_INVALID"))?,
    );
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let borrowed_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.secret_pkcs8_der()));
    let signer = rustls::crypto::ring::sign::any_supported_type(&borrowed_key)
        .map_err(|_| failure("TLS_PRIVATE_KEY_MISMATCH"))?;
    let identity = CertifiedKey::new(chain.clone(), signer);
    // Require proven consistency; an unknown key consistency result is not enough.
    identity
        .keys_match()
        .map_err(|_| failure("TLS_PRIVATE_KEY_MISMATCH"))?;
    let mut roots = RootCertStore::empty();
    for cert in &ca {
        certificate_expiry(cert, checked_at, true)?;
        roots
            .add(cert.clone())
            .map_err(|_| failure("TLS_CHAIN_INVALID"))?;
    }
    let mut leaf_expires_at = 0;
    for (index, cert) in chain.iter().enumerate() {
        let expiry = certificate_expiry(cert, checked_at, false)?;
        if index == 0 {
            leaf_expires_at = expiry;
        }
    }
    let url = url::Url::parse(client_url).map_err(|_| failure("CONFIG_INVALID"))?;
    let host = url
        .host_str()
        .ok_or_else(|| failure("CONFIG_INVALID"))?
        .trim_matches(['[', ']']);
    if url.scheme() != "wss"
        || url.path() != "/ws"
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(failure("CONFIG_INVALID"));
    }
    let server_name =
        ServerName::try_from(host.to_owned()).map_err(|_| failure("CONFIG_INVALID"))?;
    let verifier = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider)
        .build()
        .map_err(|_| failure("TLS_CHAIN_INVALID"))?;
    verifier
        .verify_server_cert(
            &chain[0],
            &chain[1..],
            &server_name,
            &[],
            UnixTime::since_unix_epoch(Duration::from_millis(checked_at)),
        )
        .map_err(|error| {
            failure(match error {
                rustls::Error::InvalidCertificate(
                    rustls::CertificateError::NotValidForName
                    | rustls::CertificateError::NotValidForNameContext { .. },
                ) => "TLS_HOSTNAME_MISMATCH",
                _ => "TLS_CHAIN_INVALID",
            })
        })?;
    Ok(CertificateReport {
        certificate_id: certificate_id.to_owned(),
        config_revision: revision,
        client_url: client_url.to_owned(),
        checked_at,
        leaf_fingerprint_sha256: format!("{:x}", Sha256::digest(chain[0].as_ref())),
        leaf_expires_at,
        certificate_count: chain.len(),
        ca_certificate_count: ca.len(),
        private_key_persisted: false,
        runtime_ready: false,
        revocation_checked: false,
        status: "checked-not-imported",
    })
}

const NAMESPACE: &str = "tls-certificates-v1";

#[cfg(any(windows, target_os = "macos"))]
fn load_bundle(app_data: &Path, certificate_id: &str) -> Result<Bundle> {
    let resource_root = crate::config::resource_root(app_data, false)?;
    let bytes =
        platform_security::central_secret_store::load(&resource_root, NAMESPACE, certificate_id)
            .map_err(|_| failure("TLS_STORAGE_UNSAFE"))?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(failure("TLS_STORAGE_UNSAFE"));
    }
    serde_json::from_slice(&bytes).map_err(|_| failure("TLS_FORMAT_INVALID"))
}
#[cfg(not(any(windows, target_os = "macos")))]
fn load_bundle(_: &Path, _: &str) -> Result<Bundle> {
    Err(failure("TLS_PLATFORM_UNSUPPORTED"))
}

/// Source directory comes directly from a native folder picker, never IPC path text.
/// Import commits only validated material under a fresh opaque ID; no replacement.
pub fn import_directory(
    app_data: &Path,
    directory: &Path,
    client_url: &str,
) -> Result<CertificateReport> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let bundle = read_bundle(directory)?;
        let mut report = verify(&bundle, client_url, "", None, now())?;
        let bytes =
            Zeroizing::new(serde_json::to_vec(&bundle).map_err(|_| failure("TLS_FORMAT_INVALID"))?);
        let resource_root = crate::config::resource_root(app_data, true)?;
        let id = platform_security::central_secret_store::create(&resource_root, NAMESPACE, &bytes)
            .map_err(|_| failure("TLS_STORAGE_UNSAFE"))?;
        // Read-back checks DPAPI storage and material; callers must not claim import
        // success from a metadata-only write or retain plaintext source paths.
        let persisted = load_bundle(app_data, &id)?;
        report = verify(&persisted, client_url, &id, None, report.checked_at)?;
        report.private_key_persisted = true;
        report.status = "imported";
        Ok(report)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app_data, directory, client_url);
        Err(failure("TLS_PLATFORM_UNSUPPORTED"))
    }
}

pub fn inspect_stored(app_data: &Path, config: &CentralConfig) -> Result<CertificateReport> {
    let bundle = load_bundle(app_data, &config.tls.certificate_id)?;
    let mut report = verify(
        &bundle,
        &config.client_url,
        &config.tls.certificate_id,
        Some(config.revision),
        now(),
    )?;
    report.private_key_persisted = true;
    report.status = "imported";
    Ok(report)
}

/// Internal-only startup material. Never registered as a Tauri command.
pub(crate) fn service_material(
    app_data: &Path,
    config: &CentralConfig,
) -> Result<(String, Zeroizing<String>)> {
    let bundle = load_bundle(app_data, &config.tls.certificate_id)?;
    verify(
        &bundle,
        &config.client_url,
        &config.tls.certificate_id,
        Some(config.revision),
        now(),
    )?;
    Ok((
        bundle.chain_pem.clone(),
        Zeroizing::new(bundle.key_pem.clone()),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateEntry {
    pub certificate_id: String,
    pub report: Option<CertificateReport>,
    pub failure: Option<crate::config::Failure>,
}

/// Each record is freshly checked against the current client URL and clock.
/// An expired or mismatched record remains visible without blocking other records.
pub fn list(app_data: &Path, client_url: &str) -> Result<Vec<CertificateEntry>> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let resource_root = crate::config::resource_root(app_data, false)?;
        let ids = platform_security::central_secret_store::list(&resource_root, NAMESPACE)
            .map_err(|_| failure("TLS_STORAGE_UNSAFE"))?;
        let checked_at = now();
        Ok(ids
            .into_iter()
            .map(|id| {
                let result = load_bundle(app_data, &id)
                    .and_then(|bundle| verify(&bundle, client_url, &id, None, checked_at));
                match result {
                    Ok(mut report) => {
                        report.private_key_persisted = true;
                        report.status = "imported";
                        CertificateEntry {
                            certificate_id: id,
                            report: Some(report),
                            failure: None,
                        }
                    }
                    Err(error) => CertificateEntry {
                        certificate_id: id,
                        report: None,
                        failure: Some(error),
                    },
                }
            })
            .collect())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app_data, client_url);
        Err(failure("TLS_PLATFORM_UNSUPPORTED"))
    }
}

/// Returns public CA PEM only to the native caller for a native save dialog.
/// Must not return or serialize the surrounding bundle to the renderer.
pub fn public_ca(app_data: &Path, certificate_id: &str) -> Result<String> {
    let bundle = load_bundle(app_data, certificate_id)?;
    certificates(&bundle.ca_pem)?;
    Ok(bundle.ca_pem.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_mixed_secrets_in_public_ca_and_unknown_blocks() {
        let cert = "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n";
        assert!(pem_shape(cert, "CERTIFICATE", 12).is_ok());
        let key = "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----\n";
        assert!(pem_shape(&format!("{cert}{key}"), "CERTIFICATE", 12).is_err());
        assert!(pem_shape(&format!("{cert}secret-text"), "CERTIFICATE", 12).is_err());
        assert!(pem_shape(&format!("{key}{key}"), "PRIVATE KEY", 1).is_err());
        assert!(
            pem_shape(
                "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----",
                "CERTIFICATE",
                12
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_missing_and_oversized_sources() {
        let directory = tempfile::tempdir().unwrap();
        assert!(read_bundle(directory.path()).is_err());
        fs::write(
            directory.path().join("server.pem"),
            vec![b'x'; MAX_PEM as usize + 1],
        )
        .unwrap();
        assert!(read_pem(directory.path(), "server.pem").is_err());
    }
}
