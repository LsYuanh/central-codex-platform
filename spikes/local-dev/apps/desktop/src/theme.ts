// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeMode = "dark" | "light" | "system";
export const settingsStorageKey = "codexia.desktop.settings.v1";

export function resolveTheme(theme: ThemeMode, darkSystem: boolean): "dark" | "light" {
  return theme === "system" ? (darkSystem ? "dark" : "light") : theme;
}

export function applyTheme(theme: ThemeMode) {
  const resolved = resolveTheme(theme, window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  // CSS cannot style the native title bar. Clear the native override for
  // system mode so Windows can keep following its own appearance changes.
  if (isTauri()) {
    void getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(error => {
      console.warn("无法同步窗口标题栏主题", error);
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
