// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Imported by the real P4 history smoke. Never creates a model turn or owns cleanup.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { messagesFromThreadRead } from '../../apps/desktop/src/thread-history.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const displayPath = path => path.replace(/^\\\\\?\\/, '');

function inside(root, path) {
  assert.equal(typeof path, 'string', 'artifact must retain an actual client path');
  assert(isAbsolute(path), 'artifact path must be absolute');
  const child = relative(root, path);
  assert(child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child),
    `artifact is outside the isolated fixture: ${path}`);
  return path;
}

async function clientResult(request, operation, params) {
  const reply = await request(operation, params);
  assert.equal(reply?.ok, true, `${operation}: ${JSON.stringify(reply)}`);
  assert(reply.result && typeof reply.result === 'object');
  return reply.result;
}

/** One real client attachment and one destination for the history test's existing model turn. */
export async function prepareArtifactFixture({ ipc, fixture, deviceId }) {
  const root = displayPath(await realpath(resolve(fixture)));
  const testId = randomUUID();
  const folder = join(root, `artifact-history-${testId}`);
  const expectedAttachmentPath = inside(root, join(folder, 'client-source.txt'));
  const expectedOutputPath = inside(root, join(folder, 'client-result.txt'));
  const expectedAttachmentText = `CLIENT_ATTACHMENT_${testId}\r\n客户端附件：路径和版本来自 Windows Local Agent。\r\n`;
  const expectedOutputText = `CLIENT_OUTPUT_${testId}\r\n真实客户端历史输出。\r\n`;
  const written = await ipc('file/write_text', { path: expectedAttachmentPath, content: expectedAttachmentText });
  assert.equal(written.verified, true);
  assert.equal(written.path, expectedAttachmentPath);
  assert.equal(written.sha256, hash(Buffer.from(expectedAttachmentText)));
  const stat = await ipc('file/stat', { path: expectedAttachmentPath });
  assert.equal(stat.version, written.version);
  assert.equal(stat.kind, 'text');
  const attachment = {
    id: randomUUID(), source: 'localFile', path: stat.path, name: stat.name,
    kind: stat.kind, mimeType: stat.mimeType, bytes: stat.bytes, version: stat.version,
  };
  const writeParams = JSON.stringify({ path: expectedOutputPath, content: expectedOutputText });
  return {
    fixture: root, testId, deviceId, attachment, expectedAttachmentPath, expectedAttachmentText,
    expectedOutputPath, expectedOutputText,
    prompt: `This same acceptance turn includes a real client text attachment. Preserve its reference; do not edit the source. As the artifact compatibility step, call the legacy device_exec tool with program="codexia.files" and args=${JSON.stringify(['write_text', writeParams])}. Create exactly that isolated client output, then report the verified returned client path. Do not use central file tools or substitute shell writing. This is part of the existing test turn, not a request for an additional turn.`,
  };
}

