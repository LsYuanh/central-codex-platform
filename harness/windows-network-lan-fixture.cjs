// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Temporary diagnostic TCP echo; compatible with the central host's existing Node.
const net = require('net');
const assert = require('assert');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert(['--bind', '--allowed-peer', '--timeout-seconds'].includes(key) && value && !args.has(key)); args.set(key, value);
}
const address = args.get('--bind'), peer = args.get('--allowed-peer'), lifetime = Number(args.get('--timeout-seconds'));
const privateV4 = ip => net.isIP(ip || '') === 4 && (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
assert(privateV4(address) && privateV4(peer)); assert(Number.isInteger(lifetime) && lifetime >= 10 && lifetime <= 1200);
const sockets = new Set(); let echoed = 0, rejected = 0, stopping = false;
const server = net.createServer(socket => {
  if (socket.remoteAddress !== peer || sockets.size >= 4) { rejected++; socket.destroy(); return; }
  sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
  socket.setTimeout(2000, () => socket.destroy());
  socket.once('data', bytes => {
    if (bytes.length > 256) { rejected++; socket.destroy(); return; }
    echoed++; socket.end(bytes); console.log(JSON.stringify({echoed, bytes: bytes.length}));
  });
});
function stop() {
  if (stopping) return; stopping = true; clearTimeout(deadline);
  for (const socket of sockets) socket.destroy();
  server.close(() => console.log(JSON.stringify({closed: true, echoed, rejected})));
}
const deadline = setTimeout(stop, lifetime * 1000);
server.on('error', () => { clearTimeout(deadline); console.error('NETWORK_FIXTURE_LISTEN_FAILED'); process.exitCode = 1; });
server.listen(0, address, () => console.log(JSON.stringify({ready: true, port: server.address().port, pid: process.pid, diagnosticOnly: true})));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
