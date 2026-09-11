// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import { TurnTimingStore, formatTurnDuration, timingAnchors, timingScope } from "../apps/desktop/src/turn-timing.ts";
import { messagesFromThreadRead } from "../apps/desktop/src/thread-history.ts";
import { appendStreamDelta } from "../apps/desktop/src/chat-stream.ts";

const data = new Map<string, string>();
const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
const now = 1_800_000_000_000;
const store = new TurnTimingStore(storage);
const scope = timingScope("ws://central:4510/ws?userId=alice&token=secret");
assert(!scope.includes("secret"));
store.useScope(scope);
store.observe("a", { id: "1" }, "start", now);
store.observe("b", { id: "1" }, "start", now + 1000);
store.observe("a", { id: "1" }, "start", now + 5000);
assert.equal(store.get("a", "1")?.startedAt, now, "replayed start/steering must not reset elapsed time");
store.observe("a", { id: "1", status: "completed" }, "finish", now + 115000);
store.observe("a", { id: "1", status: "completed" }, "finish", now + 150000);
assert.equal(store.get("a", "1")?.durationMs, 115000, "duplicate completion must freeze duration");
assert.equal(store.get("b", "1")?.status, "running", "thread isolation");
store.observe("b", { id: "1", status: "interrupted" }, "finish", now + 120000);
assert.equal(store.get("b", "1")?.durationMs, 119000);

const reopened = new TurnTimingStore(storage);
reopened.useScope(scope);
reopened.observe("a", { id: "1", status: "completed" }, "history", now + 999000);
assert.equal(reopened.get("a", "1")?.durationMs, 115000, "history read time must not extend completed duration");
reopened.observe("a", { id: "old", status: "completed" }, "history", now);
assert.equal(reopened.get("a", "old"), undefined, "old history without timing stays untouched");
reopened.observe("a", { id: "server", status: "completed", startedAt: now / 1000, completedAt: (now + 65000) / 1000 }, "history", now);
assert.equal(reopened.get("a", "server")?.durationMs, 65000, "accept explicit protocol timestamps");
reopened.observe("a", { id: "duration", status: "failed", durationMs: 4000 }, "history", now);
assert.equal(reopened.get("a", "duration")?.status, "failed");
reopened.observe("a", { id: "invalid", status: "completed", durationMs: -5 }, "history", now);
assert.equal(reopened.get("a", "invalid"), undefined);
reopened.observe("a", { id: "skew", startedAt: now + 600000 }, "start", now);
reopened.observe("a", { id: "skew", status: "completed" }, "finish", now + 5000);
assert.equal(reopened.get("a", "skew")?.durationMs, 5000, "local fallback never mixes server and client clocks");
reopened.observe("a", { id: "server-end", startedAt: now + 600000 }, "start", now);
reopened.observe("a", { id: "server-end", status: "completed", completedAt: now + 606000 }, "finish", now + 5000);
assert.equal(reopened.get("a", "server-end")?.durationMs, 6000, "pair timestamps from the same server clock");

reopened.observe("a", { id: "offline" }, "start", now);
reopened.uncertain();
reopened.observe("a", { id: "offline", status: "completed" }, "history", now + 100000);
assert.equal(reopened.get("a", "offline")?.durationMs, undefined, "do not invent an offline finish time");
reopened.observe("a", { id: "resume" }, "start", now);
const restarted = new TurnTimingStore(storage);
restarted.useScope(scope);
assert.equal(restarted.get("a", "resume")?.status, "unknown");
restarted.observe("a", { id: "resume", status: "inProgress" }, "history", now + 3000);
restarted.observe("a", { id: "resume", status: "completed" }, "finish", now + 9000);
assert.equal(restarted.get("a", "resume")?.durationMs, 9000, "confirmed running turn resumes its original clock");
restarted.useScope(timingScope("ws://central:4510/ws?userId=bob"));
assert.equal(restarted.forThread("a").length, 0, "account caches must remain isolated");

const rows = messagesFromThreadRead({ thread: { turns: [{ id: "1", status: "completed", items: [
  { id: "u", type: "userMessage", content: [{ type: "inputText", text: "任务" }] },
  { id: "progress", type: "agentMessage", text: "正在检查" },
  { id: "final", type: "agentMessage", text: "已完成" },
] }] } });
assert(rows.every(row => row.turnId === "1"));
assert.deepEqual([...timingAnchors(rows, store.forThread("a")).keys()], ["assistant-final"], "only the final reply gets a timing header");
assert.deepEqual([...timingAnchors([{ id: "empty", role: "system", content: "", turnId: "1", timingOnly: true }], store.forThread("b")).keys()], ["empty"], "stopped turns with no output still get a summary");
let stream = appendStreamDelta([], "第一轮", "i1", "1");
stream = appendStreamDelta(stream, "下一轮", undefined, "2");
assert.equal(stream.length, 2, "do not merge separate turns when item ID is absent");
assert.equal(formatTurnDuration(115000), "1分 55秒");
assert.equal(formatTurnDuration(3600000), "1小时 0分 0秒");
assert.equal(formatTurnDuration(300), "0秒");
store.removeThread("a");
assert.equal(store.forThread("a").length, 0);
console.log("TURN_TIMING_SMOKE_OK: live timing, replay, background isolation, restart, history, offline uncertainty, stop, anchors");
