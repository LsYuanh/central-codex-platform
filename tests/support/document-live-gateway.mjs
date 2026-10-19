// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Explicit Mac QA service. Never points at a production state/auth directory.
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync, readFileSync, chmodSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {randomBytes, createHash} from 'node:crypto';
import {spawnSync, spawn} from 'node:child_process';
import {PlatformAuth} from '../../services/central-gateway/dist/platform-auth.js';

assert.equal(process.platform, 'darwin');
const {QA_LIVE_ROOT, QA_APP_SERVER, QA_MODEL_CREDENTIAL} = process.env;
assert(QA_LIVE_ROOT && QA_APP_SERVER && QA_MODEL_CREDENTIAL, 'Provide new QA root, existing verified App Server and private login file');
const root = resolve(QA_LIVE_ROOT), binary = resolve(QA_APP_SERVER);
// Refuse to reuse a state directory, even after a previous failed run.
mkdirSync(root, {mode:0o700});
const save = (name, content) => writeFileSync(join(root, name), content, {mode:0o600});
const openssl = args => {
  const result = spawnSync('/usr/bin/openssl', args, {cwd:root, stdio:'pipe'});
  assert.equal(result.status, 0, 'QA_TLS_SETUP_FAILED');
};
save('ca.cnf', '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Yuanzhou Document QA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
openssl(['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout','ca-key.pem','-out','ca.pem','-config','ca.cnf']);
openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout','server-key.pem','-out','server.csr','-subj','/CN=localhost']);
save('leaf.cnf', 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
openssl(['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca-key.pem','-set_serial','1','-days','2','-out','server.pem','-extfile','leaf.cnf']);
const auth = new PlatformAuth(join(root,'auth.json'), undefined, undefined, 'device-token-v1');
const password = randomBytes(32).toString('hex');
const user = await auth.createUser('documentqa', password, 'admin'); auth.close();
save('handoff.json', JSON.stringify({username:'documentqa', password, userId:user.id}));
// Broker reads the existing private login; QA does not copy, refresh or print it.
save('bindings.json', JSON.stringify({version:1, users:{[user.id]:{providerId:'qa', enabled:true}}, providers:{qa:{id:'qa', kind:'chatgpt', credentialFile:resolve(QA_MODEL_CREDENTIAL)}}}));
for (const name of ['auth.json','server-key.pem','ca-key.pem']) chmodSync(join(root,name), 0o600);
const hash = createHash('sha256').update(readFileSync(binary)).digest('hex');
save('runtime.json', JSON.stringify({sha256:hash, platform:process.platform, arch:process.arch, node:process.version}));
const child = spawn(process.execPath, [resolve('services/central-gateway/dist/index.js')], {stdio:['ignore','inherit','inherit'], env:{...process.env,
  TEST_GATEWAY_HOST:'127.0.0.1', TEST_GATEWAY_PORT:'4618', TEST_GATEWAY_STATE_FILE:join(root,'state.json'),
  PLATFORM_AUTH_FILE:join(root,'auth.json'), PLATFORM_TLS_CERT:join(root,'server.pem'), PLATFORM_TLS_KEY:join(root,'server-key.pem'),
  PLATFORM_WORKER_ROOT:join(root,'workers'), PLATFORM_MODEL_BINDINGS:join(root,'bindings.json'),
  PLATFORM_WORKER_BINARY:binary, PLATFORM_WORKER_BINARY_SHA256:hash, PLATFORM_WORKER_MODEL:'gpt-6.1-sol', PLATFORM_USER_TURNS:'1',
}});
save('gateway.pid', String(child.pid)); save('launcher.pid', String(process.pid));
process.on('SIGTERM', () => child.kill()); process.on('SIGINT', () => child.kill());
child.on('exit', code => process.exit(code ?? 1));
