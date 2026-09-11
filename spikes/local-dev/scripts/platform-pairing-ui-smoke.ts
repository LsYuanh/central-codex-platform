// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import {deviceAuthorization,devicePairingError,type DeviceAccount} from "../apps/desktop/src/platform-pairing-state.ts";
const fresh:DeviceAccount={authMode:"device-token-v1",loggedIn:false,paired:false};
const paired:DeviceAccount={...fresh,loggedIn:true,paired:true,user:{id:"qa-user",username:"qa"},deviceId:"qa-device"};
assert.equal(deviceAuthorization(fresh).canPair,true);
assert.equal(deviceAuthorization(paired).valid,true);
assert.equal(deviceAuthorization(paired).canPair,false);
const offline=deviceAuthorization({...paired,remoteAvailable:false,connectionError:"中央连接或 TLS 证书校验失败"});
assert.equal(offline.valid,false,"Cached pairing must not claim verified authorization while offline");
assert.equal(offline.canPair,false,"Offline status must not invite accidental overwrite of a stored device");
assert.match(offline.notice,/暂时无法确认/);assert.match(offline.problem,/证书/);
const revoked=deviceAuthorization({...paired,authorizationError:"DEVICE_REVOKED"});
assert.equal(revoked.valid,false);assert.equal(revoked.canPair,true);assert.equal(revoked.hasLocalPairing,true);
assert.match(revoked.problem,/管理员已撤销/);
for(const storageError of ["DEVICE_TOKEN_STORAGE_UNSAFE","DEVICE_TOKEN_STORAGE_CORRUPT","DEVICE_TOKEN_STORAGE_UNAVAILABLE"]){
  const value=deviceAuthorization({...fresh,storageError});assert.equal(value.canPair,false);assert.equal(value.valid,false);assert(value.problem.length>0);
}
assert.equal(deviceAuthorization({...fresh,authMode:"legacy"}).canPair,false,"No silent authentication downgrade");
assert.match(devicePairingError("PAIR_CODE_EXPIRED"),/过期/);
assert.match(devicePairingError("PAIR_CODE_USED"),/已使用/);
assert.match(devicePairingError("PAIR_INPUT_INVALID"),/配对码和本机设备名称不能为空或过长/);
assert.match(devicePairingError("Error: AUTH_REQUIRED"),/授权已失效/);
assert.match(devicePairingError(new Error("PAIRING_RESULT_UNKNOWN")),/不要重复使用/);
for(const [code,reason] of [["CENTRAL_CERT_NOT_YET_VALID","尚未生效"],["CENTRAL_CERT_EXPIRED","已过期"],["CENTRAL_CERT_NAME_MISMATCH","地址与证书不匹配"],["CENTRAL_CERT_UNTRUSTED","不受当前中央 CA 信任"],["CENTRAL_CONNECTION_REFUSED","拒绝连接"],["CENTRAL_CONNECTION_TIMEOUT","连接超时"]]){
  assert(devicePairingError(code).includes(reason));assert(devicePairingError(code).includes(code));
}
assert(!devicePairingError("CENTRAL_CERT_EXPIRED bearer=private-secret").includes("private-secret"));
assert(!devicePairingError("unknown server error with token-secret-123").includes("token-secret-123"),"Unknown native errors are not reflected into product UI");
console.log("PLATFORM_PAIRING_UI_SMOKE_OK: fresh, paired, offline, revoked, storage failures, incompatible central, expired/used code and unknown result");
