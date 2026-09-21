use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
};

fn tokens(account: &str, exp: u64, refresh: &str) -> Value {
    let payload =
        json!({"exp":exp/1000,"https://api.openai.com/auth":{"chatgpt_account_id":account}});
    json!({"access_token":format!("e30.{}.fixture",base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())),"refresh_token":refresh})
}
struct Mock {
    authority: Authority,
    calls: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Err(error) = self.thread.take().unwrap().join() {
            if !thread::panicking() {
                std::panic::resume_unwind(error);
            }
        }
    }
}
fn mock(responses: Vec<(u16, Value)>) -> Mock {
    mock_routes(move |index, headers, body| {
        assert!(headers.starts_with("POST /oauth/token "));
        let request: Value = serde_json::from_slice(body).unwrap();
        assert_eq!(request["grant_type"], "refresh_token");
        assert_eq!(request["client_id"], CLIENT_ID);
        assert!(
            request["refresh_token"]
                .as_str()
                .unwrap()
                .starts_with("SYNTHETIC_")
        );
        responses.get(index).expect("no duplicate refresh").clone()
    })
}
fn mock_routes(handler: impl Fn(usize, &str, &[u8]) -> (u16, Value) + Send + 'static) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let worker = thread::spawn(move || {
        while !stopped.load(Ordering::SeqCst) {
            let Ok((mut stream, _)) = listener.accept() else {
                thread::sleep(Duration::from_millis(5));
                continue;
            };
            // Windows accepted sockets inherit the listener's nonblocking mode.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") {
                assert!(bytes.len() < 8192);
                stream.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
            }
            let headers = String::from_utf8(bytes).unwrap();
            let length = headers
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length: ")
                        .map(|s| s.parse::<usize>().unwrap())
                })
                .unwrap();
            let mut body = vec![0; length];
            stream.read_exact(&mut body).unwrap();
            let index = count.fetch_add(1, Ordering::SeqCst);
            let (status, value) = handler(index, &headers, &body);
            let body = serde_json::to_vec(&value).unwrap();
            write!(stream,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    Mock {
        authority: Authority {
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
            issuer,
        },
        calls,
        stop,
        thread: Some(worker),
    }
}

#[test]
#[cfg(any(windows, target_os = "macos"))]
fn dedicated_device_login_pending_cancel_timeout_and_exactly_once_persistence() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("central");
    let server = mock_routes(|index, headers, body| match index {
        0 | 4 => {
            assert!(headers.starts_with("POST /api/accounts/deviceauth/usercode "));
            (
                200,
                json!({"device_auth_id":"SYNTHETIC_DEVICE","user_code":"FAKE-CODE","interval":"5"}),
            )
        }
        1 => {
            assert!(headers.starts_with("POST /api/accounts/deviceauth/token "));
            (403, Value::Null)
        }
        2 => {
            assert!(headers.starts_with("POST /api/accounts/deviceauth/token "));
            (
                200,
                json!({"authorization_code":"SYNTHETIC_CODE","code_verifier":"SYNTHETIC_VERIFIER"}),
            )
        }
        3 => {
            assert!(headers.starts_with("POST /oauth/token "));
            let form: std::collections::HashMap<_, _> =
                url::form_urlencoded::parse(body).into_owned().collect();
            assert_eq!(form.get("grant_type").unwrap(), "authorization_code");
            assert_eq!(form.get("client_id").unwrap(), CLIENT_ID);
            assert_eq!(
                form.get("redirect_uri").unwrap(),
                "https://auth.openai.com/deviceauth/callback"
            );
            (
                200,
                tokens("dedicated-fixture", now() + 10 * LEAD, "SYNTHETIC_MANAGED"),
            )
        }
        _ => panic!("no duplicate authorization exchange"),
    });
    let login = login_start_with(&server.authority).unwrap();
    assert_eq!(login.state, "pending");
    assert!(login_start_with(&server.authority).is_err());
    assert_eq!(
        login_poll_with(&root, &login.login_id, &server.authority)
            .unwrap()
            .state,
        "pending"
    );
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    LOGIN
        .get()
        .unwrap()
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .next_poll = 0;
    assert_eq!(
        login_poll_with(&root, &login.login_id, &server.authority)
            .unwrap()
            .state,
        "pending"
    );
    LOGIN
        .get()
        .unwrap()
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .next_poll = 0;
    let completed = login_poll_with(&root, &login.login_id, &server.authority).unwrap();
    assert!(completed.account.as_ref().unwrap().refresh_supported);
    assert_eq!(
        login_poll_with(&root, &login.login_id, &server.authority)
            .unwrap()
            .account
            .unwrap()
            .account_id,
        completed.account.unwrap().account_id
    );
    assert_eq!(server.calls.load(Ordering::SeqCst), 4);
    let next = login_start_with(&server.authority).unwrap();
    LOGIN
        .get()
        .unwrap()
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .expires = 0;
    assert!(login_poll_with(&root, &next.login_id, &server.authority).is_err());
    login_cancel(&next.login_id).unwrap();
    assert!(LOGIN.get().unwrap().lock().unwrap().is_none());
    assert_eq!(server.calls.load(Ordering::SeqCst), 5);
}

