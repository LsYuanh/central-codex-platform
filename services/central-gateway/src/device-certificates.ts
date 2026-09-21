import "reflect-metadata";
import { X509Certificate, createPrivateKey, createPublicKey, randomBytes, webcrypto } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TLSSocket } from "node:tls";
import type { IncomingMessage } from "node:http";
import { AuthorityKeyIdentifierExtension, BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension, SubjectKeyIdentifierExtension, X509CertificateGenerator } from "@peculiar/x509";

const crypto = webcrypto as unknown as Crypto;
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const clientAuth = "1.3.6.1.5.5.7.3.2";
const fail = (code: string): never => { throw Error(code); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const serial = () => `01${randomBytes(19).toString("hex")}`;
const fingerprint = (cert: X509Certificate) => cert.fingerprint256.replaceAll(":", "").toLowerCase();
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel); };
function canonicalCandidate(path: string): string {
  let current = resolve(path); const suffix: string[] = [];
  for (;;) { try { return join(realpathSync(current), ...suffix); } catch (e) {
    if (!object(e) || e.code !== "ENOENT") return fail("DEVICE_CA_FILE_UNSAFE");
    const parent = dirname(current); if (parent === current) return fail("DEVICE_CA_FILE_UNSAFE");
    suffix.unshift(basename(current)); current = parent;
  } }
}
function privateFile(path: string, forbiddenRoots: string[]): Buffer {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) return fail("DEVICE_CA_FILE_UNSAFE");
    const parent = statSync(dirname(path));
    if (!parent.isDirectory() || process.platform !== "win32" && (parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0)) return fail("DEVICE_CA_FILE_UNSAFE");
    for (const root of forbiddenRoots) {
      if (!isAbsolute(root)) return fail("DEVICE_CA_CONFIG_INVALID");
      if (inside(resolve(root), resolve(path)) || inside(canonicalCandidate(root), realpathSync(path))) return fail("DEVICE_CA_WORKER_PATH_DENIED");
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 64 * 1024 || process.platform !== "win32" && (before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0)) return fail("DEVICE_CA_FILE_UNSAFE");
    const data = readFileSync(fd), after = fstatSync(fd);
    if (data.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return fail("DEVICE_CA_FILE_UNSAFE");
    return data;
  } catch (e) { if (e instanceof Error && e.message.startsWith("DEVICE_CA_")) throw e; return fail("DEVICE_CA_FILE_UNSAFE"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export interface DeviceCertificateOptions { configFile: string; forbiddenRoots?: string[]; protocolFixture?: boolean; }
export interface IssuedDeviceCertificate { pem: string; expiresAt: number; renewAfter: number; fingerprint: string; }

/** Device trust is separate from the HTTPS server CA and from model credentials. */
export class DeviceCertificates {
  private constructor(readonly caPem: string, private readonly ca: X509Certificate, private readonly key: CryptoKey, private readonly lifetimeMs: number, private readonly renewBeforeMs: number) {}
  static async load(options: DeviceCertificateOptions): Promise<DeviceCertificates> {
    if (process.platform === "win32" && !options.protocolFixture) return fail("DEVICE_CA_UNSUPPORTED_OS");
    const roots = options.forbiddenRoots ?? [];
    let config: unknown;
    try { config = JSON.parse(privateFile(options.configFile, roots).toString("utf8")); } catch (e) { if (e instanceof Error && e.message.startsWith("DEVICE_CA_")) throw e; return fail("DEVICE_CA_CONFIG_INVALID"); }
    if (!object(config) || config.version !== 1 || typeof config.caCertificateFile !== "string" || typeof config.caPrivateKeyFile !== "string") return fail("DEVICE_CA_CONFIG_INVALID");
    const lifetime = config.certificateLifetimeSeconds ?? 7 * 86400, renew = config.renewBeforeSeconds ?? 86400;
    // Short lifetimes only make admission stricter and support expiry acceptance tests.
    if (!Number.isInteger(lifetime) || Number(lifetime) < 60 || Number(lifetime) > 7 * 86400 || !Number.isInteger(renew) || Number(renew) < 10 || Number(renew) >= Number(lifetime)) return fail("DEVICE_CA_CONFIG_INVALID");
    const caPem = privateFile(config.caCertificateFile, roots).toString("utf8"), keyPem = privateFile(config.caPrivateKeyFile, roots);
    try {
      const ca = new X509Certificate(caPem), privateKey = createPrivateKey(keyPem);
      if (!ca.ca || !ca.verify(ca.publicKey) || !ca.checkPrivateKey(privateKey) || Date.parse(ca.validFrom) > Date.now() || Date.parse(ca.validTo) <= Date.now() + Number(lifetime) * 1000) return fail("DEVICE_CA_INVALID");
      if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") return fail("DEVICE_CA_INVALID");
      const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
      try {
        const key = await crypto.subtle.importKey("pkcs8", new Uint8Array(pkcs8), algorithm, false, ["sign"]);
        return new DeviceCertificates(caPem, ca, key, Number(lifetime) * 1000, Number(renew) * 1000);
      } finally { pkcs8.fill(0); }
    } catch (e) { if (e instanceof Error && e.message.startsWith("DEVICE_CA_")) throw e; return fail("DEVICE_CA_INVALID"); }
    finally { keyPem.fill(0); }
  }
  async issue(input: { deviceId: string; userId: string; tlsPublicKey: string }): Promise<IssuedDeviceCertificate> {
    if (![input.deviceId, input.userId].every(v => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v)) || typeof input.tlsPublicKey !== "string" || input.tlsPublicKey.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.tlsPublicKey)) return fail("DEVICE_CERTIFICATE_KEY_INVALID");
    let publicKey: CryptoKey;
    try {
      const bytes = Buffer.from(input.tlsPublicKey, "base64");
      if (bytes.toString("base64") !== input.tlsPublicKey) return fail("DEVICE_CERTIFICATE_KEY_INVALID");
      const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
      const alg = key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails?.modulusLength === 2048 && key.asymmetricKeyDetails.publicExponent === 65537n
        ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
        : key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? algorithm : undefined;
      if (!alg) return fail("DEVICE_CERTIFICATE_KEY_INVALID");
      publicKey = await crypto.subtle.importKey("spki", new Uint8Array(bytes), alg, true, ["verify"]);
    } catch { return fail("DEVICE_CERTIFICATE_KEY_INVALID"); }
    const now = Math.floor(Date.now() / 1000) * 1000, expiresAt = now + this.lifetimeMs;
    if (Date.parse(this.ca.validTo) <= expiresAt) return fail("DEVICE_CA_EXPIRED");
    try {
    const cert = await X509CertificateGenerator.create({
      serialNumber: serial(), subject: `CN=${input.deviceId},OU=${input.userId}`, issuer: this.ca.subject,
      notBefore: new Date(now - 30_000), notAfter: new Date(expiresAt), publicKey, signingKey: this.key, signingAlgorithm: algorithm,
      extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true), new ExtendedKeyUsageExtension([clientAuth], true), await SubjectKeyIdentifierExtension.create(publicKey, false, crypto), await AuthorityKeyIdentifierExtension.create(new Uint8Array(this.ca.publicKey.export({ format: "der", type: "spki" })), false, crypto)],
    }, crypto);
    const pem = cert.toString("pem"), parsed = new X509Certificate(pem);
    if (!parsed.verify(this.ca.publicKey)) return fail("DEVICE_CERTIFICATE_ISSUE_FAILED");
    return { pem, expiresAt, renewAfter: expiresAt - this.renewBeforeMs, fingerprint: fingerprint(parsed) };
    } catch { return fail("DEVICE_CERTIFICATE_ISSUE_FAILED"); }
  }
  validateTLS(request: IncomingMessage): { fingerprint: string; expiresAt: number } {
    const socket = request.socket;
    if (!(socket instanceof TLSSocket) || !socket.encrypted || socket.isSessionReused()) return fail("DEVICE_CERTIFICATE_REQUIRED");
    const peer = socket.getPeerX509Certificate();
    if (!peer?.raw?.length) return fail("DEVICE_CERTIFICATE_REQUIRED");
    const now = Date.now(), expiresAt = Date.parse(peer.validTo);
    if (!Number.isFinite(expiresAt) || Date.parse(peer.validFrom) > now || expiresAt <= now) return fail("DEVICE_CERTIFICATE_EXPIRED");
    // OpenSSL marks an expired peer unauthorized. Preserve the actionable expiry
    // reason above while still requiring native chain/purpose verification here.
    if (!socket.authorized) return fail("DEVICE_CERTIFICATE_REQUIRED");
    if (peer.ca || !peer.keyUsage?.includes(clientAuth) || peer.keyUsage.length !== 1 || !peer.verify(this.ca.publicKey)) return fail("DEVICE_CERTIFICATE_INVALID");
    return { fingerprint: fingerprint(peer), expiresAt };
  }
}

