// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
export const unavailableThreadNotice = "该对话绑定的设备或工作区已变化，当前设备无法恢复。请新建对话，或选择属于本机的对话。";

function isBindingRejection(error: unknown): boolean {
  return /\b(REMOTE_WORKSPACE_CHANGED|PROJECT_DIRECTORY_UNAVAILABLE)\b/.test(error instanceof Error ? error.message : String(error));
}

export function threadRecoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("PROJECT_DIRECTORY_UNAVAILABLE")) return "该对话的项目目录不可用，请恢复原目录后重试，或选择其他项目新建对话。中央连接仍可使用。";
  return isBindingRejection(error) ? unavailableThreadNotice : message;
}

type Recovery<T> = { state: "restored"; history: T } | { state: "unavailable"; notice: string } | { state: "superseded" };

/** A Thread's execution binding may be stale after pairing a new device.
 * Leave that Thread unselected; its rejection does not invalidate the gateway.
 * Login, transport and other protocol errors remain connection failures.
 */
export async function recoverInitialThread<T>(
  client: { threadResume(id: string): Promise<unknown>; threadRead(id: string): Promise<T> },
  threadId: string,
  current: () => boolean,
): Promise<Recovery<T>> {
  try {
    await client.threadResume(threadId);
    if (!current()) return { state: "superseded" };
    const history = await client.threadRead(threadId);
    return current() ? { state: "restored", history } : { state: "superseded" };
  } catch (error) {
    if (!current()) return { state: "superseded" };
    if (!isBindingRejection(error)) throw error;
    return { state: "unavailable", notice: threadRecoveryError(error) };
  }
}