#[test]
fn response_identity_and_expiry_are_checked_without_exposing_secrets() {
    let previous = token_bundle(&tokens("a", 4_000_000_000, "SYNTHETIC_OLD"), None, 100).unwrap();
    assert!(
        token_bundle(
            &tokens("b", 4_000_000_000, "SYNTHETIC_NEW"),
            Some(&previous),
            100
        )
        .is_err()
    );
    assert!(token_bundle(&tokens("a", 100, "SYNTHETIC_NEW"), Some(&previous), 100).is_err());
    let public = serde_json::to_string(&report(&previous, "opaque", 100).unwrap()).unwrap();
    assert!(!public.contains("SYNTHETIC"));
    assert!(!public.contains(&previous.access_token));
    assert!(public.contains("\"refreshSupported\":true"));
    assert!(
        token_bundle(
            &json!({"access_token":"malformed","refresh_token":"SYNTHETIC"}),
            None,
            100
        )
        .is_err()
    );
}

#[test]
#[cfg(any(windows, target_os = "macos"))]
fn rotation_persistence_backoff_restart_and_shared_snapshot_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("application");
    let clock = now();

    let seed = token_bundle(
        &tokens("fixture", clock + 600_000, "SYNTHETIC_OLD"),
        None,
        clock,
    )
    .unwrap();
    let id = save_login(&root, &seed).unwrap();
    let service = mock(vec![
        (
            200,
            tokens("fixture", clock + LEAD + 600_000, "SYNTHETIC_NEW"),
        ),
        (
            200,
            tokens("fixture", clock + 2 * LEAD + 1200_000, "SYNTHETIC_NEWER"),
        ),
    ]);
    assert!(renew_with(&root, &id, &service.authority, clock).unwrap());

    let persisted = current_bundle(&root, &id).unwrap();
    assert_eq!(persisted.refresh_token.as_deref(), Some("SYNTHETIC_NEW"));
    assert!(!renew_with(&root, &id, &service.authority, clock).unwrap());
    assert_eq!(service.calls.load(Ordering::SeqCst), 1);
    let next = latest(&root, &id).unwrap().next_retry_at.unwrap();
    assert!(next > clock + 601_000);
    assert!(!renew_with(&root, &id, &service.authority, next - 1).unwrap());
    assert!(renew_with(&root, &id, &service.authority, next).unwrap());
    assert_eq!(
        current_bundle(&root, &id).unwrap().refresh_token.as_deref(),
        Some("SYNTHETIC_NEWER")
    );
    assert_eq!(service.calls.load(Ordering::SeqCst), 2);

    let short_id = save_login(&root, &seed).unwrap();
    let short = mock(vec![(
        200,
        tokens("fixture", clock + 600_000, "SYNTHETIC_SHORT"),
    )]);
    assert!(renew_with(&root, &short_id, &short.authority, clock).unwrap());
    assert!(!renew_with(&root, &short_id, &short.authority, clock + 30_000).unwrap());
    let due = latest(&root, &short_id).unwrap().next_retry_at.unwrap();
    assert!((clock + 299_000..=clock + 300_000).contains(&due));
    assert_eq!(short.calls.load(Ordering::SeqCst), 1);

    let id = save_login(&root, &seed).unwrap();

    let retry = mock(vec![
        (429, json!({"error":"fixture rate limit"})),
        (200, tokens("fixture", clock + 2 * LEAD, "SYNTHETIC_RETRY")),
    ]);
    assert_eq!(
        renew_with(&root, &id, &retry.authority, clock)
            .unwrap_err()
            .code,
        "MODEL_RENEWAL_NETWORK"
    );
    assert_eq!(
        account_report(&root, &id).unwrap().renewal_state,
        "retrying"
    );
    assert!(!renew_with(&root, &id, &retry.authority, clock + 20_000).unwrap());
    assert!(renew_with(&root, &id, &retry.authority, clock + 61_000).unwrap());
    assert_eq!(retry.calls.load(Ordering::SeqCst), 2);

    let exhausted_id = save_login(&root, &seed).unwrap();
    let exhausted = mock(vec![(503, Value::Null); MAX_RETRIES as usize + 1]);
    let mut retry_clock = clock;
    for attempt in 0..=MAX_RETRIES {
        assert!(renew_with(&root, &exhausted_id, &exhausted.authority, retry_clock).is_err());
        let state = latest(&root, &exhausted_id).unwrap();
        if attempt < MAX_RETRIES {
            retry_clock = state.next_retry_at.unwrap();
        } else {
            assert_eq!(state.phase, "reauth");
            assert!(state.next_retry_at.is_none());
        }
    }
    assert!(
        renew_with(
            &root,
            &exhausted_id,
            &exhausted.authority,
            retry_clock + LEAD
        )
        .is_err()
    );
    assert_eq!(
        exhausted.calls.load(Ordering::SeqCst),
        MAX_RETRIES as usize + 1
    );

    let id = save_login(&root, &seed).unwrap();

    let rejected = mock(vec![(
        401,
        json!({"error":{"code":"refresh_token_reused","message":"PRIVATE PROVIDER DETAIL"}}),
    )]);
    assert!(renew_with(&root, &id, &rejected.authority, clock).is_err());
    assert_eq!(
        account_report(&root, &id).unwrap().renewal_state,
        "reauth-required"
    );
    assert!(renew_with(&root, &id, &rejected.authority, clock + 1000).is_err());
    assert_eq!(rejected.calls.load(Ordering::SeqCst), 1);
    assert!(
        !serde_json::to_string(&account_report(&root, &id).unwrap())
            .unwrap()
            .contains("PRIVATE PROVIDER DETAIL")
    );

    let id = save_login(&root, &seed).unwrap();

    let mut interrupted = latest(&root, &id).unwrap();
    interrupted.phase = "attempt".into();
    append(&root, &mut interrupted).unwrap();
    assert_eq!(
        renew_with(&root, &id, &rejected.authority, clock)
            .unwrap_err()
            .code,
        "MODEL_RENEWAL_REAUTH_REQUIRED"
    );
    assert_eq!(rejected.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        current_bundle(&root, &id).unwrap().refresh_token.as_deref(),
        Some("SYNTHETIC_OLD")
    );

    let mut snapshot = seed;
    snapshot.refresh_token = None;
    let id = save_login(&root, &snapshot).unwrap();
    assert!(!renew_with(&root, &id, &rejected.authority, clock + 10000).unwrap());
    assert!(!account_report(&root, &id).unwrap().refresh_supported);
    assert_eq!(rejected.calls.load(Ordering::SeqCst), 1);
}
