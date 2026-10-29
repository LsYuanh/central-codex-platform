// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, UiError, message as uiMessage, text as formatMessage, type MessageKey, type UiMessage } from "./i18n.ts";

const notices = {
  CENTRAL_CONNECTION_LIMIT: "客户端残留连接过多，请完整退出远舟后重新打开。",
  CENTRAL_PAGE_CHANGED: "页面已刷新，原连接已取消，请重试连接。",
  CENTRAL_IDENTITY_MISMATCH: "本机配对与运行配置不一致，请在连接设置中重新读取并应用配置。",
  CENTRAL_CLIENT_CONNECTION_FAILED: "客户端未能建立连接，请重试；若持续失败，请完整退出远舟后重新打开。",
  CENTRAL_CA_INVALID: "本机保存的中央 CA 格式无效，请重新读取配置或使用管理员的新配对码。",
  CENTRAL_CA_UNAVAILABLE: "找不到可用的中央信任证书，请使用管理员提供的一体配对码。",
  CENTRAL_TLS_INIT_FAILED: "客户端加密连接初始化失败，请重启客户端后重试。",
  CENTRAL_CERT_EXPIRED: "中央证书已过期，请核对本机时间并联系管理员更新证书。",
  CENTRAL_CERT_NOT_YET_VALID: "中央证书尚未生效，请核对本机日期、时间和时区。",
  CENTRAL_CERT_NAME_MISMATCH: "中央地址与证书不匹配，请核对中央连接地址或使用管理员的新配对码。",
  CENTRAL_CERT_UNTRUSTED: "服务端证书不受当前中央 CA 信任，请核对连接地址和管理员提供的配对码。",
  CENTRAL_CERT_INVALID: "中央证书校验失败，请联系管理员检查服务端证书。",
  CENTRAL_TLS_HANDSHAKE_FAILED: "与中央的加密握手失败，请联系管理员检查服务和网络中间设备。",
  CENTRAL_CONNECTION_REFUSED: "中央拒绝连接，请确认中央服务已启动且端口正确。",
  CENTRAL_CONNECTION_TIMEOUT: "中央连接超时，请检查网络与中央服务后重试。",
  CENTRAL_CONNECTION_FAILED: "中央连接未能建立，请检查网络、地址和中央服务后重试。",
  RELAY_CONFIG_INVALID: "公网中继配置无效，请管理员重新生成配对码。",
  RELAY_CONNECTION_FAILED: "公网中继连接失败，请检查网络和中央中继状态后重试。",
  RELAY_LOCAL_BIND_FAILED: "本机中继通道未能启动，请重试。",
} as const;
export type CentralTransportCode = keyof typeof notices;
export function centralTransportCode(value: unknown): CentralTransportCode | undefined {
  const raw = (value instanceof UiError ? value.localized.key : value instanceof Error ? value.message : typeof value === "string" ? value : "").replace(/^Error:\s*/, "");
  // Preserve actionable errors from older native builds without reflecting raw diagnostics.
  if(raw === "已有中央连接，请先关闭")return "CENTRAL_CONNECTION_LIMIT";
  if(raw === "页面通道已关闭")return "CENTRAL_PAGE_CHANGED";
  if(raw === "请应用中央配对获得的用户与设备配置")return "CENTRAL_IDENTITY_MISMATCH";
  return Object.hasOwn(notices, raw) ? raw as CentralTransportCode : undefined;
}
export function centralTransportNotice(value: unknown): string | undefined {
  const code = centralTransportCode(value);
  return code ? `${t(notices[code])}（${code}）` : undefined;
}

