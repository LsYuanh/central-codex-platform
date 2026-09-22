// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { useTrayNewConversation } from "../../apps/desktop/src/use-tray-new-conversation";

const qa = window as any;
qa.isTauri = true;
qa.trayQa = { enabled: false, fail: false, opened: [] as string[] };
mockWindows("main");
mockIPC((command, args: any) => {
  if (command === "set_tray_new_conversation_enabled") {
    if (qa.trayQa.fail) throw Error("菜单不可用");
    qa.trayQa.enabled = args.enabled;
  }
}, { shouldMockEvents: true });
qa.fireTray = () => emit("desktop-new-conversation");
function Listener({ enabled, draft, error }: { enabled: boolean; draft: string; error: (s: string) => void }) {
  useTrayNewConversation(enabled, () => { qa.trayQa.opened.push(draft); }, error);
  return null;
}
function Fixture() {
  const [enabled, setEnabled] = useState(true), [draft, setDraft] = useState("原草稿");
  const [mounted, setMounted] = useState(true), [error, setError] = useState("");
  return <>
    <input aria-label="草稿" value={draft} onChange={e => setDraft(e.target.value)} />
    <button onClick={() => setEnabled(x => !x)}>切换可用</button>
    <button onClick={() => setMounted(x => !x)}>切换挂载</button>
    <p role="alert">{error}</p>
    {mounted && <Listener enabled={enabled} draft={draft} error={setError} />}
  </>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
