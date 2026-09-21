// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Read-only inspection of an explicitly staged, sanitized offline bundle. No import or network.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requireShape(condition, code) { if (!condition) throw Error(code); }

export function readBundleFile(root, name) {
  requireShape(string(name) && !isAbsolute(name) && !name.includes('\\') && !name.includes(':') && name.split('/').every(p => p && p !== '.' && p !== '..'), 'BUNDLE_PATH_UNSAFE');
  const base = fs.realpathSync(root), path = resolve(base, ...name.split('/'));
  const rel = relative(base, path);
  requireShape(rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel), 'BUNDLE_PATH_UNSAFE');
  let cursor = base;
  for (const part of name.split('/')) {
    cursor = join(cursor, part);
    const stat = fs.lstatSync(cursor);
    requireShape(!stat.isSymbolicLink(), 'BUNDLE_PATH_UNSAFE');
  }
  const stat = fs.lstatSync(path);
  requireShape(stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024 * 1024, 'BUNDLE_FILE_UNSAFE');
  return fs.readFileSync(path);
}

/** Public identity metadata is evidence to review, not proof of CA trust or possession. */
export function inspectMigrationBundle(root, now = Date.now()) {
  const json = name => JSON.parse(readBundleFile(root, name).toString('utf8'));
  const gateway = json('gateway.json'), identities = json('target-identities.json'), plan = json('plan.json');
  requireShape(object(gateway) && gateway.version === 1 && object(gateway.users), 'GATEWAY_STATE_CORRUPT');
  const entries = [], threadIds = new Set();
  for (const [userId, threads] of Object.entries(gateway.users)) {
    requireShape(string(userId) && Array.isArray(threads), 'GATEWAY_STATE_CORRUPT');
    for (const entry of threads) {
      requireShape(object(entry) && string(entry.id) && object(entry.summary) && !threadIds.has(entry.id), 'GATEWAY_STATE_CORRUPT');
      threadIds.add(entry.id); entries.push({ ...entry, userId });
    }
  }
  requireShape(object(identities) && identities.version === 1 && Array.isArray(identities.users) && Array.isArray(identities.devices), 'IDENTITY_INVENTORY_INVALID');
  // Reject full auth.json accidentally supplied in place of this public projection.
  requireShape(Object.keys(identities).every(k => ['version', 'users', 'devices'].includes(k)), 'PUBLIC_INVENTORY_ONLY');
  const users = new Map(), devices = new Map();
  for (const user of identities.users) {
    requireShape(object(user) && Object.keys(user).every(k => ['id', 'disabled'].includes(k)) && string(user.id) && typeof user.disabled === 'boolean' && !users.has(user.id), 'IDENTITY_INVENTORY_INVALID');
    users.set(user.id, user);
  }
  for (const device of identities.devices) {
    requireShape(object(device) && Object.keys(device).every(k => ['id', 'userId', 'deviceKey', 'workspaceRoot', 'revoked', 'certificates'].includes(k)) && string(device.id) && users.has(device.userId) && digest(device.deviceKey) && string(device.workspaceRoot) && typeof device.revoked === 'boolean' && Array.isArray(device.certificates) && !devices.has(device.id), 'IDENTITY_INVENTORY_INVALID');
    for (const cert of device.certificates) requireShape(object(cert) && Object.keys(cert).every(k => ['fingerprint', 'expiresAt'].includes(k)) && digest(cert.fingerprint) && Number.isFinite(cert.expiresAt), 'IDENTITY_INVENTORY_INVALID');
    devices.set(device.id, device);
  }
  requireShape(object(plan) && plan.version === 1 && Array.isArray(plan.accounts) && Array.isArray(plan.devices) && Array.isArray(plan.history), 'MIGRATION_PLAN_INVALID');
  const issues = [], threads = [], accounts = new Map(), mappedTargets = new Set(), deviceMappings = new Map(), history = new Map();
  const issue = (code, threadId) => issues.push({ code, ...(threadId ? { threadId } : {}) });
  if (plan.sourceQuiesced !== true) issue('SOURCE_QUIESCENCE_NOT_ATTESTED');
  for (const row of plan.accounts) {
    requireShape(object(row) && string(row.sourceUserId) && string(row.targetUserId) && !accounts.has(row.sourceUserId), 'ACCOUNT_MAPPING_AMBIGUOUS');
    requireShape(Object.hasOwn(gateway.users, row.sourceUserId), 'ACCOUNT_MAPPING_SOURCE_UNKNOWN');
    requireShape(!mappedTargets.has(row.targetUserId), 'ACCOUNT_MERGE_REQUIRES_SEPARATE_REVIEW');
    accounts.set(row.sourceUserId, row.targetUserId); mappedTargets.add(row.targetUserId);
  }
  for (const row of plan.devices) {
    requireShape(object(row) && string(row.sourceUserId) && string(row.sourceDeviceId) && string(row.targetDeviceId), 'DEVICE_MAPPING_INVALID');
    const key = JSON.stringify([row.sourceUserId, row.sourceDeviceId]);
    requireShape(!deviceMappings.has(key), 'DEVICE_MAPPING_AMBIGUOUS'); deviceMappings.set(key, row.targetDeviceId);
  }
  for (const row of plan.history) {
    requireShape(object(row) && threadIds.has(row.threadId) && Array.isArray(row.files) && row.files.length > 0 && !history.has(row.threadId), 'HISTORY_INVENTORY_INVALID');
    history.set(row.threadId, row.files);
  }
  // Shared runtime history needs a real native import procedure; a marker edit is never sufficient.
  if (entries.length && gateway.workerLayout !== 'per-user/v1') issue('WORKER_LAYOUT_MIGRATION_REQUIRED');
  for (const userId of Object.keys(gateway.users)) {
    const mapped = accounts.get(userId);
    if (!mapped) { if (!issues.some(i => i.code === 'ACCOUNT_MAPPING_MISSING')) issue('ACCOUNT_MAPPING_MISSING'); }
    else if (!users.has(mapped) || users.get(mapped).disabled) { if (!issues.some(i => i.code === 'TARGET_ACCOUNT_UNAVAILABLE')) issue('TARGET_ACCOUNT_UNAVAILABLE'); }
  }
  const historyPaths = new Set();
  for (const { userId, id, summary } of entries) {
    const reasons = [], fail = code => { reasons.push(code); issue(code, id); };
    const targetUserId = accounts.get(userId), sourceDeviceId = summary.deviceId ?? summary.remoteWorkspace?.deviceId;
    const mappedDeviceId = deviceMappings.get(JSON.stringify([userId, sourceDeviceId]));
    const device = devices.get(mappedDeviceId);
    if (!string(sourceDeviceId)) fail('SOURCE_DEVICE_BINDING_MISSING');
    if (!mappedDeviceId) fail('DEVICE_MAPPING_MISSING');
    if (mappedDeviceId && (!device || device.revoked || device.userId !== targetUserId)) fail('TARGET_DEVICE_UNAVAILABLE_OR_FOREIGN');
    if (device && !device.certificates.some(c => c.expiresAt > now)) fail('DEVICE_CERTIFICATE_MISSING_OR_EXPIRED');
    const binding = summary.remoteWorkspace;
    if (binding !== undefined && (!object(binding) || binding.policy !== 'remote-workspace/v1' || binding.userId !== userId || binding.deviceId !== sourceDeviceId || !digest(binding.deviceKey) || !string(binding.workspaceRoot) || (summary.deviceKey !== undefined && binding.deviceKey !== summary.deviceKey))) fail('SOURCE_BINDING_INCONSISTENT');
    const changed = device && (userId !== targetUserId || sourceDeviceId !== device.id || (summary.deviceKey && summary.deviceKey !== device.deviceKey) || (binding && (binding.deviceKey !== device.deviceKey || binding.workspaceRoot !== device.workspaceRoot)));
    if (changed) reasons.push('REMOTE_WORKSPACE_CHANGED');
    if (!binding) reasons.push('LEGACY_BINDING_NEEDS_ORIGINAL_DEVICE_VERIFICATION');
    if (Array.isArray(summary.attachmentSubmissions) && summary.attachmentSubmissions.some(s => ['preparing', 'submitting', 'unknown'].includes(s?.status))) fail('SUBMISSION_RECONCILIATION_REQUIRED');
    if (Array.isArray(summary.outputs) && summary.outputs.some(o => o?.status === 'saving')) fail('OUTPUT_RECONCILIATION_REQUIRED');
    const files = history.get(id);
    if (!files) fail('NATIVE_HISTORY_INVENTORY_MISSING');
    else for (const file of files) {
      requireShape(object(file) && string(file.path) && digest(file.sha256) && !historyPaths.has(file.path), 'HISTORY_FILE_INVENTORY_INVALID');
      requireShape(!['gateway.json', 'target-identities.json', 'plan.json'].includes(file.path), 'HISTORY_FILE_INVENTORY_INVALID');
      historyPaths.add(file.path);
      try { if (hash(readBundleFile(root, file.path)) !== file.sha256) fail('NATIVE_HISTORY_HASH_MISMATCH'); }
      catch (error) { if (String(error).includes('BUNDLE_')) throw error; fail('NATIVE_HISTORY_UNREADABLE'); }
    }
    threads.push({ threadId: id, preservation: files && !issues.some(i => i.threadId === id && i.code.startsWith('NATIVE_HISTORY_')) ? 'listed-bytes-verified' : 'unverified', execution: changed ? 'unavailable-binding-changed' : 'not-verified-offline', reasons });
  }
  return { version: 1, mode: 'offline-preflight-only', readyForCutover: false, importImplemented: false,
    status: issues.length ? 'blocked' : 'offline-checks-passed-runtime-validation-required',
    checksAt: new Date(now).toISOString(), sourceLayout: gateway.workerLayout ?? 'shared-or-unspecified',
    counts: { users: Object.keys(gateway.users).length, threads: entries.length, historyFiles: historyPaths.size }, issues, threads,
    limits: ['No ownership, device binding or workerLayout was changed.', 'Certificate metadata does not verify CA trust, private-key possession or native vault availability.', 'Native history inventory hashes do not establish database consistency or successful App Server import.', 'sourceQuiesced is an operator assertion; this offline tool does not observe processes.', 'No unknown operation is replayed.'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireShape(process.argv.length === 4 && process.argv[2] === '--bundle', 'USAGE: node scripts/maintenance/migration-preflight.mjs --bundle /absolute/staged/bundle');
    const result = inspectMigrationBundle(resolve(process.argv[3]));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'blocked') process.exitCode = 2;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