export type DeviceAccount={authMode:string;loggedIn:boolean;paired:boolean;user?:{id:string;username?:string}|null;deviceId?:string;deviceKey?:string;storageError?:string;authorizationError?:string;remoteAvailable?:boolean;connectionError?:string;gatewayUrl?:string;connectionMode?:'lan'|'relay'|null;relayAvailable?:boolean};
const errors:Record<string,MessageKey>={
  PAIR_BUNDLE_INVALID: "一体配对码不完整或格式错误，请重新复制完整内容。",
  PAIR_BUNDLE_EXPIRED: "一体配对码已过期，请管理员重新生成。",
  PAIR_BUNDLE_CA_INVALID: "配对码中的中央证书无效，请管理员重新生成。",
  PAIR_GATEWAY_OVERRIDDEN: "开发环境覆盖了中央地址，请移除覆盖后再使用一体配对。",
  AUTH_REQUIRED: "本机授权已失效，请向管理员领取新的配对码后重新配对。",
  DEVICE_REVOKED: "管理员已撤销本设备授权，请领取新的配对码后重新配对。",
  DEVICE_TOKEN_INVALID: "本机授权已失效，请向管理员领取新的配对码后重新配对。",
  AUTH_MODE_UNSUPPORTED: "当前中央不支持设备配对，请管理员核对中央地址和服务版本。",
  PAIR_CODE_INVALID: "配对码无效、已使用或已过期，请向管理员领取新的配对码。",
  PAIR_CODE_EXPIRED: "配对码已过期，请向管理员领取新的配对码。",
  PAIR_CODE_USED: "配对码已使用，请向管理员领取新的配对码。",
  INVALID_PAIR_CODE: "配对码无效、已使用或已过期，请向管理员领取新的配对码。",
  PAIR_INPUT_INVALID: "配对码和本机设备名称不能为空或过长。请检查这两项后重试。",
  RATE_LIMITED: "尝试过于频繁，请稍后重试。",
  DEVICE_LIMIT: "设备数量已达上限，请管理员在中央处理后重试。",
  DEVICE_TOKEN_STORAGE_UNSAFE: "本机授权存储的路径或权限不符合要求，暂时无法配对。请修复本机存储后重试。",
  DEVICE_TOKEN_STORAGE_CORRUPT: "本机保存的授权已损坏。请取消本机配对；若未确认中央撤销，请管理员处理后再使用新的配对码。",
  DEVICE_TOKEN_STORAGE_UNAVAILABLE: "无法读取或保存本机授权。请检查本机应用目录权限和磁盘空间，再重新读取配对状态。",
  PAIRING_RESULT_UNKNOWN: "操作结果尚未确认，请重新读取配对状态后再继续；不要重复使用刚才的配对码。",
};
export function devicePairingMessage(error:unknown):UiMessage{
  const transport = centralTransportMessage(error);if(transport)return transport;
  const raw=error instanceof Error?error.message:String(error);
  const code=Object.keys(errors).find(key=>new RegExp("\\b"+key+"\\b").test(raw));if(code)return uiMessage(errors[code]);
  if(/TLS|证书|主机名/.test(raw))return uiMessage("中央连接或服务端证书验证失败。请核对中央地址、网络和管理员提供的 CA 证书。");
  if(/timeout|超时|离线|连接/i.test(raw))return uiMessage("暂时无法连接中央。请检查网络和中央地址，然后重试。");
  return uiMessage("本机配对操作未完成，请重新读取状态，并核对中央地址、配对码和本机存储。");
}
export function devicePairingError(error: unknown): string { return formatMessage(devicePairingMessage(error)); }
export function deviceAuthorization(account:DeviceAccount){
  const hasLocalPairing=Boolean(account.paired||account.deviceId);
  const unsupported=account.authMode!=="device-token-v1";
  const problem=account.storageError?devicePairingError(account.storageError):unsupported?t(errors.AUTH_MODE_UNSUPPORTED):account.authorizationError?devicePairingError(account.authorizationError):account.remoteAvailable===false?devicePairingError(account.connectionError??t("中央连接不可用")):"";
  const localValid=account.paired&&!account.storageError&&!account.authorizationError&&!unsupported;
  const valid=localValid&&account.remoteAvailable!==false;
  const canPair=!account.storageError&&!unsupported&&(!account.paired||Boolean(account.authorizationError));
  const notice=localValid?account.remoteAvailable===false?t("本机配对已保存，暂时无法确认中央授权。"):t("本机已完成配对，连接状态见上方。"):hasLocalPairing?t("本机授权暂不可用。"):t("粘贴管理员提供的一体配对码，即可授权并连接本机。");
  return {hasLocalPairing,valid,canPair,notice,problem};
}

export function centralTransportMessage(value: unknown): UiMessage | undefined {
  const code = centralTransportCode(value);
  return code ? uiMessage("{{detail}}（{{code}}）", { detail: uiMessage(notices[code]), code }) : undefined;
}
