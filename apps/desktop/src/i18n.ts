// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import i18next from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { en } from "./locales/en.ts";
import { nativeEn } from "./locales/native-en.ts";
import { useCallback, useState } from "react";

export type Language = "zh-CN" | "en";
export type MessageKey = keyof typeof en | keyof typeof nativeEn;
export type MessageValues = Record<string, unknown>;
export const languageStorageKey = "yuanzhou.desktop.language.v1";
const english = { ...en, ...nativeEn };
const zh = { ...Object.fromEntries(Object.keys(english).map(key => [key, key])),
  "聊天数量": "{{count}} 个聊天", "聊天数量_other": "{{count}} 个聊天",
  "完成操作数量": "已完成 {{count}} 项操作", "完成操作数量_other": "已完成 {{count}} 项操作",
  "展开项目数量": "展开 {{count}} 项", "展开项目数量_other": "展开 {{count}} 项",
  "对象 {{{p0}}}": "对象 { {{p0}} }",
};
export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  resources: { "zh-CN": { translation: zh }, en: { translation: english } },
  lng: "zh-CN", fallbackLng: "zh-CN", supportedLngs: ["zh-CN", "en"],
  keySeparator: false, nsSeparator: false, initAsync: false,
  interpolation: { escapeValue: false }, react: { useSuspense: false },
});

export function t(key: MessageKey, values?: MessageValues): string {
  return i18n.t(key, values as Record<string, string>);
}
export function useLocale(): Language {
  useTranslation(undefined, { i18n });
  return currentLanguage();
}
export function currentLanguage(): Language { return i18n.language === "en" ? "en" : "zh-CN"; }
const validLanguage = (value: unknown): Language => value === "en" ? "en" : "zh-CN";
function applyLanguage(language: Language) {
  document.documentElement.lang = language;
  void i18n.changeLanguage(language);
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Language preference operation timed out")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
export async function initializeLanguage(): Promise<void> {
  let language: Language = "zh-CN";
  try {
    language = isTauri() ? validLanguage(await bounded(invoke("desktop_language")))
      : validLanguage(localStorage.getItem(languageStorageKey));
  } catch { /* Unavailable or invalid preferences keep the existing Chinese default. */ }
  applyLanguage(language);
}
export async function setLanguage(language: Language): Promise<void> {
  // Persist before changing the UI. Failure leaves the previous language selected.
  if (isTauri()) await bounded(invoke("set_desktop_language", { language }));
  else localStorage.setItem(languageStorageKey, language);
  applyLanguage(language);
}

/** App-owned messages keep their key and parameters until rendering. Raw external
 * errors remain strings and are never translated by matching their content. */
export interface LocalizedMessage { key: MessageKey; values?: MessageValues }
export type UiMessage = string | LocalizedMessage;
export const message = (key: MessageKey, values?: MessageValues): LocalizedMessage => ({ key, values });
export function text(message: UiMessage | undefined): string {
  if (!message) return "";
  return typeof message === "string" ? message : t(message.key, Object.fromEntries(
    Object.entries(message.values ?? {}).map(([key, value]) => [key,
      value && typeof value === "object" && "key" in value ? text(value as LocalizedMessage) : value]),
  ));
}
export class UiError extends Error {
  readonly localized: LocalizedMessage;
  constructor(key: MessageKey, values?: MessageValues) {
    super(text(message(key, values)));
    this.localized = message(key, values);
    this.name = "UiError";
  }
}
export function errorMessage(error: unknown): UiMessage {
  return error instanceof UiError ? error.localized : error instanceof Error ? error.message : String(error);
}

export function useMessageState(initial: UiMessage = "") {
  useLocale();
  const [value, setValue] = useState<UiMessage>(initial);
  const setMessage = useCallback((next: UiMessage | ((current: string) => UiMessage)) => {
    setValue(current => typeof next === "function" ? next(text(current)) : next);
  }, []);
  return [text(value), setMessage] as const;
}
