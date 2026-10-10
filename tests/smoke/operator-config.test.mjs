// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {formalGateway, formalSan, qaHost, qaRoot, remoteCommand, sshTarget} from '../../scripts/maintenance/operator-config.mjs';

test('operator targets fail closed and remote shell inputs stay constrained', () => {
  const names = ['CENTRAL_FORMAL_GATEWAY','CENTRAL_FORMAL_DIRECTORY','CENTRAL_QA_HOST','CENTRAL_QA_ROOT','CENTRAL_REMOTE_NODE','CENTRAL_QA_AUTH_FILE','CENTRAL_SSH_TARGET'];
  const previous = Object.fromEntries(names.map(k => [k, process.env[k]]));
  try {
    for (const k of names) delete process.env[k];
    assert.throws(qaHost, /REQUIRED/);
    assert.throws(formalGateway, /REQUIRED/);
    assert.throws(() => remoteCommand('/tmp/qa.mjs'), /REQUIRED/);
    for (const invalid of ['ws://central.example:4510/ws','wss://secret@central.example:4510/ws','wss://central.example:4529/ws','wss://central.example:4510/ws?token=secret', "wss://bad'host:4510/ws"]) {
      process.env.CENTRAL_FORMAL_GATEWAY = invalid;
      assert.throws(formalGateway);
    }
    process.env.CENTRAL_FORMAL_GATEWAY = 'wss://central.example:4510/ws';
    assert.equal(formalSan(), 'DNS:central.example,IP:127.0.0.1,DNS:localhost');
    process.env.CENTRAL_QA_HOST = '192.0.2.10';
    process.env.CENTRAL_QA_ROOT = '/tmp/isolated-qa';
    process.env.CENTRAL_REMOTE_NODE = '/opt/node/bin/node';
    process.env.CENTRAL_SSH_TARGET = 'operator@central.example';
    assert.equal(sshTarget(), 'operator@central.example');
    assert.equal(qaRoot(), '/tmp/isolated-qa');
    const command = remoteCommand('/tmp/qa.mjs', ['start-workers']);
    assert(command.includes("CENTRAL_QA_HOST='192.0.2.10'"));
    assert(!command.includes('CENTRAL_FORMAL_GATEWAY'));
    process.env.CENTRAL_FORMAL_DIRECTORY = '/tmp/private-deployment';
    const formal = remoteCommand('/tmp/formal.mjs', ['status'], {formal:true});
    assert(formal.includes("CENTRAL_FORMAL_GATEWAY='wss://central.example:4510/ws'"));
    assert(!formal.includes('CENTRAL_QA_AUTH_FILE'));
    for (const invalid of ['/tmp/../real', '/tmp/qa;id', '/tmp/$(id)', '/']) {
      process.env.CENTRAL_QA_ROOT = invalid;
      assert.throws(qaRoot);
    }
    assert.throws(() => remoteCommand('/tmp/qa.mjs', ['status;id'], {formal:true}));
    process.env.CENTRAL_SSH_TARGET = '-oProxyCommand=command';
    assert.throws(sshTarget);
  } finally {
    for (const [k,v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
