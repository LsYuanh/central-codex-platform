// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { nativeCall } from './native';

export type PublicUser = { id: string; username: string; role: 'admin' | 'user'; disabled: boolean; loginMode: 'password' | 'pairing-only' };
export type PublicDevice = { id: string; userId: string; name: string; revoked: boolean; online: boolean; createdAt: number | null; lastSeenAt: number | null; authMode: 'device-token-v1' | 'legacy-mtls-v1' };
export type PeopleStatus = { instanceId: string | null; serviceState: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'; authenticated: boolean; admin: PublicUser | null; expiresAt: number | null };
export type PeopleInventory = { instanceId: string; users: PublicUser[]; devices: PublicDevice[] };
export type Pairing = { authMode: 'device-token-v1'; code: string; connectionCode?: string; expiresAt: number; expiresIn: number };
export type MutationResult = { instanceId: string; requestId: string; user: PublicUser | null; pairing: Pairing | null; disabled: boolean; revoked: boolean };
export type Mutation = 'create_user' | 'disable_user' | 'pair_code' | 'revoke_device';
export const PEOPLE_INVENTORY_TTL = 15000;
export function peopleSessionValid(status: PeopleStatus | null, now: number): boolean {
  return !!status?.authenticated && status.serviceState === 'running' && !!status.instanceId && status.admin?.role === 'admin' && !status.admin.disabled && (status.expiresAt ?? 0) > now;
}
export function peopleInventoryFresh(status: PeopleStatus | null, inventory: PeopleInventory | null, loadedAt: number, now: number): boolean {
  return peopleSessionValid(status, now) && !!inventory && inventory.instanceId === status?.instanceId && loadedAt > 0 && now >= loadedAt && now - loadedAt <= PEOPLE_INVENTORY_TTL;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 8_640_000_000_000_000;
const optionalTime = (value: unknown): value is number | null | undefined => value == null || time(value);
const invalid = () => ({ code: 'PEOPLE_PROTOCOL_INVALID' });

export function readPublicUser(value: unknown): PublicUser {
  if (!object(value) || !text(value.id) || !text(value.username, 64) || !['admin', 'user'].includes(String(value.role)) || typeof value.disabled !== 'boolean' || !['password', 'pairing-only'].includes(String(value.loginMode))) throw invalid();
  return { id: value.id, username: value.username, role: value.role as PublicUser['role'], disabled: value.disabled, loginMode: value.loginMode as PublicUser['loginMode'] };
}
export function readPeopleStatus(value: unknown): PeopleStatus {
  if (!object(value) || (value.instanceId != null && !text(value.instanceId)) || !['stopped', 'starting', 'running', 'stopping', 'failed'].includes(String(value.serviceState)) || typeof value.authenticated !== 'boolean' || !optionalTime(value.expiresAt)) throw invalid();
  const admin = value.admin == null ? null : readPublicUser(value.admin);
  if (value.authenticated && (!admin || admin.disabled || admin.role !== 'admin' || !value.instanceId || value.serviceState !== 'running' || !time(value.expiresAt))) throw invalid();
  return { instanceId: value.instanceId as string | null ?? null, serviceState: value.serviceState as PeopleStatus['serviceState'], authenticated: value.authenticated, admin: value.authenticated ? admin : null, expiresAt: value.authenticated ? value.expiresAt as number : null };
}
export function readPeopleInventory(value: unknown, instanceId: string): PeopleInventory {
  if (!object(value) || value.instanceId !== instanceId || !Array.isArray(value.users) || !Array.isArray(value.devices) || value.users.length > 10000 || value.devices.length > 50000) throw invalid();
  const users = value.users.map(readPublicUser), ids = new Set(users.map(user => user.id));
  if (ids.size !== users.length) throw invalid();
  const devices = value.devices.map((entry): PublicDevice => {
    if (!object(entry) || !text(entry.id) || !text(entry.userId) || !ids.has(entry.userId) || !text(entry.name, 128) || typeof entry.revoked !== 'boolean' || typeof entry.online !== 'boolean' || !optionalTime(entry.createdAt) || !optionalTime(entry.lastSeenAt) || !['device-token-v1', 'legacy-mtls-v1'].includes(String(entry.authMode))) throw invalid();
    return { id: entry.id, userId: entry.userId, name: entry.name, revoked: entry.revoked, online: entry.online, createdAt: entry.createdAt ?? null, lastSeenAt: entry.lastSeenAt ?? null, authMode: entry.authMode as PublicDevice['authMode'] };
  });
  if (new Set(devices.map(device => device.id)).size !== devices.length) throw invalid();
  return { instanceId, users, devices };
}
export function readMutationResult(value: unknown, instanceId: string, requestId: string): MutationResult {
  if (!object(value) || value.instanceId !== instanceId || value.requestId !== requestId || typeof value.disabled !== 'boolean' || typeof value.revoked !== 'boolean') throw invalid();
  let pairing: Pairing | null = null;
  if (value.pairing != null) {
    const pair = value.pairing;
    if (!object(pair) || pair.authMode !== 'device-token-v1' || !text(pair.code, 256) || !time(pair.expiresAt) || !Number.isSafeInteger(pair.expiresIn) || (pair.expiresIn as number) < 1 || (pair.expiresIn as number) > 300) throw invalid();
    if (pair.connectionCode != null && (!text(pair.connectionCode, 98304) || !/^yzpair1\.[A-Za-z0-9_-]+$/.test(pair.connectionCode))) throw invalid();
    pairing = { authMode: 'device-token-v1', code: pair.code, connectionCode: pair.connectionCode as string | undefined, expiresAt: pair.expiresAt, expiresIn: pair.expiresIn as number };
  }
  return { instanceId, requestId, user: value.user == null ? null : readPublicUser(value.user), pairing, disabled: value.disabled, revoked: value.revoked };
}

export const peopleStatus = async () => readPeopleStatus(await nativeCall<unknown>('central_people_status', 20000));
export const peopleLogin = async (expectedInstanceId: string, username: string, password: string) => readPeopleStatus(await nativeCall<unknown>('central_people_login', 20000, { expectedInstanceId, username, password }));
export const peopleLogout = async (expectedInstanceId: string) => readPeopleStatus(await nativeCall<unknown>('central_people_logout', 40000, { expectedInstanceId }));
// authorize refresh + users + devices are serialized native HTTP calls (15s
// each), so a read-only inventory may need more time than a single mutation.
export const peopleList = async (expectedInstanceId: string) => readPeopleInventory(await nativeCall<unknown>('central_people_list', 50000, { expectedInstanceId }), expectedInstanceId);
export async function peopleMutation(command: Mutation, expectedInstanceId: string, requestId: string, target: { username?: string; userId?: string; deviceId?: string; lanOnly?: boolean }): Promise<MutationResult> {
  return readMutationResult(await nativeCall<unknown>(`central_people_${command}`, 40000, { expectedInstanceId, requestId, ...target }), expectedInstanceId, requestId);
}
export function peopleCode(cause: unknown): string {
  return object(cause) && typeof cause.code === 'string' ? cause.code : 'PEOPLE_REQUEST_FAILED';
}
export function peopleOutcomeUnknown(cause: unknown) { return ['OUTCOME_UNKNOWN', 'OPERATION_TIMEOUT', 'PEOPLE_PROTOCOL_INVALID', 'PEOPLE_REQUEST_FAILED', 'REQUEST_ID_CONFLICT', 'REQUEST_EXPIRED'].includes(peopleCode(cause)); }
export function peopleMessage(cause: unknown): string {
  const messages: Record<string, string> = {
    RELAY_NOT_READY: '公网中继尚未就绪，请到运行概览检查连接状态后再生成配对码。',
    RELAY_STORAGE_FAILED: '公网中继配置读取失败，请检查本机配置。',
    OUTCOME_UNKNOWN: '操作结果尚未确认。请刷新核对，不要重复提交。',
    OPERATION_TIMEOUT: '等待已超时，原生操作可能仍在进行。请刷新核对，不要重复提交。',
    ADMIN_AUTH_REQUIRED: '管理员会话已失效，请重新登录。',
    AUTH_REQUIRED: '管理员会话已失效，请重新登录。',
    ADMIN_ROLE_REQUIRED: '此账号没有管理员权限。',
    SERVICE_INSTANCE_MISMATCH: '中央服务实例已变化，请刷新并重新登录。',
    SERVICE_NOT_RUNNING: '中央服务尚未运行，请到运行概览启动服务。',
    PEOPLE_SERVICE_UNAVAILABLE: '原生层无法确认当前受管服务，请到运行概览核对服务状态，再刷新。',
    PEOPLE_NETWORK_FAILED: '无法通过受信连接读取中央服务，请检查服务与证书后刷新。',
    PEOPLE_TARGET_NOT_LOCAL: '配置的管理地址无法确认为本机，请核对中央服务的连接设置。',
    PEOPLE_TARGET_UNSAFE: '配置的管理地址未通过原生校验，请核对监听地址、端口和客户端地址。',
    PEOPLE_TLS_INVALID: '无法建立受信 TLS 连接，请核对已导入证书和连接地址。',
    PEOPLE_REQUEST_INVALID: '输入未通过原生校验，请核对用户名或所选目标后重试。',
    REQUEST_ID_CONFLICT: '操作编号与既有请求冲突，结果需要核对；请刷新，不要重复提交。',
    REQUEST_EXPIRED: '这项操作的回执已过期，结果需要核对；请刷新，不要重复提交。',
    SESSION_LIMIT: '管理员会话数量已达上限，请结束不再使用的会话后再登录。',
    OPERATION_BUSY: '原生层正在处理上一项操作，请稍后刷新。',
    INVALID_CREDENTIALS: '管理员账号或密码不正确。',
    AUTH_FAILED: '管理员账号或密码不正确。',
    RATE_LIMITED: '请求过于频繁，请稍后再试。',
    INVALID_OR_EXISTING_ACCOUNT: '用户名不符合要求或已经存在。',
    USERNAME_TAKEN: '此用户名已经存在，请核对用户清单。',
    SELF_DISABLE_FORBIDDEN: '不能停用当前登录的管理员。',
    NOT_FOUND: '目标已变化或不存在，请刷新清单。',
    PEOPLE_PROTOCOL_INVALID: '原生响应无法验证，已停止使用此结果。请刷新核对。',
  };
  return messages[peopleCode(cause)] ?? '操作未完成。请刷新核对服务和管理员会话后再操作。';
}