/** Read real central history, restore its UI cards, and verify every claimed byte on the original Agent. */
export async function verifyArtifactHistory({
  request, ipc, fixture, threadId, deviceId, expectedAttachmentPath, expectedAttachmentText,
  expectedOutputPath, expectedOutputText, phase = 'history', previousSnapshot, verifySaving = true,
}) {
  const root = displayPath(await realpath(resolve(fixture)));
  inside(root, expectedAttachmentPath);
  inside(root, expectedOutputPath);
  const identity = await ipc('attachment/identity');
  assert.equal(identity.deviceId, deviceId, 'history test must stay on the original client device');
  assert.equal(identity.workspaceRoot, root);
  const history = await request('conversation.read', { threadId, includeTurns: true });
  assert.equal(history.thread?.id, threadId);
  const submission = history.attachmentSubmissions?.find(entry =>
    entry.status === 'sent' && entry.attachments?.some(file => file.path === expectedAttachmentPath));
  assert(submission, 'real thread history must contain a successfully submitted client attachment');
  const attachment = submission.attachments.find(file => file.path === expectedAttachmentPath);
  assert.equal(attachment.deviceId, deviceId);
  assert(['referenced', 'read'].includes(attachment.state));
  assert.equal(attachment.bytes, Buffer.byteLength(expectedAttachmentText));
  assert(history.thread.turns?.some(turn => turn.id === submission.turnId), 'submission must reference a real native turn');
  const output = history.outputs?.find(file => file.path === expectedOutputPath);
  assert(output, 'real dynamic tool output must be present in thread history');
  assert.equal(output.status, 'saved');
  assert.equal(output.source, 'deviceFile');
  assert.equal(output.deviceId, deviceId);
  assert.equal(output.deviceKey, identity.deviceKey);
  assert.equal(output.threadId, threadId);
  assert.equal(output.turnId, submission.turnId);
  assert.equal(output.sha256, hash(Buffer.from(expectedOutputText)));
  assert.equal(output.bytes, Buffer.byteLength(expectedOutputText));

  const restored = messagesFromThreadRead(history);
  const attachmentCards = restored.flatMap(message => message.attachments ?? [])
    .filter(file => file.id === attachment.id);
  const outputCards = restored.flatMap(message => message.outputs ?? []).filter(file => file.id === output.id);
  assert.equal(attachmentCards.length, 1, 'UI history must restore exactly one attachment card');
  assert.equal(outputCards.length, 1, 'UI history must restore exactly one output card');
  assert.deepEqual(attachmentCards[0], attachment);
  assert.deepEqual(outputCards[0], output);
  assert(restored.some(message => message.id === submission.clientMessageId && message.content === submission.content));
  assert(!restored.some(message => message.content.includes('[platform-message:')), 'UI must hide internal attachment markers');
  assert(!JSON.stringify(history).includes('data:image/'), 'history must not expose image transport payloads');

  for (const [record, expectedText] of [[attachment, expectedAttachmentText], [output, expectedOutputText]]) {
    const actualPath = displayPath(await realpath(inside(root, record.path)));
    inside(root, actualPath); // Also reject a fixture symlink that redirects to a personal file.
    assert.equal(actualPath, record.path);
    const stat = await clientResult(request, 'device.file.stat', { path: record.path });
    assert.equal(stat.path, record.path);
    assert.equal(stat.version, record.version);
    assert.equal(stat.bytes, Buffer.byteLength(expectedText));
    const text = await clientResult(request, 'device.file.read_text', { path: record.path, version: record.version });
    assert.equal(text.path, record.path);
    assert.equal(text.version, record.version);
    assert.equal(text.content, expectedText);
    assert.equal(text.truncated, false);
    assert.equal(hash(await readFile(actualPath)), hash(Buffer.from(expectedText)), 'real Windows file checksum differs');
    const stale = await request('device.file.read_text', { path: record.path, version: 'p4-stale-version' });
    assert.equal(stale.ok, false, 'a historical stale version must fail instead of silently reading new bytes');
    assert.match(String(stale.error), /SOURCE_CHANGED|变化/);
  }

  let savedCopy;
  if (verifySaving) {
    const copyPath = inside(root, join(root, `artifact-copy-${randomUUID()}.txt`));
    savedCopy = await ipc('file/copy', { sourcePath: output.path, path: copyPath });
    assert.equal(savedCopy.verified, true);
    assert.equal(savedCopy.path, copyPath);
    assert.equal(savedCopy.sha256, output.sha256);
    assert.equal(hash(await readFile(copyPath)), output.sha256);
    const repeat = await ipc('file/copy', { sourcePath: output.path, path: copyPath });
    assert.equal(repeat.version, savedCopy.version, 'saving identical bytes must be idempotent');
    const changed = 'P4 explicitly saved copy only\r\n';
    await assert.rejects(ipc('file/write_text', { path: copyPath, content: changed }), /FILE_EXISTS/);
    await assert.rejects(ipc('file/write_text', { path: copyPath, content: changed, overwrite: true, expectedVersion: 'p4-stale-version' }), /SOURCE_CHANGED/);
    const overwritten = await ipc('file/write_text', { path: copyPath, content: changed, overwrite: true, expectedVersion: savedCopy.version });
    assert.equal(overwritten.sha256, hash(Buffer.from(changed)));
    assert.equal(hash(await readFile(copyPath)), overwritten.sha256);
    assert.equal(hash(await readFile(output.path)), output.sha256, 'save-copy must leave the original historical output intact');
  }

  const snapshot = {
    threadId, submissionId: submission.clientMessageId, turnId: submission.turnId,
    attachment: { id: attachment.id, deviceId: attachment.deviceId, path: attachment.path, version: attachment.version, bytes: attachment.bytes },
    output: { id: output.id, deviceId: output.deviceId, deviceKey: output.deviceKey, path: output.path, version: output.version, bytes: output.bytes, sha256: output.sha256, status: output.status },
  };
  if (previousSnapshot) assert.deepEqual(snapshot, previousSnapshot, 'archive/recovery must preserve artifact identity, paths, versions and checksums');
  console.log(JSON.stringify({ phase: `artifact-${phase}`, ok: true, threadId, deviceId,
    checks: ['real-central-history', 'one-ui-card-per-artifact', 'original-device-identity', 'client-path-version-bytes-sha256', 'stale-version-rejected', ...(verifySaving ? ['verified-save-copy', 'idempotent-save', 'overwrite-version-guard', 'original-output-unchanged'] : []), ...(previousSnapshot ? ['archive-recovery-artifact-equivalence'] : [])],
    attachmentPath: attachment.path, outputPath: output.path, savedCopyPath: savedCopy?.path }));
  return snapshot;
}
