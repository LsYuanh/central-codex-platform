// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const password=randomBytes(32).toString('base64url'),gateway='wss://192.0.2.10:4529/ws';
const saved=spawnSync(resolve('target/harness-agent/debug/examples/platform-acceptance.exe'),[],{input:JSON.stringify({namespace:'com.centralcodex.harnessqa.p5.bootstrap',gateway,action:'fixture-set',password}),encoding:'utf8',windowsHide:true});
assert.equal(saved.status,0,saved.stderr);
const script=process.argv.includes('--mtls')?'prepare-mtls-qa.mjs':process.argv.includes('--isolated')?'prepare-isolated-qa.mjs':process.argv.includes('--workers-final')?'prepare-workers-qa.mjs --additional':process.argv.includes('--workers')?'prepare-workers-qa.mjs':'prepare-platform-qa.mjs';
const remote=spawnSync('ssh.exe',['-i','C:/Users/developer/.ssh/id_ed25519','-o','BatchMode=yes','operator@192.0.2.10',`/Users/operator/central-codex-platform/artifacts/macos-tools/node/bin/node /Users/operator/central-harness-qa-20260909/${script}`],{input:JSON.stringify({password}),encoding:'utf8',windowsHide:true});
assert.equal(remote.status,0,remote.stderr);console.log(remote.stdout.trim());
