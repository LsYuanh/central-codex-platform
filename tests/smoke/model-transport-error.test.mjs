// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import {modelTransportCategory,ModelTransportError} from '../../services/central-gateway/dist/model-transport-error.js';
import {fetchModelCatalog} from '../../services/central-gateway/dist/model-catalog.js';
import {explainRuntimeError} from '../../services/central-gateway/dist/remote-workspace.js';

test('closed transport categories redact messages and unknown codes, including wrapped and aggregate errors',()=>{
  const secret='FAKE_ONLY_PRIVATE_DIAGNOSTIC';
  for(const [code,category] of [['ENOTFOUND','DNS'],['EAI_AGAIN','DNS'],['ETIMEDOUT','TIMEOUT'],['ECONNRESET','CONNECTION_RESET'],['EPIPE','CONNECTION_RESET'],['ECONNREFUSED','CONNECTION_REFUSED'],['ENETUNREACH','UNREACHABLE'],['CERT_HAS_EXPIRED','TLS'],['ERR_TLS_CERT_ALTNAME_INVALID','TLS'],['ABORT_ERR','CANCELLED'],[secret,'UNKNOWN']]){
    const e=Object.assign(Error(secret),{code,address:secret});
    assert.equal(modelTransportCategory(e),category);
    assert.equal(modelTransportCategory({cause:e}),category);
    const safe=new ModelTransportError('REQUEST',e);
    assert.equal(safe.message,`MODEL_PROVIDER_REQUEST_TRANSPORT_FAILED_${category}`);
    assert(!JSON.stringify(safe).includes(secret));assert(!safe.stack.includes(secret));
  }
  assert.equal(modelTransportCategory(new AggregateError([{code:'ETIMEDOUT'},{code:'ETIMEDOUT'}])),'TIMEOUT');
  assert.equal(modelTransportCategory(new AggregateError([{code:'ETIMEDOUT'},{code:'ECONNREFUSED'}])),'MIXED');
  const cyclic={};cyclic.cause=cyclic;assert.equal(modelTransportCategory(cyclic),'UNKNOWN');
  assert.equal(modelTransportCategory({code:'toString'}),'UNKNOWN');
  assert.equal(modelTransportCategory(new DOMException(secret,'TimeoutError')),'TIMEOUT');
});

test('network and catalog errors do not tell users to reauthorize; credential failures still do',()=>{
  for(const code of ['MODEL_PROVIDER_REQUEST_TRANSPORT_FAILED','MODEL_PROVIDER_STREAM_TRANSPORT_FAILED','MODEL_PROVIDER_STREAM_ABORTED','MODEL_CATALOG_UNAVAILABLE','MODEL_REQUEST_TIMEOUT',...['DNS','TIMEOUT','TLS','UNKNOWN','CONNECTION_RESET','CONNECTION_REFUSED','UNREACHABLE','MIXED'].map(c=>'MODEL_PROVIDER_REQUEST_TRANSPORT_FAILED_'+c)]){
    const text=explainRuntimeError(code+': FAKE_ONLY_PRIVATE_DIAGNOSTIC');
    assert(text.includes('当前任务不会自动重发'));assert(!text.includes('检查授权'));assert(!text.includes('FAKE_ONLY'));
  }
  assert(explainRuntimeError('MODEL_CREDENTIAL_REJECTED').includes('检查授权'));
  assert(explainRuntimeError('MODEL_PROVIDER_RATE_LIMITED').includes('请求受限'));
  assert(explainRuntimeError('MODEL_REQUEST_CANCELLED').includes('已取消'));
  assert(!explainRuntimeError('MODEL_PROVIDER_CATALOG_TRANSPORT_FAILED_CANCELLED').includes('检查中央网络'));
});

test('catalog classifies actual reset, deadline and cancellation without mistaking HTTP failure for reset',async()=>{
  const server=http.createServer((req,res)=>{
    if(req.url==='/reset'){req.socket.destroy();return;}
    if(req.url==='/http'){res.writeHead(401,{'content-type':'application/json'});res.end('FAKE_ONLY_PRIVATE_DIAGNOSTIC');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=route=>new URL(`http://127.0.0.1:${server.address().port}${route}`);
  try{
    await assert.rejects(fetchModelCatalog(url('/reset'),{},AbortSignal.timeout(2000)),{message:'MODEL_PROVIDER_CATALOG_TRANSPORT_FAILED_CONNECTION_RESET'});
    await assert.rejects(fetchModelCatalog(url('/hold'),{},AbortSignal.timeout(100)),{message:'MODEL_PROVIDER_CATALOG_TRANSPORT_FAILED_TIMEOUT'});
    await assert.rejects(fetchModelCatalog(url('/http'),{},AbortSignal.timeout(2000)),{message:'MODEL_CATALOG_UNAVAILABLE'});
    await assert.rejects(fetchModelCatalog(url('/hold'),{},AbortSignal.abort()),{message:'MODEL_PROVIDER_CATALOG_TRANSPORT_FAILED_CANCELLED'});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
