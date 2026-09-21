// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Actual macOS Seatbelt/syscall acceptance. All inputs are disposable fake canaries.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, chmod, realpath, symlink, unlink, copyFile, utimes, stat} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomBytes} from 'node:crypto';
import net from 'node:net';
import {WorkerIsolation} from '../services/central-gateway/dist/worker-isolation.js';

if (process.platform !== 'darwin') throw Error('Actual macOS required; no fixture fallback');
if (!process.env.HARNESS_QA_ROOT) throw Error('HARNESS_QA_ROOT must name the approved isolated QA directory');
const parent = await realpath(resolve(process.env.HARNESS_QA_ROOT));
const root = await mkdtemp(join(parent, 'worker-isolation-'));
await chmod(root, 0o700);
const workers = join(root, 'workers'), trusted = join(root, 'trusted');
await mkdir(workers, {mode:0o700}); await mkdir(trusted, {mode:0o700});
const binary = join(trusted, 'isolation-probe');
const source = join(dirname(fileURLToPath(import.meta.url)), 'worker-isolation-probe.c');
const checks = [], listeners = [], sockets = new Set(), children = new Set();
const token = randomBytes(32).toString('base64url'); // Fake broker token, never a provider credential.
let failure;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {checks.push({name, passed:true}); console.log(`PASS ${name}`);}, error => {
    checks.push({name, passed:false, error:String(error.message)}); throw error;
  });
}
async function listen(address = 0) {
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.end(); });
  await new Promise((res, rej) => {server.once('error', rej); typeof address === 'number' ? server.listen(address, '127.0.0.1', res) : server.listen(address, res);});
  listeners.push(server); return server;
}
async function run(command, args, options, operations) {
  const child = spawn(command, args, {...options, stdio:['pipe', 'pipe', 'pipe']}); children.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const done = new Promise((res, rej) => {child.once('error', rej); child.once('close', (code, signal) => code === 0 ? res() : rej(Error(`Probe exited ${code}/${signal}: ${stderr.slice(-2000)}`)));});
  child.stdin.end(operations.map(row => row.join('\t')).join('\n') + '\n');
  try { await done; } finally {clearTimeout(timer); children.delete(child);}
  const rows = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(rows.length, operations.length, 'Probe must acknowledge every syscall');
  assert.equal(new Set(rows.map(row => row.id)).size, operations.length);
  return new Map(rows.map(row => [row.id, row]));
}
function denied(row) {assert.equal(row.rc, -1); assert.ok([1,13].includes(row.error), `Expected EPERM/EACCES, got ${JSON.stringify(row)}`);}
async function reject(name, fn, pattern) { await check(name, async () => assert.rejects(async () => {await fn();}, pattern)); }

