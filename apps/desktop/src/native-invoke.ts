// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { message, text, UiError, type UiMessage, type MessageKey } from "./i18n.ts";
import { nativeEn } from "./locales/native-en.ts";

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const templates = Object.keys(nativeEn).filter(key => key.includes("{{")).map(key => {
  const params = [...key.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]);
  const parts = key.split(/\{\{\w+\}\}/g).map(escape);
  return { key: key as MessageKey, params, pattern: new RegExp(`^${parts.join("([\\s\\S]+?)")}$`) };
});
/** Only call at native IPC boundaries, never on user/model text or tool output. */
export function nativeMessage(raw: string, depth = 0): UiMessage {
  if (Object.hasOwn(nativeEn, raw)) return message(raw as keyof typeof nativeEn);
  if (depth > 3) return raw;
  for (const template of templates) {
    const match = template.pattern.exec(raw);
    if (match) return message(template.key, Object.fromEntries(template.params.map((name, index) =>
      [name, nativeMessage(match[index + 1], depth + 1)])));
  }
  return raw;
}
export const nativeText = (raw?: string) => raw ? text(nativeMessage(raw)) : "";
export async function invoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try { return await nativeInvoke<T>(command, args, options); }
  catch (error) {
    const localized = typeof error === "string" ? nativeMessage(error) : error;
    if (localized && typeof localized === "object" && "key" in localized) {
      const value = localized as Exclude<UiMessage, string>;
      throw new UiError(value.key, value.values);
    }
    throw error;
  }
}
