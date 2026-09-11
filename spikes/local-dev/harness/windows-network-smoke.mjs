// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Observe numeric TCP only. A timeout is never a policy-denial pass.
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert(['--probe', '--output', '--lan-ip', '--lan-port'].includes(process.argv[i]) && process.argv[i + 1] && !args.has(process.argv[i]), 'Invalid network QA arguments');
  args.set(process.argv[i], process.argv[i + 1]);
}
assert.equal(process.platform, 'win32');
assert(isAbsolute(args.get('--probe') ?? '') && isAbsolute(args.get('--output') ?? ''));
const probe = realpathSync(args.get('--probe')), requested = args.get('--output'), output = resolve(requested);
assert(!requested.startsWith('\\\\') && !requested.split(/[\\/]/).some(part => part === '.' || part === '..'));
assert(!existsSync(output) && existsSync(dirname(output)));
assert.equal(realpathSync(dirname(output)).toLowerCase(), dirname(output).toLowerCase()); mkdirSync(output);
const servers = [], sockets = new Set(), cases = [];
const result = {scope: 'real-appcontainer-numeric-tcp-network-matrix', observationComplete: false,
  tcpCasesQualified: false, fullNetworkIsolationQualified: false, dnsTested: false, udpTested: false,
  firewallModified: false, loopbackExemptionsAdded: false, realCredentialsUsed: false, deployable: false,
  probeSha256: createHash('sha256').update(readFileSync(probe)).digest('hex'), cases};
async function loopback(ip, name) {
  const observed = {hostMessages: 0, containerMessages: 0, otherMessages: 0};
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {}); let content = '';
    socket.on('data', bytes => { content += bytes.toString('ascii'); socket.write(bytes); });
    socket.once('close', () => {
      if (content === 'HOST_BASELINE_NETWORK_QA') observed.hostMessages++;
      else if (content === 'APPCONTAINER_NETWORK_QA') observed.containerMessages++;
      else observed.otherMessages++;
    });
  }); servers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({host: ip, port: 0, ipv6Only: true}, resolve); });
  return {name, ip, port: server.address().port, observed};
}
async function run(endpoint) {
  const directory = join(output, endpoint.name);
  const child = spawn(probe, [directory, endpoint.ip, String(endpoint.port)], {windowsHide: true, stdio: 'pipe'});
  let diagnostics = ''; child.stdout.resume(); child.stderr.on('data', bytes => { diagnostics += bytes.toString('utf8'); if (diagnostics.length > 2048) child.kill(); });
  let timer;
  const exit = await new Promise((resolve, reject) => {
    timer = setTimeout(() => { child.kill(); reject(Error('NETWORK_QA_LAUNCHER_DEADLINE')); }, 45000);
    child.once('error', reject); child.once('exit', code => resolve(code));
  }).finally(() => clearTimeout(timer));
  const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
  assert.equal(exit, 0, 'Network observation failed; inspect fixed native stage code');
  assert(summary.completed && summary.profileCleaned && summary.workerExitObserved);
  const host = JSON.parse(readFileSync(join(directory, 'host.json'), 'utf8'));
  const worker = JSON.parse(readFileSync(join(directory, 'own', 'child.json'), 'utf8'));
  assert.equal(host.appContainer, 0); assert.equal(host.finalConnectError, 0); assert.equal(host.echoMatched, true);
  assert.equal(worker.appContainer, 1); assert.equal(worker.capabilityCount, 0);
  const missingCapability = worker.diagnosticApiError === 0 && [1, 2, 3].includes(worker.netIsoErrorType);
  const permissionDenied = worker.finalConnectError === 10013;
  cases.push({name: endpoint.name, targetIp: endpoint.ip, targetPort: endpoint.port, host, worker,
    hostBaselinePassed: true, connectionPermissionDenied: permissionDenied, missingCapabilityDiagnosed: missingCapability,
    timeoutOnly: worker.finalConnectError === 10060, unexpectedConnection: worker.finalConnectError === 0,
    observed: endpoint.observed ?? null, profileCleaned: summary.profileCleaned, workerExitObserved: summary.workerExitObserved,
    interpretation: permissionDenied ? 'Winsock explicitly denied this numeric TCP connection' :
      missingCapability ? 'Capability diagnostic is explicit; connect outcome is recorded separately and timeout is not denial' :
      'No explicit policy-denial evidence; failed connection alone is insufficient'});
  console.log('OBSERVED ' + endpoint.name + ' connect=' + worker.finalConnectError + ' diagnosis=' + worker.diagnosticApiError + '/' + worker.netIsoErrorType);
}
try {
  const endpoints = [await loopback('127.0.0.1', 'ipv4-loopback'), await loopback('::1', 'ipv6-loopback')];
  if (args.has('--lan-ip') || args.has('--lan-port')) {
    const ip = args.get('--lan-ip'), port = Number(args.get('--lan-port'));
    assert(net.isIP(ip ?? '') && Number.isInteger(port) && port > 0 && port <= 65535, 'Explicit numeric controlled LAN echo endpoint required');
    endpoints.push({name: 'controlled-lan', ip, port});
  }
  for (const endpoint of endpoints) await run(endpoint);
  for (const value of cases) if (value.observed) { assert.equal(value.observed.hostMessages, 1); assert.equal(value.observed.otherMessages, 0); }
  result.observationComplete = true;
  result.tcpCasesQualified = cases.every(value => value.connectionPermissionDenied && !value.unexpectedConnection && (!value.observed || value.observed.containerMessages === 0));
} catch { result.failureCode = 'NETWORK_QA_OBSERVATION_FAILED'; process.exitCode = 1; }
finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}
