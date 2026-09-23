// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t } from "./i18n.ts";

import { invoke } from "./native-invoke";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeMode = "dark" | "light" | "system";
export const settingsStorageKey = "codexia.desktop.settings.v1";
let nativeThemeSync = Promise.resolve();

export function resolveTheme(theme: ThemeMode, darkSystem: boolean): "dark" | "light" {
  return theme === "system" ? (darkSystem ? "dark" : "light") : theme;
}

export function applyTheme(theme: ThemeMode) {
  const resolved = resolveTheme(theme, window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  // Keep native controls in the selected theme, then pin the caption background
  // to the sidebar token so Windows activation changes cannot replace its color.
  if (isTauri()) {
    const color = getComputedStyle(document.documentElement).getPropertyValue("--shell").trim();
    nativeThemeSync = nativeThemeSync.then(async () => {
      await getCurrentWindow().setTheme(theme === "system" ? null : theme);
      await invoke("set_window_caption_color", { color });
    }).catch(error => {
      console.warn(t("无法同步窗口标题栏主题"), error);
    });
  }
}

export function initializeTheme() {
  let theme: ThemeMode = "light";
  try {
    const saved = JSON.parse(window.localStorage.getItem(settingsStorageKey) ?? "null")?.theme;
    if (saved === "light" || saved === "dark" || saved === "system") theme = saved;
  } catch { /* A corrupt or unavailable preference should use the light default. */ }
  applyTheme(theme);
}
