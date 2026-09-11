import assert from 'node:assert/strict';
import { X509Certificate, generateKeyPairSync, webcrypto, createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, linkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { TLSSocket } from 'node:tls';
import { createRequire } from 'node:module';
import { createDeviceCertificateAuthority, DeviceCertificates } from '../services/test-gateway/dist/device-certificates.js';
const require = createRequire(new URL('../services/test-gateway/package.json', import.meta.url));
const { X509CertificateGenerator, BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsagesExtension, KeyUsageFlags } = require('@peculiar/x509');
const dir = mkdtempSync(join(tmpdir(), 'device-certificates-'));
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS ' + name); };
const fixture = process.platform === 'win32';
const setup = await createDeviceCertificateAuthority({ directory: join(dir, 'ca'), protocolFixture: fixture });
const authority = await DeviceCertificates.load({ configFile: setup.configFile, protocolFixture: fixture, forbiddenRoots: [join(dir, 'workers')] });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = rsa.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const device = await authority.issue({ deviceId: 'device-a', userId: 'user-a', tlsPublicKey: publicKey });
const fakeRequest = (pem, overrides = {}) => {
  const socket = Object.create(TLSSocket.prototype);
  Object.assign(socket, { encrypted: true, authorized: true, isSessionReused: () => false, getPeerX509Certificate: () => pem ? new X509Certificate(pem) : undefined, ...overrides });
  return { socket };
};
try {
  await check('RSA2048 certificate is client-only, non-CA and key bound', () => { const cert = new X509Certificate(device.pem); assert.equal(cert.ca, false); assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.2']); assert(cert.checkPrivateKey(rsa.privateKey)); assert.equal(authority.validateTLS(fakeRequest(device.pem)).fingerprint, device.fingerprint); assert(device.expiresAt - Date.now() <= 7 * 86400_000); assert.equal(device.expiresAt - device.renewAfter, 86400_000); });
  await check('Reissuance has a distinct random serial and fingerprint', async () => { const next = await authority.issue({ deviceId: 'device-a', userId: 'user-a', tlsPublicKey: publicKey }); assert.notEqual(next.fingerprint, device.fingerprint); });
  await check('P256 SPKI accepted', async () => { const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const cert = await authority.issue({ deviceId: 'device-b', userId: 'user-b', tlsPublicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }); assert(new X509Certificate(cert.pem).checkPrivateKey(pair.privateKey)); });
  await check('Weak RSA and unsupported curve rejected', async () => { for (const pair of [generateKeyPairSync('rsa', { modulusLength: 1024 }), generateKeyPairSync('ec', { namedCurve: 'secp384r1' })]) await assert.rejects(authority.issue({ deviceId: 'device-a', userId: 'user-a', tlsPublicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }), /DEVICE_CERTIFICATE_KEY_INVALID/); });
  await check('Malformed key and DN injection rejected', async () => { await assert.rejects(authority.issue({ deviceId: 'a,CN=injected', userId: 'user-a', tlsPublicKey: publicKey }), /DEVICE_CERTIFICATE_KEY_INVALID/); await assert.rejects(authority.issue({ deviceId: 'a', userId: 'user-a', tlsPublicKey: 'AAAA' }), /DEVICE_CERTIFICATE_KEY_INVALID/); });
  await check('No certificate, unauthorized TLS, plaintext and reused sessions rejected', () => { for (const request of [fakeRequest(), fakeRequest(device.pem, { authorized: false }), fakeRequest(device.pem, { isSessionReused: () => true }), { socket: {} }]) assert.throws(() => authority.validateTLS(request), /DEVICE_CERTIFICATE_REQUIRED/); });
  await check('CA certificate rejected as Agent identity', () => assert.throws(() => authority.validateTLS(fakeRequest(setup.caPem)), /DEVICE_CERTIFICATE_INVALID/));
  await check('Foreign CA certificate rejected even with claimed authorized socket', async () => { const other = await createDeviceCertificateAuthority({ directory: join(dir, 'other'), protocolFixture: fixture }); const foreign = await DeviceCertificates.load({ configFile: other.configFile, protocolFixture: fixture }); const cert = await foreign.issue({ deviceId: 'device-a', userId: 'user-a', tlsPublicKey: publicKey }); assert.throws(() => authority.validateTLS(fakeRequest(cert.pem)), /DEVICE_CERTIFICATE_INVALID/); });
  await check('Expired and not-yet-valid device certificate rejected', () => { const original = Date.now; try { Date.now = () => device.expiresAt + 1; assert.throws(() => authority.validateTLS(fakeRequest(device.pem)), /DEVICE_CERTIFICATE_EXPIRED/); assert.throws(() => authority.validateTLS(fakeRequest(device.pem, { authorized: false })), /DEVICE_CERTIFICATE_EXPIRED/); Date.now = () => device.expiresAt - 8 * 86400_000; assert.throws(() => authority.validateTLS(fakeRequest(device.pem)), /DEVICE_CERTIFICATE_EXPIRED/); } finally { Date.now = original; } });
  await check('CA startup refuses expired authority', async () => { const original = Date.now; try { Date.now = () => original() + 366 * 86400_000; await assert.rejects(DeviceCertificates.load({ configFile: setup.configFile, protocolFixture: fixture }), /DEVICE_CA_INVALID/); } finally { Date.now = original; } });
  await check('Worker-root CA and hard-linked key rejected', async () => { await assert.rejects(DeviceCertificates.load({ configFile: setup.configFile, protocolFixture: fixture, forbiddenRoots: [join(dir, 'ca')] }), /DEVICE_CA_WORKER_PATH_DENIED/); const config = JSON.parse(readFileSync(setup.configFile)); linkSync(config.caPrivateKeyFile, join(dir, 'key-link')); await assert.rejects(DeviceCertificates.load({ configFile: setup.configFile, protocolFixture: fixture }), /DEVICE_CA_FILE_UNSAFE/); });
  if (!fixture) await check('Unix public-readable CA config rejected', async () => { const other = await createDeviceCertificateAuthority({ directory: join(dir, 'permissions') }); chmodSync(other.configFile, 0o644); await assert.rejects(DeviceCertificates.load({ configFile: other.configFile }), /DEVICE_CA_FILE_UNSAFE/); });
  await check('CA initialization never overwrites existing directory', async () => assert.rejects(createDeviceCertificateAuthority({ directory: join(dir, 'ca'), protocolFixture: fixture }), /EEXIST/));
  await check('Short lifetime configuration rejects invalid renewal window', async () => { const bad = join(dir, 'bad-config.json'); writeFileSync(bad, JSON.stringify({ ...JSON.parse(readFileSync(setup.configFile)), certificateLifetimeSeconds: 60, renewBeforeSeconds: 60 }), { mode: 0o600 }); await assert.rejects(DeviceCertificates.load({ configFile: bad, protocolFixture: fixture }), /DEVICE_CA_CONFIG_INVALID/); });
  await check('Real TLS admits owned client certificate and denies absent or foreign identity', async () => {
    const serverKeys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const serverCert = await X509CertificateGenerator.createSelfSigned({ serialNumber: '01', name: 'CN=localhost', keys: serverKeys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 3600_000), extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true), new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true)] }, webcrypto);
    const key = createPrivateKey({ key: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', serverKeys.privateKey)), format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' });
    const server = https.createServer({ key, cert: serverCert.toString('pem'), ca: setup.caPem, requestCert: true, rejectUnauthorized: false }, (req, res) => { try { authority.validateTLS(req); res.end('ok'); } catch (error) { res.writeHead(401); res.end(error.message); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const request = (cert, privateKey) => new Promise((resolve, reject) => { const req = https.get({ hostname: '127.0.0.1', port: server.address().port, servername: 'localhost', ca: serverCert.toString('pem'), agent: false, cert, key: privateKey }, res => { let body = ''; res.on('data', data => body += data); res.once('end', () => resolve({ status: res.statusCode, body })); }); req.once('error', reject); });
    try {
      const privateKey = rsa.privateKey.export({ format: 'pem', type: 'pkcs8' });
      assert.equal((await request(device.pem, privateKey)).status, 200);
      assert.equal((await request()).status, 401);
      const foreign = await DeviceCertificates.load({ configFile: join(dir, 'other', 'device-ca.json'), protocolFixture: fixture });
      const cert = await foreign.issue({ deviceId: 'a', userId: 'b', tlsPublicKey: publicKey });
      assert.equal((await request(cert.pem, privateKey)).status, 401);
      // Actual OpenSSL verification marks this peer unauthorized; the API must
      // report expiry rather than incorrectly asking for a missing certificate.
      const caKey = createPrivateKey(readFileSync(JSON.parse(readFileSync(setup.configFile)).caPrivateKeyFile));
      const signingKey = await webcrypto.subtle.importKey('pkcs8', caKey.export({ type: 'pkcs8', format: 'der' }), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const expired = await X509CertificateGenerator.create({ serialNumber: '03', subject: 'CN=expired-device', issuer: new X509Certificate(setup.caPem).subject, publicKey: rsa.publicKey.export({ format: 'der', type: 'spki' }), signingKey, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, notBefore: new Date(Date.now() - 3600_000), notAfter: new Date(Date.now() - 60_000), extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true), new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.2'], true)] }, webcrypto);
      assert.deepEqual(await request(expired.toString('pem'), privateKey), { status: 401, body: 'DEVICE_CERTIFICATE_EXPIRED' });
    }
    finally { await new Promise(resolve => server.close(resolve)); }
  });
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: true, platform: process.platform, fixtureOnly: fixture, checks }, null, 2));
  console.log('Result: ' + join(dir, 'result.json'));
} catch (error) { writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: false, platform: process.platform, checks, error: String(error) }, null, 2)); throw error; }
