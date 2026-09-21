use super::*;
use serde_json::json;

#[test]
#[cfg(any(windows, target_os = "macos"))]
fn shared_reference_follows_rotated_file_but_refuses_account_switch_or_missing_source() {
    let temp = tempfile::tempdir().unwrap();
    let root = crate::config::resource_root(&temp.path().join("fixture"), true).unwrap();
    let id =
        platform_security::central_secret_store::create(&root, "shared-source-test", b"synthetic")
            .unwrap();
    let extension = if cfg!(windows) { "dpapi" } else { "private" };
    let path = root
        .join("central-secrets/shared-source-test")
        .join(format!("{id}.{extension}"));
    let source = |account, marker| {
        serde_json::to_vec(&json!({"tokens":{"account_id":account,"access_token":format!("e30.e30.{marker}"),"refresh_token":"MUST_NOT_COPY"}})).unwrap()
    };
    std::fs::write(&path, source("fixture-account", "original")).unwrap();
    let link = Reference {
        schema_version: 2,
        source: "codex-home".into(),
        account_id: "fixture-account".into(),
        imported_at: 1,
    };
    assert_eq!(
        resolve_at(&link, &path).unwrap().access_token,
        "e30.e30.original"
    );
    std::fs::write(&path, source("fixture-account", "rotated")).unwrap();
    let latest = resolve_at(&link, &path).unwrap();
    assert_eq!(latest.access_token, "e30.e30.rotated");
    assert!(latest.refresh_token.is_none());
    std::fs::write(&path, source("different-account", "rotated")).unwrap();
    assert_eq!(
        resolve_at(&link, &path).err().unwrap().code,
        "MODEL_SHARED_ACCOUNT_CHANGED"
    );
    assert!(resolve_at(&link, &root.join("missing.json")).is_err());
}

#[test]
fn reference_contains_no_token_and_cannot_choose_a_path() {
    let link = Reference {
        schema_version: 2,
        source: "codex-home".into(),
        account_id: "fixture-account".into(),
        imported_at: 100,
    };
    let bytes = serde_json::to_vec(&link).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(value.get("accessToken").is_none());
    assert!(value.get("refreshToken").is_none());
    let mut malicious = value;
    malicious["path"] = json!("another-login");
    assert!(reference(&serde_json::to_vec(&malicious).unwrap()).is_err());
    assert_eq!(reference(&bytes).unwrap().account_id, "fixture-account");
}

#[test]
fn shared_status_contains_only_public_recovery_metadata() {
    let id = "shared-report-fixture";
    statuses().lock().unwrap().insert(
        id.into(),
        Status {
            digest: "private-token-digest".into(),
            failures: 1,
            next: 10,
            error: Some("MODEL_SHARED_TIMEOUT"),
            terminal: false,
        },
    );
    let bundle = parse_source(
        &serde_json::to_vec(
            &json!({"tokens":{"access_token":"e30.e30.fixture","account_id":"fixture"}}),
        )
        .unwrap(),
        1,
    )
    .unwrap();
    let mut public = report(&bundle, id, 2).unwrap();
    decorate(id, &mut public);
    assert_eq!(public.credential_source, "codex-shared");
    assert_eq!(public.renewal_state, "retrying");
    assert!(
        !serde_json::to_string(&public)
            .unwrap()
            .contains("private-token")
    );
    clear_state(id);
}

