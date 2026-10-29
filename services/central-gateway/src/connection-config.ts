// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Supplied only over the owned native control pipe; never read from public env/config.
export type RelayTarget = {centralId:string;access:{url:string;token:string;caPem:string}};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const fields=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
export function validateRelayTarget(value:unknown):RelayTarget|null {
  if(value===null)return null;
  if(!record(value)||!fields(value,['centralId','access'])||typeof value.centralId!=='string'||!/^[a-f0-9]{64}$/.test(value.centralId)
    ||!record(value.access)||!fields(value.access,['url','token','caPem']))throw Error('SERVICE_CONNECTION_INVALID');
  const {url,token,caPem}=value.access;
  if(typeof url!=='string'||typeof token!=='string'||!/^[\x21-\x7e]{32,4096}$/.test(token)||typeof caPem!=='string'||caPem.length>65536)throw Error('SERVICE_CONNECTION_INVALID');
  const u=new URL(url);
  if(u.protocol!=='https:'||!u.hostname||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('SERVICE_CONNECTION_INVALID');
  return {centralId:value.centralId,access:{url,token,caPem}};
}
