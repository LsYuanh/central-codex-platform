// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {qaGateway, sshKey, sshTarget, remoteCommand, remoteRoot} from '../scripts/maintenance/operator-config.mjs';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const password=randomBytes(32).toString('base64url'),gateway=qaGateway();
const saved=spawnSync(resolve('target/harness-agent/debug/examples/platform-acceptance.exe'),[],{input:JSON.stringify({namespace:'com.centralcodex.harnessqa.p5.bootstrap',gateway,action:'fixture-set',password}),encoding:'utf8',windowsHide:true});
assert.equal(saved.status,0,saved.stderr);
const script=process.argv.includes('--mtls')?'prepare-mtls-qa.mjs':process.argv.includes('--isolated')?'prepare-isolated-qa.mjs':process.argv.includes('--workers-final')?'prepare-workers-qa.mjs --additional':process.argv.includes('--workers')?'prepare-workers-qa.mjs':'prepare-platform-qa.mjs';
const remote=spawnSync('ssh.exe',['-i',sshKey(),'-o','BatchMode=yes',sshTarget(),remoteCommand(`${remoteRoot()}/harness/${script.split(' ')[0]}`, script.split(' ').slice(1))],{input:JSON.stringify({password}),encoding:'utf8',windowsHide:true});
assert.equal(remote.status,0,remote.stderr);console.log(remote.stdout.trim());