/** Operator/fixture setup only. Writes a new CA; never overwrites or prints its private key. */
export async function createDeviceCertificateAuthority(options: { directory: string; protocolFixture?: boolean; certificateLifetimeSeconds?: number; renewBeforeSeconds?: number }): Promise<{ configFile: string; caPem: string }> {
  if (process.platform === "win32" && !options.protocolFixture) return fail("DEVICE_CA_UNSUPPORTED_OS");
  const directory = resolve(options.directory);
  // Exclusive directory creation makes reruns fail without replacing existing trust.
  mkdirSync(directory, { mode: 0o700 });
  if (realpathSync(directory) !== directory) return fail("DEVICE_CA_FILE_UNSAFE");
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]) as CryptoKeyPair;
  const now = Date.now();
  const cert = await X509CertificateGenerator.createSelfSigned({ serialNumber: serial(), name: `CN=Yuan Zhou Device CA ${randomBytes(8).toString("hex")}`, notBefore: new Date(now - 60_000), notAfter: new Date(now + 365 * 86400_000), signingAlgorithm: algorithm, keys, extensions: [new BasicConstraintsExtension(true, 0, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true), await SubjectKeyIdentifierExtension.create(keys.publicKey, false, crypto)] }, crypto);
  const caPem = cert.toString("pem"), der = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const configFile = join(directory, "device-ca.json"), caCertificateFile = join(directory, "ca.pem"), caPrivateKeyFile = join(directory, "ca-key.pem");
  try {
    writeFileSync(caPrivateKeyFile, `-----BEGIN PRIVATE KEY-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`, { flag: "wx", mode: 0o600 });
    writeFileSync(caCertificateFile, caPem, { flag: "wx", mode: 0o600 });
    writeFileSync(configFile, JSON.stringify({ version: 1, caCertificateFile, caPrivateKeyFile, ...(options.certificateLifetimeSeconds !== undefined ? { certificateLifetimeSeconds: options.certificateLifetimeSeconds } : {}), ...(options.renewBeforeSeconds !== undefined ? { renewBeforeSeconds: options.renewBeforeSeconds } : {}) }, null, 2), { flag: "wx", mode: 0o600 });
  } finally { der.fill(0); }
  await DeviceCertificates.load({ configFile, protocolFixture: options.protocolFixture });
  return { configFile, caPem };
}