try {
  await check('compile actual syscall probe', async () => {
    const compiled = spawnSync('/usr/bin/clang', ['-Wall', '-Wextra', '-Werror', '-O2', source, '-o', binary], {encoding:'utf8'});
    assert.equal(compiled.status, 0, compiled.stderr); await chmod(binary, 0o500);
  });
  const hash = createHash('sha256').update(await readFile(binary)).digest('hex');
  const isolation = new WorkerIsolation(workers, binary, hash);
  const allowed = await listen(), blocked = await listen();
  const url = `http://127.0.0.1:${allowed.address().port}/`;
  const unixPath = join(root, 'qa.sock');
  assert.ok(Buffer.byteLength(unixPath) < 104, 'QA root too long for macOS Unix socket');
  await listen(unixPath);
  const users = [];
  for (const name of ['alice', 'bob']) {
    const base = join(workers, name), home = join(base, 'home'), directory = join(base, 'runtime');
    await mkdir(base, {mode:0o700}); await mkdir(home, {mode:0o700}); await mkdir(directory, {mode:0o700});
    for (const file of ['sentinel', 'private-config.toml', 'credential-canary.json']) await writeFile(join(home, file), 'QA canary only\n', {mode:0o600});
    users.push({home, directory, name});
  }
  const gatewaySecret = join(root, 'gateway-canary.json'); await writeFile(gatewaySecret, 'QA fake secret\n', {mode:0o600});
  const poisoned = {OPENAI_API_KEY:'qa-fake', ANTHROPIC_API_KEY:'qa-fake', SSH_AUTH_SOCK:unixPath, HTTP_PROXY:'http://127.0.0.1:1', HTTPS_PROXY:'http://127.0.0.1:1', ALL_PROXY:'http://127.0.0.1:1', DYLD_INSERT_LIBRARIES:'/qa-fake', DYLD_LIBRARY_PATH:'/qa-fake', NODE_OPTIONS:'--qa-fake', CODEX_HOME:'/qa-fake'};
  for (const [index, user] of users.entries()) {
    const other = users[1-index], linkPath = join(user.home, 'cross-user-link');
    await symlink(join(other.home, 'sentinel'), linkPath);
    const saved = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
    let launch;
    try {Object.assign(process.env, poisoned); launch = await isolation.launch(user, url, token);}
    finally {for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;}
    const operations = [
      ['own-read', 'read', join(user.home, 'sentinel')], ['own-write', 'write', join(user.home, 'sentinel')], ['runtime-write', 'write', join(user.directory, 'result-canary')],
      ...['sentinel','private-config.toml','credential-canary.json'].flatMap((file, i) => [[`other-read-${i}`, 'read', join(other.home, file)], [`other-write-${i}`, 'write', join(other.home, file)]]),
      ['gateway-read', 'read', gatewaySecret], ['gateway-write', 'write', gatewaySecret], ['symlink-read', 'read', linkPath], ['symlink-write', 'write', linkPath],
      ['hardlink', 'link', join(other.home, 'sentinel'), join(user.home, 'cross-hardlink')], ['exec', 'exec', '/usr/bin/true'],
      ['mach', 'mach', 'com.apple.SecurityServer'], ['broker', 'tcp', String(allowed.address().port)], ['other-tcp', 'tcp', String(blocked.address().port)], ['unix', 'unix', unixPath],
      ...Object.keys(poisoned).filter(key => key !== 'CODEX_HOME').map((key, i) => [`env-${i}`, 'env', key]),
    ];
    // Baseline proves the same UID can access canaries/listeners without Seatbelt.
    const baselineOps = operations.filter(row => ['other-read-0','gateway-read','broker','other-tcp','unix','exec','mach'].includes(row[0]));
    const baseline = await run(binary, [], {cwd:user.directory, env:{PATH:'/usr/bin:/bin'}}, baselineOps);
    await check(`${user.name}: unsandboxed controls reach files, listeners and executable`, () => {
      for (const [id, row] of baseline) if (id !== 'mach') assert.ok(row.rc >= 0, `${id}: ${JSON.stringify(row)}`);
    });
    const result = await run(launch.command, launch.args, {cwd:launch.cwd, env:launch.env}, operations);
    await check(`${user.name}: own home/runtime read-write succeeds`, () => {for (const id of ['own-read','own-write','runtime-write']) assert.ok(result.get(id).rc > 0);});
    await check(`${user.name}: other user sentinel/config/fake credential read-write denied`, () => {for (let i=0;i<3;i++) {denied(result.get(`other-read-${i}`)); denied(result.get(`other-write-${i}`));}});
    await check(`${user.name}: gateway fake secret read-write denied`, () => {denied(result.get('gateway-read')); denied(result.get('gateway-write'));});
    await check(`${user.name}: symlink traversal and cross-user hardlink denied`, () => {for (const id of ['symlink-read','symlink-write','hardlink']) denied(result.get(id));});
    await check(`${user.name}: arbitrary process execution denied`, () => denied(result.get('exec')));
    await check(`${user.name}: SecurityServer Mach lookup denied`, () => {assert.equal(baseline.get('mach').rc, 0, 'SecurityServer baseline must exist to prove sandbox denial'); assert.equal(result.get('mach').rc, -1);});
    await check(`${user.name}: broker TCP allowed and other TCP/Unix socket denied`, () => {assert.equal(result.get('broker').rc, 0); denied(result.get('other-tcp')); denied(result.get('unix'));});
    await check(`${user.name}: inherited credential/SSH/proxy/DYLD env stripped`, () => {
      for (const key of Object.keys(poisoned).filter(key => key !== 'CODEX_HOME')) assert.equal(launch.env[key], undefined);
      for (const [id, row] of result) if (id.startsWith('env-')) assert.equal(row.rc, -1);
      assert.equal(launch.env.CODEX_HOME, user.home);
    });
  }
  await check('cross-user and gateway canaries unchanged', async () => {
    assert.equal(await readFile(gatewaySecret, 'utf8'), 'QA fake secret\n');
    for (const user of users) for (const file of ['private-config.toml','credential-canary.json']) assert.equal(await readFile(join(user.home,file),'utf8'), 'QA canary only\n');
  });
  const user = users[0];
  await reject('launch refuses paths outside worker root', () => isolation.launch({home:join(root,'home'), directory:join(root,'runtime')}, url, token), /WORKER_PATH_UNSAFE/);
  await chmod(user.home, 0o755);
  try {await reject('launch refuses permissive user directory', () => isolation.launch(user,url,token), /WORKER_PATH_PERMISSIONS/);} finally {await chmod(user.home,0o700);}
  const alias = join(workers,'alias'); await symlink(dirname(user.home),alias);
  await reject('launch refuses symlinked user base', () => isolation.launch({home:join(alias,'home'),directory:join(alias,'runtime')},url,token), /WORKER_PATH_UNSAFE/);
  await symlink(gatewaySecret, join(user.home,'auth.json'));
  try {await reject('launch refuses old shared auth symlink', () => isolation.launch(user,url,token), /WORKER_CREDENTIAL_MIGRATION_REQUIRED/);} finally {await unlink(join(user.home,'auth.json'));}
  await writeFile(join(user.home,'config.toml'),'model_provider = "old-shared"\n',{mode:0o600});
  await reject('launch refuses unmanaged previous configuration', () => isolation.launch(user,url,token), /WORKER_CONFIG_MIGRATION_REQUIRED/);
  await reject('constructor rejects mismatched binary hash', () => new WorkerIsolation(workers,binary,'0'.repeat(64)), /WORKER_BINARY_HASH_MISMATCH/);
  await chmod(binary,0o520);
  try {await reject('constructor rejects group-writable trusted binary', () => new WorkerIsolation(workers,binary,hash), /WORKER_PATH_PERMISSIONS/);} finally {await chmod(binary,0o500);}
  const changed = join(trusted,'changed-probe'); await copyFile(binary,changed); await chmod(changed,0o500);
  const changedIsolation = new WorkerIsolation(workers,changed,hash), before = await stat(changed);
  await utimes(changed,before.atime,new Date(before.mtimeMs + 2000));
  await reject('launch refuses changed trusted artifact without fallback', () => changedIsolation.launch(users[1],url,token), /WORKER_LAUNCHER_CHANGED/);
} catch (error) {failure = error; console.error(error.stack ?? error);}
finally {
  for (const child of children) child.kill('SIGKILL');
  for (const socket of sockets) socket.destroy();
  await Promise.all(listeners.map(server => new Promise(resolveClose => server.close(resolveClose))));
  const report = {at:new Date().toISOString(), platform:process.platform, root, scope:'Actual macOS Seatbelt syscall tests with disposable canaries; no model credentials read', passed:!failure, checks, error:failure?.message};
  await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(`Evidence: ${join(root,'result.json')}`);
}
if (failure) process.exitCode = 1;
