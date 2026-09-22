// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export function initializeContextMenu(): () => void {
  // Cancel only the WebView menu, including in inputs and portaled dialogs.
  // Keep propagation so application menus can still handle the same event.
  const onContextMenu = (event: MouseEvent) => event.preventDefault();
  document.addEventListener("contextmenu", onContextMenu, true);
  return () => document.removeEventListener("contextmenu", onContextMenu, true);
}
