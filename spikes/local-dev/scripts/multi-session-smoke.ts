// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import { withThreadRunning, withThreadTurn } from "../apps/desktop/src/thread-session-state.ts";

let running = new Set<string>();
let turns = new Map<string, string>();

running = withThreadRunning(running, "thread-a", true);
turns = withThreadTurn(turns, "thread-a", "turn-a");
running = withThreadRunning(running, "thread-b", true);
turns = withThreadTurn(turns, "thread-b", "turn-b");
assert.deepEqual([...running].sort(), ["thread-a", "thread-b"]);
assert.equal(turns.get("thread-a"), "turn-a");
assert.equal(turns.get("thread-b"), "turn-b");

running = withThreadRunning(running, "thread-a", false);
turns = withThreadTurn(turns, "thread-a");
assert.deepEqual([...running], ["thread-b"], "completing A must not stop B");
assert.equal(turns.has("thread-a"), false);
assert.equal(turns.get("thread-b"), "turn-b");

running = withThreadRunning(running, "thread-b", false);
turns = withThreadTurn(turns, "thread-b");
assert.equal(running.size, 0, "cancelling B must clear only B");
assert.equal(turns.size, 0);
console.log("MULTI_SESSION_SMOKE_OK");

