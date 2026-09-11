// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import { DRAFT_KEY, emptyDraft, loadDraft, saveDraft, validateDraft } from "../apps/central/src/setup-draft.ts";

// Memory-only storage: never reads or writes the user's app/browser profile.
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem(key: string) { return values.get(key) ?? null; },
  setItem(key: string, value: string) { values.set(key, value); },
}, configurable: true });
const valid = { ...emptyDraft, dataDirectory: "C:\\Yuanzhou\\Central", host: "192.0.2.20", clientUrl: "wss://central.example:4510/ws" };
assert.deepEqual(validateDraft(valid), {});
for (const dataDirectory of ["", "C:\\", "C:\\..\\central", "\\\\server\\data", "C:\\data:stream", `C:\\${"a".repeat(4097)}`]) {
  assert.ok(validateDraft({ ...valid, dataDirectory }).dataDirectory, dataDirectory);
}
for (const host of ["0.0.0.0", "::", "0::"]) assert.deepEqual(validateDraft({ ...valid, host }), {}, "native-supported wildcard bind must round-trip");
for (const host of ["300.1.1.1", "localhost", "::bad::", "192.00.2.20"]) assert.ok(validateDraft({ ...valid, host }).host, host);
for (const clientUrl of ["ws://central.example:4510/ws", "wss://localhost:4510/ws", "wss://127.0.0.1:4510/ws", "wss://[::ffff:127.0.0.1]:4510/ws", "wss://central.example:4511/ws", "wss://central.example:4510/ws?token=example"]) {
  assert.ok(validateDraft({ ...valid, clientUrl }).clientUrl, clientUrl);
}
const saved = saveDraft(valid);
assert.deepEqual(loadDraft().draft, saved);
assert.throws(() => saveDraft({ ...valid, port: "80" }));
assert.deepEqual(loadDraft().draft, saved, "invalid save must preserve previous draft");
values.set(DRAFT_KEY, "invalid-json");
assert.ok(loadDraft().warning);
assert.equal(values.get(DRAFT_KEY), "invalid-json", "loading a corrupt draft must not overwrite it");
Object.defineProperty(globalThis, "localStorage", { get() { throw new Error("storage denied"); }, configurable: true });
assert.ok(loadDraft().warning);
assert.throws(() => saveDraft(valid));
console.log("Central UI draft smoke passed: validation boundaries, round-trip, corrupt/denied storage, preserving prior draft.");
