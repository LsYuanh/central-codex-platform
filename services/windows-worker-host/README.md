# Windows Worker host candidate

This is a native controller for one AppContainer App Server process. It is not a
production isolation qualification. The gateway must explicitly select this
candidate and retain every existing runtime-marker and device-routing check.

Build from `.` with `powershell -NoProfile -File
scripts/build/build-windows-worker-host.ps1`. The default executable is
`target/windows-worker-host/windows-worker-host.exe`.

Arguments, in this exact order:

```
--root ABSOLUTE_WORKERS_ROOT --runtime ABSOLUTE_APP_SERVER_EXE
--sha256 LOWERCASE_SHA256 --user-key LOWERCASE_64_HEX
--instance LOWERCASE_32_HEX --model MODEL_ID --parent-pid GATEWAY_PID
```

The root's parent must exist. A new root is created with an owner-only protected
DACL. Existing managed directories must retain their exact expected ACLs; the
host never repairs or takes over an unsafe existing directory. The gateway must
not precreate user directories with Node's POSIX mode flags on Windows.

The initial stdin bootstrap is binary: eight ASCII bytes `YZWH0001`, little-endian
u32 loopback port, u32 lease byte length followed by 32–256 base64url ASCII bytes,
then u32 public-CA byte length followed by 1–16384 ASCII PEM bytes. Subsequent stdin
is App Server JSONL. Long-lived model credentials are never accepted. There is no
inherited-environment fallback and no QA environment switches.

Stdout consists solely of outer JSONL control frames:

* `host/ready`: `params.protocol`, `instanceId`, native App Server `pid`, `userKey`.
* `host/data`: `params.protocol`, `instanceId`, `base64`; decoded bytes are App
  Server stdout, which can span JSONL boundaries. Worker output can never create
  an outer ready/closed frame. Native chunks are at most 16384 bytes.
* `host/closed`: `params.protocol`, `instanceId`, `jobCloseVerified:true`, emitted
  only after the Worker exited, Job active-process count reached zero, the Job
  handle closed and all data pumps stopped. This is the final frame.

The protocol string is `windows-worker-host/v1`. A controller must observe both
the matching final closed frame and Host process exit before reusing the user
slot. Unexpected exit without that evidence is an unknown cleanup result.
An observed natural Worker exit is reported only as
`HOST_RUNTIME_EXIT_XXXXXXXX` on stderr (eight uppercase hexadecimal digits).
Controller EOF and the resulting explicit Job termination do not produce this
diagnostic. Worker stderr content is drained and never forwarded.
Writing the final closed receipt has a five-second bound. A blocked writer is
cancelled and joined; if cancellation cannot finish, the Host terminates without
releasing referenced stack memory. A missing or incomplete receipt remains an
unknown cleanup result for the controller.

User storage is stable at `<root>/<user-key>/{home,runtime,bin}`. The host derives a
stable AppContainer profile from physical root and user key, grants only that SID,
and never deletes the profile or user history on shutdown. The user directory is
not writable by the Worker; writable home/runtime roots do not grant deletion of
the roots or ACL mutation. App Server copies in `bin` are read/execute-only for
the Worker and are hashed and pinned before launch. Existing authentication files
or non-managed config files require explicit migration.
Windows startup paths are DOS spellings obtained from the pinned handles and
reopened to verify their file IDs and physical GUID paths. These spellings are
needed by the pinned runtime's Windows home canonicalization; no device prefix is
removed by string manipulation and the runtime binary itself is not changed.

Normal stdin EOF terminates the Job and produces cleanup evidence. A verified
parent-process death or 30-second startup timeout terminates the Host; Windows
then closes its non-inherited kill-on-close Job. This intentionally does not
fabricate a closed receipt. Each Host has its own Job and model bridge. The bridge
keeps its original transparent TLS transport and PID/SID verification; the QA
harness now includes this same implementation through a compatibility header.
`PROC_THREAD_ATTRIBUTE_JOB_LIST` places the suspended Worker in its Job atomically
inside `CreateProcess`; unsupported or failed assignment is fatal. There is no
created-but-unassigned process window and no post-creation assignment fallback.

Before qualification, exercise initialization marker, blocked central fs/exec,
stdio EOF cleanup, same-user restart/history restoration, second-user denial,
simultaneous same-user denial, parent crash, blocked output cancellation, invalid
hash/ACL/bootstrap, lease revocation, and explicit network rejection. The native
host itself neither claims these tests passed nor changes the production gateway.
