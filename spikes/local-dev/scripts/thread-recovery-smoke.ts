// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import {recoverInitialThread, threadRecoveryError, unavailableThreadNotice} from "../apps/desktop/src/thread-recovery.ts";

const calls: string[] = [];
const rejected = await recoverInitialThread({
  async threadResume(id: string) { calls.push(`resume:${id}`); throw Error("REMOTE_WORKSPACE_CHANGED: thread belongs to another device"); },
  async threadRead(id: string) { calls.push(`read:${id}`); return {}; },
}, "previous-device-thread", () => true);
assert.deepEqual(rejected, {state: "unavailable", notice: unavailableThreadNotice});
assert.deepEqual(calls, ["resume:previous-device-thread"], "Do not read or automatically retry another device's Thread");

const normal = await recoverInitialThread({
  async threadResume() {}, async threadRead(id: string) { return {result: {thread: {id}}}; },
}, "current-device-thread", () => true);
assert.deepEqual(normal, {state: "restored", history: {result: {thread: {id: "current-device-thread"}}}});

await assert.rejects(recoverInitialThread({
  async threadResume() { throw Error("AUTH_REQUIRED"); }, async threadRead() { return {}; },
}, "thread", () => true), /AUTH_REQUIRED/, "A login/transport failure must not be treated as a harmless Thread binding rejection");
assert.equal(threadRecoveryError(Error("socket disconnected")), "socket disconnected");

let read = false;
const superseded = await recoverInitialThread({
  async threadResume() {}, async threadRead() { read = true; return {}; },
}, "old-connection-thread", () => false);
assert.deepEqual(superseded, {state: "superseded"});assert.equal(read, false);
assert.equal(threadRecoveryError(Error("REMOTE_WORKSPACE_CHANGED: workspaceRoot")), unavailableThreadNotice);
console.log("THREAD_RECOVERY_SMOKE_OK");
