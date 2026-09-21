#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
"""Capture/restore only the known pre-migration central gateway. Never print environment values."""
import ctypes, json, os, pathlib, struct, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[2]
directory = root / 'artifacts/central-macos/formal-migration-20260911'
record = directory / 'rollback.json'
assert sys.platform == 'darwin' and len(sys.argv) == 2
if sys.argv[1] == 'capture':
    pid = 90685
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN / KERN_PROCARGS2
    size = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0): raise RuntimeError('CAPTURE_UNAVAILABLE')
    buf = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0): raise RuntimeError('CAPTURE_UNAVAILABLE')
    raw = buf.raw[:size.value]; argc = struct.unpack_from('i', raw)[0]
    position = raw.index(b'\0', 4) + 1
    while raw[position] == 0: position += 1
    parts = raw[position:].split(b'\0'); argv = [x.decode() for x in parts[:argc]]
    assert len(argv) == 2 and argv[1] == 'dist/index.js' and pathlib.Path(argv[0]).name == 'node'
    env = {}
    for item in parts[argc:]:
        if not item: break
        key, value = item.split(b'=', 1); key = key.decode()
        if key in ['PATH','HOME','USER','LOGNAME','LANG','TMPDIR','NODE_OPTIONS','NODE_PATH'] or key.startswith(('CODEX_', 'TEST_GATEWAY_', 'OPENAI_')):
            env[key] = value.decode()
    assert env.get('TEST_GATEWAY_PORT', '4510') == '4510'
    # Historical deployment directory, independent of the current source layout.
    value = {'pid':pid,'argv':argv,'env':env,'cwd':str(root / 'services/test-gateway')}
    fd = os.open(record, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd,'w') as f: json.dump(value, f); f.flush(); os.fsync(f.fileno())
    print(json.dumps({'captured':True,'pid':pid,'environmentValuesPrinted':False}))
elif sys.argv[1] == 'restore':
    value = json.loads(record.read_text())
    import socket
    with socket.socket() as s:
        s.settimeout(1)
        if s.connect_ex(('127.0.0.1',4510)) == 0: raise RuntimeError('PORT_STILL_OCCUPIED')
    with open(root / 'logs/test-gateway.log','ab') as log:
        child = subprocess.Popen(value['argv'], cwd=value['cwd'], env=value['env'], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    print(json.dumps({'restoredPid':child.pid}))
else: raise RuntimeError('UNKNOWN_ACTION')
