// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Explicit operator acceptance. SSH issues/revokes the dedicated QA device only;
// all model, device, history and updater requests use the native relay transport.
// Private operator config belongs outside Git. Never print its contents or codes.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.platform, 'win32');
assert.equal(process.env.YUAN_RELAY_LIVE_QA, '1');
const maintenance = process.argv[3] === '--maintenance';
assert.equal(process.argv.length, maintenance ? 4 : 3);
assert(path.isAbsolute(process.argv[2]));
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (maintenance) {
  assert(path.isAbsolute(config.restartProgram));
  assert(Array.isArray(config.restartArgs) && config.restartArgs.every(v => typeof v === 'string'));
}
assert.equal(config.gateway, process.env.CENTRAL_FORMAL_GATEWAY);
assert(/^wss:\/\/[^/?#@:]+:4510\/ws$/.test(config.gateway));
assert(/^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+$/.test(config.sshTarget));
assert(path.isAbsolute(config.sshKey));
for (const field of ['remoteNode', 'remoteManagement']) {
  assert(/^\/[A-Za-z0-9_./-]+$/.test(config[field]) && !config[field].split('/').includes('..'));
}
assert(path.isAbsolute(config.accessFile));
assert(path.isAbsolute(config.centralCaFile));
assert(/^[a-f0-9]{64}$/.test(config.centralId));
const access = JSON.parse(readFileSync(config.accessFile, 'utf8'));
assert(access.url.startsWith('https://') && access.token.length >= 32 && access.caPem);
const output = path.join(root, 'target/relay-central-live', String(Date.now()));
mkdirSync(path.join(output, 'workspace'), {recursive: true});
function management(action, id) {
  assert(['pair', 'revoke', 'finish'].includes(action));
  if (id) assert(/^[a-f0-9-]{36}$/.test(id));
  const bytes = execFileSync('ssh.exe', ['-i', config.sshKey, '-o', 'BatchMode=yes', config.sshTarget,
    `${config.remoteNode} ${config.remoteManagement} ${action}${id ? ` ${id}` : ''}`],
  {windowsHide: true, timeout: 30000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe']});
  try { return JSON.parse(bytes); } finally { bytes.fill(0); }
}
let deviceId, revoked = false, child, timer;
const phases = [];
let failed = false;
try {
  const pair = management('pair');
  const code = 'yzpair1.' + Buffer.from(JSON.stringify({version: 1, gateway: config.gateway,
    caPem: readFileSync(config.centralCaFile, 'utf8'), token: pair.code,
    expiresAt: Math.min(pair.expiresAt, Date.now() + 240000), relay: {access, centralId: config.centralId}})).toString('base64url');
  pair.code = '';
  child = spawn(process.execPath, [path.join(root, maintenance
    ? 'scripts/maintenance/relay-client-maintenance-qa.mjs' : 'scripts/maintenance/central-live-client-qa.mjs'), '--formal-4510'],
    {cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  const bootstrap = Buffer.from(JSON.stringify({gateway: config.gateway, caPath: '', code,
    agentBinary: path.join(root, 'target/debug/local-agent.exe'),
    helperBinary: path.join(root, 'target/debug/examples/central-live-client.exe'),
    workspace: path.join(output, 'workspace'), output: path.join(output, 'client-result.json'),
    model: config.model ?? 'gpt-6.1-sol', permissionMode: 'auto', updatePreflight: true}) + '\n');
  child.stdin.on('error', () => { failed = true; });
  child.stdin.write(bootstrap, () => bootstrap.fill(0));
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const value = JSON.parse(line); phases.push(value);
        if (value.deviceId) deviceId = value.deviceId;
        if (value.phase === 'restart-relay') {
          // Operator supplied argv, never shell interpolation. The operation must
          // return only after the owned relay is healthy; business services stay up.
          execFileSync(config.restartProgram, config.restartArgs,
            {windowsHide: true, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe']});
          child.stdin.write('{"restarted":true}\n');
        }
        if (value.phase === 'completed') { management('revoke', deviceId); revoked = true; }
        if (value.phase === 'failed') failed = true;
        console.log(JSON.stringify(value));
      } catch { failed = true; child.stdin.end(); }
    }
  });
  child.stderr.on('data', () => {});
  timer = setTimeout(() => child.stdin.end(), maintenance ? 900000 : 350000);
  const status = await new Promise(resolve => {
    child.once('error', () => resolve(null)); child.once('close', resolve);
  });
  assert.equal(status, 0); assert(!failed && deviceId && revoked);
  const result = JSON.parse(readFileSync(path.join(output, 'client-result.json'), 'utf8'));
  assert.equal(result.passed, true);
  writeFileSync(path.join(output, 'relay-result.json'), JSON.stringify({passed: true,
    relayOnly: true, publicRelay: new URL(access.url).hostname, ...result}, null, 2));
  console.log(JSON.stringify({passed: true, relayOnly: true, output}));
} catch {
  failed = true;
  console.log(JSON.stringify({passed: false, code: 'RELAY_LIVE_QA_FAILED', output}));
} finally {
  clearTimeout(timer);
  if (deviceId && !revoked) { try { management('revoke', deviceId); revoked = true; } catch {} }
  try { management('finish'); } catch { failed = true; }
  child?.stdin.end();
  access.token = '';
  writeFileSync(path.join(output, 'controller-result.json'), JSON.stringify({passed: !failed,
    deviceId, revoked, phases}, null, 2));
  process.exitCode = failed ? 1 : 0;
}
