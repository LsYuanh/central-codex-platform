// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Developer/operator tooling only. No deployment identity is a product default.
import path from 'node:path';
import {isIPv4} from 'node:net';

export function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw Error(`${name}_REQUIRED`);
  return value;
}
export function posixSetting(name) {
  const value = required(name);
  // These paths also enter remote shell commands; reject shell syntax and traversal.
  if (!/^\/[A-Za-z0-9_./-]+$/.test(value) || value.includes('//') || value.split('/').includes('..') || path.posix.normalize(value) !== value || value === '/') throw Error(`${name}_INVALID`);
  return value;
}
export function qaHost() {
  const host = required('CENTRAL_QA_HOST');
  if (!isIPv4(host) || host === '0.0.0.0' || host === '255.255.255.255') throw Error('CENTRAL_QA_HOST_INVALID');
  return host;
}
export const qaGateway = () => `wss://${qaHost()}:4529/ws`;
export const qaOrigin = () => `https://${qaHost()}:4529`;
export const qaRoot = () => posixSetting('CENTRAL_QA_ROOT');
export const remoteRoot = () => posixSetting('CENTRAL_REMOTE_ROOT');
export const formalDirectory = () => posixSetting('CENTRAL_FORMAL_DIRECTORY');
export const remoteNode = () => posixSetting('CENTRAL_REMOTE_NODE');
export const qaAuthFile = () => posixSetting('CENTRAL_QA_AUTH_FILE');
export function sshTarget() {
  const value = required('CENTRAL_SSH_TARGET');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value)) throw Error('CENTRAL_SSH_TARGET_INVALID');
  return value;
}
export function sshKey() {
  const value = required('CENTRAL_SSH_KEY');
  if (!path.isAbsolute(value)) throw Error('CENTRAL_SSH_KEY_INVALID');
  return value;
}
export function formalGateway() {
  const value = required('CENTRAL_FORMAL_GATEWAY');
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.port !== '4510' || url.pathname !== '/ws' || url.search || url.hash || url.username || url.password || !/^[a-z0-9][a-z0-9.-]*$/i.test(url.hostname) || url.hostname === '0.0.0.0') throw Error('CENTRAL_FORMAL_GATEWAY_INVALID');
  return url.href;
}
export function formalHost() { return new URL(formalGateway()).hostname; }
export function formalSan() {
  const host = formalHost();
  return `${isIPv4(host) ? 'IP' : 'DNS'}:${host},IP:127.0.0.1,DNS:localhost`;
}
export function remoteCommand(script, args = [], {formal = false} = {}) {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(script) || script.split('/').includes('..') || args.some(arg => !/^[A-Za-z0-9_-]+$/.test(arg))) throw Error('CENTRAL_REMOTE_COMMAND_INVALID');
  // SSH does not forward local environment variables automatically. Forward only
  // the non-secret target settings required by these explicitly selected tools.
  const settings = formal ? {CENTRAL_FORMAL_GATEWAY: formalGateway(), CENTRAL_FORMAL_DIRECTORY: formalDirectory()} : {
    CENTRAL_QA_HOST: qaHost(), CENTRAL_QA_ROOT: qaRoot(), CENTRAL_REMOTE_NODE: remoteNode(),
    ...(process.env.CENTRAL_QA_AUTH_FILE ? {CENTRAL_QA_AUTH_FILE: qaAuthFile()} : {}),
  };
  return `env ${Object.entries(settings).map(([k,v]) => `${k}='${v}'`).join(' ')} ${remoteNode()} ${script} ${args.join(' ')}`;
}