#[test]
#[ignore = "requires CENTRAL_SERVICE_QA_NODE; launches only synthetic authentication protocol fixtures"]
fn owned_authentication_process_protocol_timeout_cancel_and_cleanup_qa() {
    let node = std::env::var_os("CENTRAL_SERVICE_QA_NODE").expect("explicit fixture Node");
    let temp = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let fixture = r#"
const fs=require('node:fs'),rl=require('node:readline');
const mode=process.argv[1];
fs.writeFileSync('pid.txt',String(process.pid));
if(mode==='stubborn'||mode==='cancel')setInterval(()=>{},1000);
let stage=0;
const io=rl.createInterface({input:process.stdin});
io.on('line',line=>{
 const v=JSON.parse(line);
 if(v.method==='initialize'){if(stage++!==0)process.exit(2);process.stdout.write(JSON.stringify({id:1,result:{userAgent:'fixture'}})+'\n');return;}
 if(v.method==='initialized')return;
 if(v.method!=='getAuthStatus'||stage++!==1||v.params.includeToken!==true||v.params.refreshToken!==true)process.exit(3);
 if(mode==='hang'||mode==='stubborn'||mode==='cancel')return;
 if(mode==='request'){process.stdout.write(JSON.stringify({id:44,method:'item/commandExecution/requestApproval',params:{}})+'\n');return;}
 if(mode==='oversize'){process.stdout.write('x'.repeat(65537));return;}
 process.stdout.write(JSON.stringify({id:2,result:{authMethod:'chatgpt',authToken:mode==='missing'?null:'SYNTHETIC_ACCESS'}})+'\n');
});
io.on('close',()=>{if(mode==='stubborn'||mode==='cancel')return;fs.writeFileSync('closed.txt','EOF');process.exit(0);});
"#;
    for (mode, expected) in [
        ("ok", None),
        ("request", Some("MODEL_SHARED_PROTOCOL_INVALID")),
        ("oversize", Some("MODEL_SHARED_PROTOCOL_INVALID")),
        ("missing", Some("MODEL_SHARED_RELOGIN_REQUIRED")),
        ("hang", Some("MODEL_SHARED_TIMEOUT")),
    ] {
        let run = temp.path().join(mode);
        std::fs::create_dir(&run).unwrap();
        let args = vec!["-e".into(), fixture.into(), mode.into(), "--".into()];
        let result = authenticate_args(
            Path::new(&node),
            &args,
            &run,
            &cancel,
            true,
            Duration::from_secs(3),
        );
        if let Some(code) = expected {
            assert_eq!(result.err().unwrap().code, code);
        } else {
            assert_eq!(&**result.as_ref().unwrap(), "SYNTHETIC_ACCESS");
        }
        assert!(
            run.join("closed.txt").exists(),
            "owned child received EOF and exited"
        );
    }
    for mode in ["stubborn", "cancel"] {
        let run = temp.path().join(mode);
        std::fs::create_dir(&run).unwrap();
        let args = vec!["-e".into(), fixture.into(), mode.into(), "--".into()];
        let result = std::thread::scope(|scope| {
            if mode == "cancel" {
                let run = &run;
                let cancel = &cancel;
                scope.spawn(move || {
                    for _ in 0..100 {
                        if run.join("pid.txt").exists() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    cancel.store(true, Ordering::SeqCst);
                });
            }
            authenticate_args(
                Path::new(&node),
                &args,
                &run,
                &cancel,
                true,
                Duration::from_secs(3),
            )
        });
        assert_eq!(
            result.err().unwrap().code,
            if mode == "cancel" {
                "MODEL_SHARED_CANCELLED"
            } else {
                "MODEL_SHARED_TIMEOUT"
            }
        );
        let pid = std::fs::read_to_string(run.join("pid.txt")).unwrap();
        let probe = std::process::Command::new(&node)
            .args(["-e", "try{process.kill(Number(process.argv[1]),0);process.exit(1)}catch(e){process.exit(e.code==='ESRCH'?0:2)}", &pid])
            .status().unwrap();
        assert!(
            probe.success(),
            "unresponsive authentication child was killed and reaped"
        );
    }
    cancel.store(true, Ordering::SeqCst);
    assert_eq!(
        authenticate_args(
            Path::new(&node),
            &[],
            temp.path(),
            &cancel,
            true,
            Duration::from_secs(1)
        )
        .err()
        .unwrap()
        .code,
        "MODEL_SHARED_CANCELLED"
    );
}

#[test]
#[ignore = "explicit real central login read; only getAuthStatus without forced refresh; never prints tokens"]
fn existing_central_login_authentication_qa() {
    let resources =
        std::env::var_os("CENTRAL_SHARED_AUTH_QA_RESOURCES").expect("verified resources");
    let package_id = std::env::var("CENTRAL_SHARED_AUTH_QA_PACKAGE").expect("catalog package");
    let package =
        crate::runtime_package::prepare_service(Path::new(&resources), &package_id).unwrap();
    let source = profile::source().unwrap();
    let token = authenticate(
        &package.app_server,
        source.parent().unwrap(),
        &AtomicBool::new(false),
        false,
        Duration::from_secs(30),
    )
    .unwrap();
    let after = parse_source(&read_source(&source).unwrap(), now()).unwrap();
    assert!(token.as_str() == after.access_token);
    assert!(validate(&after).unwrap().is_some_and(|exp| exp > now()));
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("shared-reference-qa");
    let linked = link_existing(&root).unwrap();
    assert_eq!(linked.credential_source, "codex-shared");
    assert_eq!(link_existing(&root).unwrap().account_id, linked.account_id);
    renew(
        &root,
        &linked.account_id,
        &package,
        &AtomicBool::new(false),
        true,
    )
    .unwrap();
    let loaded = load_internal(&root, &linked.account_id).unwrap();
    let current = parse_source(&read_source(&source).unwrap(), now()).unwrap();
    assert!(loaded.access_token() == current.access_token);
    assert!(current.refresh_token.is_none());
}
