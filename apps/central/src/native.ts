// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { invoke, isTauri } from "@tauri-apps/api/core";

export type NativeContext = { dataDirectory: string; platform: string; runtimeAvailable: false; reason: string };
export const nativeAvailable = isTauri();
export async function nativeCall<T>(command: string, timeoutMs = 10000, args?: Record<string, unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invoke<T>(command, args),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject({ code: "OPERATION_TIMEOUT", recoverable: true, diagnosticId: "ui-timeout" }), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
