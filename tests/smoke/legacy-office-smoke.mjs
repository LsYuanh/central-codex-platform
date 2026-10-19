// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real Agent on either OS; loopback protocol fixture, not model inference.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {createEnvelope} from '../../packages/agentrpc-types/dist/index.js';
import {localAgentExecutable} from './client-smoke-platform.mjs';
import {loadFixtures, revision} from './legacy-office-fixtures.mjs';

const fixtures = await loadFixtures(process.argv.includes('--fetch'));
const server = new WebSocketServer({host:'127.0.0.1', port:0});
await new Promise(r => server.once('listening', r));
let socket;
const pending = new Map();
const connected = new Promise(resolve => server.on('connection', ws => {
  socket = ws;
  ws.on('message', bytes => {
    const message = JSON.parse(bytes);
    if (message.type === 'agent.hello') resolve(message.payload.agent);
    if (message.type === 'agent.response') pending.get(message.requestId)?.(message.payload);
  });
}));
const agent = spawn(localAgentExecutable(), ['--workspace-root', process.cwd(), '--gateway-url', `ws://127.0.0.1:${server.address().port}/ws/agent`], {windowsHide:true, stdio:'ignore'});
const call = (method, params) => new Promise((resolve, reject) => {
  const id = randomUUID();
  const timer = setTimeout(() => {pending.delete(id); reject(Error(`Agent timeout: ${method}`));}, 30000);
  pending.set(id, result => {clearTimeout(timer); pending.delete(id); resolve(result);});
  socket.send(JSON.stringify(createEnvelope('agent.request', {method, params, operationId:id, idempotencyKey:id}, {requestId:id})));
});
try {
  const hello = await Promise.race([connected, new Promise((_, reject) => setTimeout(() => reject(Error('Agent did not connect')), 10000).unref())]);
  assert(hello.capabilities.includes('documents/v1'));
  const results = [];
  for (const fixture of fixtures) {
    const stat = await call('file/stat', {path:fixture.path});
    assert.equal(stat.ok, true); assert.equal(stat.result.kind, 'document');
    const first = await call('file/read_document', {path:fixture.path, version:stat.result.version});
    if (!fixture.sections) {
      assert.equal(first.ok, false, fixture.name);
      assert.equal(first.errorCode, 'DOCUMENT_PASSWORD_REQUIRED', fixture.name);
      results.push({name:fixture.name, error:first.errorCode});
      continue;
    }
    let content = '';
    for (let index = 0; index < fixture.sections.length; index++) {
      // Exercise the public read_text continuation route as well as read_document.
      const reply = index ? await call('file/read_text', {path:fixture.path, section:index + 1, version:stat.result.version}) : first;
      assert.equal(reply.ok, true, `${fixture.name}: ${reply.error}`);
      const row = reply.result;
      assert.equal(row.sections, fixture.sections.length, fixture.name);
      assert.equal(row.section, index + 1);
      assert.equal(row.nextSection, index + 1 < fixture.sections.length ? index + 2 : null);
      assert.equal(row.source, 'client'); assert.equal(row.untrusted, true); assert.equal(row.truncated, false);
      for (const marker of fixture.sections[index]) assert(row.content.includes(marker), `${fixture.name}: missing ${marker}`);
      content += row.content;
    }
    const outside = await call('file/read_document', {path:fixture.path, section:fixture.sections.length + 1});
    assert.equal(outside.errorCode, 'DOCUMENT_SECTION_INVALID');
    const changed = await call('file/read_document', {path:fixture.path, version:'stale-version'});
    assert.equal(changed.errorCode, 'SOURCE_CHANGED');
    results.push({name:fixture.name, sections:fixture.sections.length, contentSha256:createHash('sha256').update(content).digest('hex')});
  }
  console.log(JSON.stringify({ok:true, platform:process.platform, arch:process.arch, revision, results}));
} finally {
  socket?.terminate(); agent.kill(); await new Promise(r => server.close(r));
}
