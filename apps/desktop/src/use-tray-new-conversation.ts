// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t } from "./i18n.ts";

import { invoke } from "./native-invoke";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function useTrayNewConversation(enabled: boolean, open: () => void, onError: (message: string) => void) {
  const latest = useRef({ enabled, open, onError });
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => { latest.current = { enabled, open, onError }; });
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().listen("desktop-new-conversation", () => {
      if (!disposed && latest.current.enabled) latest.current.open();
    }).then(stop => {
      if (disposed) stop();
      else { unlisten = stop; setReady(true); }
    }).catch(error => { if (!disposed) latest.current.onError(t("托盘新对话不可用：{{p0}}", { p0: String(error) })); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    if (!isTauri() || !ready) return;
    void invoke("set_tray_new_conversation_enabled", { enabled }).catch(error => {
      latest.current.onError(t("托盘菜单更新失败：{{p0}}", { p0: String(error) }));
    });
  }, [enabled, ready]);
}
