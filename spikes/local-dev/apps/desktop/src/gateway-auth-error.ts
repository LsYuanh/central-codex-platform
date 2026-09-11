// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Public terminal codes only. Never reflect transport diagnostics or bearer values.
const notices={
  AUTH_REQUIRED:"本机授权已失效，请在设置中使用新的配对码重新配对。",
  DEVICE_REVOKED:"本机授权已被管理员撤销，请在设置中使用新的配对码重新配对。",
  AUTH_MODE_UNSUPPORTED:"中央认证方式不兼容，请管理员核对中央地址和服务版本后，在设置中重新配对。",
  DEVICE_TOKEN_REQUIRED:"本机尚未配对，请在设置中使用管理员提供的配对码授权本机。",
  DEVICE_TOKEN_STORAGE_UNSAFE:"本机授权存储的路径或权限不符合要求，已停止重连。请修复存储后在设置中重新读取状态。",
  DEVICE_TOKEN_STORAGE_CORRUPT:"本机授权存储已损坏，已停止重连。请在设置中处理本机配对并重新授权。",
  DEVICE_TOKEN_STORAGE_UNAVAILABLE:"本机授权存储不可用，已停止重连。请检查应用目录权限和磁盘空间后，在设置中重新读取状态。",
  REFRESH_REUSED:"本机登录凭据已失效，请在设置中重新授权。",
  DEVICE_CERTIFICATE_REQUIRED:"本机缺少设备证书，请在设置中重新配对本机。",
  DEVICE_CERTIFICATE_INVALID:"本机设备证书无效，请在设置中重新配对本机。",
  DEVICE_CERTIFICATE_EXPIRED:"本机设备证书已过期，请在设置中重新配对本机。",
} as const;
export type GatewayAuthCode=keyof typeof notices;
export function exactGatewayAuthCode(value:unknown):GatewayAuthCode|undefined{
  return typeof value==="string"&&Object.hasOwn(notices,value)?value as GatewayAuthCode:undefined;
}
export function gatewayAuthCode(value:unknown):GatewayAuthCode|undefined{
  const message=value instanceof Error?value.message:typeof value==="string"?value:"";
  return exactGatewayAuthCode(message.replace(/^Error:\s*/,""));
}
export function gatewayAuthNotice(code:GatewayAuthCode):string{return notices[code];}
