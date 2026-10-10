// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {qaRoot, qaAuthFile, qaHost} from '../scripts/maintenance/operator-config.mjs';
// Fixed fourth-batch 4529 QA. CA key stays on the central Mac; model login is read in place.
import { mkdirSync, existsSync, writeFileSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash, randomBytes, X509Certificate, createPrivateKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const qa = qaRoot();
const rc = process.argv.includes('--rc');
const tokenQa = process.argv.includes('--token');
assert(!(rc && tokenQa));
const directory = join(qa, tokenQa ? 'p5-token-security' : rc ? 'p5-rc-security' : 'p5-mtls-security'), workerRoot = join(qa, tokenQa ? 'live-data/token-workers' : rc ? 'live-data/rc-workers' : 'live-data/mtls-workers');
assert.equal(process.platform, 'darwin', 'Run on the central Mac only');
assert.equal(realpathSync(qa), qa);
assert(!existsSync(directory), 'Preserve existing mTLS QA identities and CA');
assert(!existsSync(workerRoot), 'Preserve existing mTLS QA Workers');
let raw = '';
for await (const chunk of process.stdin) { raw += chunk; assert(raw.length <= 8192); }
const input = JSON.parse(raw);
assert(typeof input.password === 'string' && input.password.length >= 12 && input.password.length <= 256);
const credential = qaAuthFile(), stat = lstatSync(credential);
assert.equal(realpathSync(credential), credential);
assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
const gatewaySource = tokenQa ? '/rc-client-source' : '/gateway';
const { PlatformAuth } = await import(qa + gatewaySource + '/services/central-gateway/dist/platform-auth.js');
const { createDeviceCertificateAuthority, DeviceCertificates } = await import(qa + gatewaySource + '/services/central-gateway/dist/device-certificates.js');
mkdirSync(directory, { mode: 0o700 });
mkdirSync(workerRoot, { mode: 0o700 });
assert.equal(realpathSync(directory), directory);
assert.equal(realpathSync(workerRoot), workerRoot);
const auth = new PlatformAuth(join(directory, 'auth.json')), users = [];
try {
  // Dedicated QA server trust. The server leaf is CA:FALSE, as required by
  // rustls; neither the historic QA certificate nor the device CA is reused.
  const caConfig = join(directory, 'server-ca.cnf'), leafConfig = join(directory, 'server-leaf.cnf');
  writeFileSync(caConfig, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3_ca\n[dn]\nCN=Yuan Zhou Fourth Batch QA Server CA\n[v3_ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(leafConfig, `[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${qaHost()}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`, { flag: 'wx', mode: 0o600 });
  const serverCa = join(directory, 'server-ca.pem'), serverCaKey = join(directory, 'server-ca-key.pem');
  const serverCert = join(directory, 'server.pem'), serverKey = join(directory, 'server-key.pem'), serverCsr = join(directory, 'server.csr');
  const originalMask = process.umask(0o077);
  const openssl = args => { try { execFileSync('/usr/bin/openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { throw Error('MTLS_QA_SERVER_CERT_GENERATION_FAILED'); } };
  try {
    openssl(['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30', '-keyout', serverCaKey, '-out', serverCa, '-config', caConfig, '-extensions', 'v3_ca']);
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', serverKey, '-out', serverCsr, '-subj', `/CN=${qaHost()}`]);
    openssl(['x509', '-req', '-in', serverCsr, '-CA', serverCa, '-CAkey', serverCaKey, '-set_serial', '0x01' + randomBytes(19).toString('hex'), '-sha256', '-days', '30', '-extfile', leafConfig, '-extensions', 'server', '-out', serverCert]);
  } finally { process.umask(originalMask); }
  for (const file of [serverCa, serverCaKey, serverCert, serverKey, serverCsr]) { const entry = lstatSync(file); assert(entry.isFile() && entry.nlink === 1 && entry.uid === process.getuid() && (entry.mode & 0o077) === 0); }
  const serverAuthority = new X509Certificate(readFileSync(serverCa)), serverLeaf = new X509Certificate(readFileSync(serverCert));
  assert(serverAuthority.ca && !serverLeaf.ca && serverLeaf.verify(serverAuthority.publicKey));
  assert.equal(serverLeaf.checkIP(qaHost()), qaHost());
  assert.deepEqual(serverLeaf.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert(serverLeaf.checkPrivateKey(createPrivateKey(readFileSync(serverKey))));
  if (!tokenQa) {
  const authority = await createDeviceCertificateAuthority({ directory: join(directory, 'device-ca'), certificateLifetimeSeconds: 120, renewBeforeSeconds: 60 });
  await DeviceCertificates.load({ configFile: authority.configFile, forbiddenRoots: [workerRoot] });
  }
  for (const username of (tokenQa ? ['tokenadmin', 'tokenuser'] : rc ? ['rcmac', 'rcwindows'] : ['mtlsalice', 'mtlsbob'])) {
    const user = await auth.createUser(username, input.password, ['mtlsalice','rcmac','tokenadmin'].includes(username) ? 'admin' : 'user');
    users.push(user);
    const base = join(workerRoot, createHash('sha256').update(user.id).digest('hex'));
    mkdirSync(base, { mode: 0o700 });
    mkdirSync(join(base, 'home'), { mode: 0o700 });
    mkdirSync(join(base, 'runtime'), { mode: 0o700 });
  }
  const models = {
    version: 1,
    users: Object.fromEntries(users.map(user => [user.id, { providerId: 'central-readonly-mtls-qa', enabled: true }])),
    providers: { 'central-readonly-mtls-qa': { id: 'central-readonly-mtls-qa', kind: 'chatgpt', credentialFile: credential, baseUrl: 'https://chatgpt.com/backend-api/codex' } },
  };
  writeFileSync(join(directory, 'models.json'), JSON.stringify(models, null, 2), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'public-users.json'), JSON.stringify(users, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ok: true, accounts: users.length, rc, tokenQa, port: 4529, certificateLifetimeSeconds: tokenQa ? null : 120, renewBeforeSeconds: tokenQa ? null : 60, deviceAuthentication: tokenQa ? 'device-token-v1' : 'legacy-mtls-v1', caKeyHandling: tokenQa ? 'no device CA; server TLS keys retained centrally' : 'generated and retained only in the central private CA directory', credentialHandling: 'central broker reads existing login in place; no copy, refresh, revoke or Worker auth link' }));
} finally { auth.close(); }
