// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { resolve } from "node:path";

const windows = process.platform === "win32";
export const localAgentExecutable = (root = process.cwd()) => resolve(root, process.env.LOCAL_AGENT_BIN ?? `target/debug/local-agent${windows ? ".exe" : ""}`);
export const locationCommand = windows
  ? { program: "powershell", args: ["-NoProfile", "-Command", "(Get-Location).Path"] }
  : { program: "/bin/sh", args: ["-c", "pwd -P"] };
export const failureCommand = windows
  ? { program: "powershell", args: ["-NoProfile", "-Command", "exit 3"] }
  : { program: "/bin/sh", args: ["-c", "exit 3"] };
export const streamingCommand = windows
  ? { program: "powershell", args: ["-NoProfile", "-Command", "Write-Output stream-first; Start-Sleep -Milliseconds 500; [Console]::Error.WriteLine('stream-error'); Write-Output stream-second"] }
  : { program: "/bin/sh", args: ["-c", "printf 'stream-first\\n'; sleep 0.5; printf 'stream-error\\n' >&2; printf 'stream-second\\n'"] };
