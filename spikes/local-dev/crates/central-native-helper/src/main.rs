// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Fixed central-process protocol. Never expose its stdout to a renderer or log.
use serde::Deserialize;
use std::io::{Read, Write};
use zeroize::Zeroizing;

const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_JSON_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    version: u8,
    path: String,
    max_bytes: usize,
}

fn parse_request(bytes: &[u8]) -> Result<Request, &'static str> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("CENTRAL_PRIVATE_PROTOCOL_INVALID");
    }
    let request: Request =
        serde_json::from_slice(bytes).map_err(|_| "CENTRAL_PRIVATE_PROTOCOL_INVALID")?;
    if request.version != 1
        || request.path.is_empty()
        || request.path.contains('\0')
        || request.max_bytes == 0
        || request.max_bytes > MAX_JSON_BYTES
    {
        return Err("CENTRAL_PRIVATE_PROTOCOL_INVALID");
    }
    Ok(request)
}

fn write_payload(bytes: &[u8], output: &mut impl Write) -> Result<(), &'static str> {
    // Validate without constructing a second owned tree of secret strings.
    let _: serde::de::IgnoredAny =
        serde_json::from_slice(bytes).map_err(|_| "CENTRAL_PRIVATE_JSON_INVALID")?;
    output
        .write_all(b"{\"version\":1,\"ok\":true,\"payload\":")
        .and_then(|_| output.write_all(bytes))
        .and_then(|_| output.write_all(b"}\n"))
        .and_then(|_| output.flush())
        .map_err(|_| "CENTRAL_PRIVATE_OUTPUT_FAILED")
}

#[cfg(windows)]
fn execute(request: Request, output: &mut impl Write) -> Result<(), String> {
    let bytes = platform_security::central_private_file::read_private_file(
        std::path::Path::new(&request.path),
        request.max_bytes,
    )
    .map_err(|error| error.to_string())?;
    write_payload(&bytes, output).map_err(str::to_owned)
}

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 || args[0] != "read-private-json-v1" {
        return Err("CENTRAL_PRIVATE_PROTOCOL_INVALID".into());
    }
    #[cfg(not(windows))]
    {
        return Err("CENTRAL_PRIVATE_WINDOWS_REQUIRED".into());
    }
    #[cfg(windows)]
    {
        let mut input = Zeroizing::new(Vec::new());
        std::io::stdin()
            .lock()
            .take((MAX_REQUEST_BYTES + 1) as u64)
            .read_to_end(&mut input)
            .map_err(|_| "CENTRAL_PRIVATE_INPUT_FAILED")?;
        let request = parse_request(&input)?;
        execute(request, &mut std::io::stdout().lock())
    }
}

fn main() -> std::process::ExitCode {
    // A panic must never print paths, payloads or debug structures.
    std::panic::set_hook(Box::new(|_| {}));
    match std::panic::catch_unwind(run) {
        Ok(Ok(())) => std::process::ExitCode::SUCCESS,
        result => {
            let code = match &result {
                Ok(Err(code)) => code.as_str(),
                _ => "CENTRAL_PRIVATE_INTERNAL_ERROR",
            };
            let _ = writeln!(std::io::stderr().lock(), "{code}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_rejects_extra_fields_versions_sizes_and_trailing_requests() {
        for input in [
            r#"{"version":2,"path":"C:\\fixture","maxBytes":100}"#,
            r#"{"version":1,"path":"C:\\fixture","maxBytes":0}"#,
            r#"{"version":1,"path":"C:\\fixture","maxBytes":1048577}"#,
            r#"{"version":1,"path":"C:\\fixture","maxBytes":100,"command":"run"}"#,
            r#"{"version":1,"path":"C:\\fixture","maxBytes":100}{}"#,
        ] {
            assert!(parse_request(input.as_bytes()).is_err());
        }
        assert!(parse_request(br#"{"version":1,"path":"C:\\fixture","maxBytes":100}"#).is_ok());
    }
    #[test]
    fn invalid_json_writes_no_partial_payload() {
        let mut output = Vec::new();
        assert_eq!(
            write_payload(b"{\"synthetic\":", &mut output),
            Err("CENTRAL_PRIVATE_JSON_INVALID")
        );
        assert!(output.is_empty());
        write_payload(br#"{"synthetic":"only"}"#, &mut output).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value["payload"]["synthetic"], "only");
        assert_eq!(value["version"], 1);
    }
}
