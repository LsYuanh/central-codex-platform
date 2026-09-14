// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import { reduceConversationEvent, isProcessMessage, groupConversation, compactConversationRows } from "../apps/desktop/src/conversation-content.ts";
import { messagesFromThreadRead } from "../apps/desktop/src/thread-history.ts";
import { appendStreamDelta } from "../apps/desktop/src/chat-stream.ts";
import type { ChatMessage } from "../apps/desktop/src/gateway-ui-events.ts";

let rows: ChatMessage[] = [{ id: "u", role: "user", content: "任务", turnId: "t" }];
let sequence = 0;
function emit(method: string, params: object) {
  rows = reduceConversationEvent(rows, { method, params, sequence: ++sequence }, "t") ?? rows;
}
emit("item/started", { item: { id: "r", type: "reasoning", summary: [], content: ["RAW_PRIVATE_TEXT"] } });
emit("item/reasoning/summaryPartAdded", { itemId: "r", summaryIndex: 0 });
emit("item/reasoning/summaryTextDelta", { itemId: "r", summaryIndex: 0, delta: "先检查" });
const repeated = { method: "item/reasoning/summaryTextDelta", params: { itemId: "r", summaryIndex: 0, delta: "先检查" }, sequence };
assert.deepEqual(reduceConversationEvent(rows, repeated, "t"), rows, "replayed summary must not duplicate text");
emit("item/reasoning/summaryTextDelta", { itemId: "r", summaryIndex: 1, delta: "再验证" });
emit("item/completed", { item: { id: "r", type: "reasoning", summary: ["检查后验证"], content: ["RAW_PRIVATE_TEXT"] } });
assert.equal(rows[1].content, "检查后验证");
emit("item/reasoning/summaryTextDelta", { itemId: "r", summaryIndex: 0, delta: "late" });
assert.equal(rows[1].content, "检查后验证", "completed summaries ignore late deltas");
emit("item/started", { item: { id: "c", type: "agentMessage", text: "", phase: "commentary" } });
rows = appendStreamDelta(rows, "正在处理", "c", "t");
emit("item/completed", { item: { id: "c", type: "agentMessage", text: "处理说明", phase: "commentary" } });
rows = appendStreamDelta(rows, "late", "c", "t");
assert.equal(rows.find(row => row.id === "assistant-c")?.content, "处理说明");
assert(isProcessMessage(rows[2]), "Progress commentary folds with the thinking and execution process");
rows.push({ id: "steer", role: "user", content: "追加要求", turnId: "t" });
emit("item/completed", { item: { id: "search", type: "webSearch", status: "completed" } });
emit("item/started", { item: { id: "f", type: "agentMessage", text: "", phase: "final_answer" } });
rows = appendStreamDelta(rows, "最终", "f", "t");
emit("item/completed", { item: { id: "f", type: "agentMessage", text: "最终结果", phase: "final_answer" } });
assert.equal(rows.filter(row => row.id === "assistant-f").length, 1);
assert(!isProcessMessage(rows.at(-1)!));
assert(!JSON.stringify(rows).includes("RAW_PRIVATE_TEXT"));
assert(!isProcessMessage({ id: "legacy", role: "assistant", content: "旧回复" }));
const history = messagesFromThreadRead({ thread: { turns: [{ id: "t", items: [
  { id: "u", type: "userMessage", content: [{ type: "inputText", text: "任务" }] },
  { id: "r", type: "reasoning", summary: ["检查后验证"], content: ["RAW_PRIVATE_TEXT"] },
  { id: "c", type: "agentMessage", phase: "commentary", text: "处理说明" },
  { id: "search", type: "webSearch", status: "completed" },
  { id: "f", type: "agentMessage", phase: "final_answer", text: "最终结果" },
  { type: "reasoning", content: ["RAW_PRIVATE_TEXT"] },
] }] } });
assert.deepEqual(history.map(row => row.id), ["u", "process-r", "assistant-c", "process-search", "assistant-f"]);
assert(!JSON.stringify(history).includes("RAW_PRIVATE_TEXT"));
assert.equal(history.filter(isProcessMessage).length, 3);
const grouped = groupConversation([...rows, { id: "u2", role: "user", content: "下一轮", turnId: "t2" }, { id: "file", role: "assistant", content: "", turnId: "t", outputs: [] }]);
assert.equal(grouped.length, 2);
assert.equal(grouped[0].messages.at(-1)?.id, "file", "late output retains its original turn");
console.log("CONVERSATION_CONTENT_SMOKE_OK: phases, summaries, replay, late deltas, history, tools, legacy, turn grouping");

const notices: ChatMessage[] = [
 {id:"missing-failure",role:"assistant",kind:"tool",content:"请求客户端工具 · device_exec",itemStatus:"failed"},
 {id:"notice",role:"assistant",kind:"tool",content:"请求客户端工具 · device_exec",itemStatus:"completed"},
 {id:"detail",role:"assistant",kind:"execution",content:"",executionId:"one"},
 {id:"unmatched",role:"assistant",kind:"tool",content:"请求客户端工具 · device_exec",itemStatus:"completed"},
];
assert.deepEqual(compactConversationRows(notices,[{requestId:"one",tool:"device_exec",status:"succeeded"} as never]).map(r=>r.id),["missing-failure","detail","unmatched"]);
assert.deepEqual(compactConversationRows(notices,[]).map(r=>r.id),["missing-failure","notice","unmatched"]);
