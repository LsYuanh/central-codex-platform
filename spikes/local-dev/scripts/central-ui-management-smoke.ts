// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import { readConfigResponse, readInspection, failureMessage, publicFailure, configSaveBlock, configToDraft, matchesDraft } from "../apps/central/src/central-management.ts";
const config = {
  schemaVersion: 1 as const, revision: 2, dataDirectory: "C:\\Central UI QA\\data",
  listen: { host: "127.0.0.1", port: 14522 }, clientUrl: "wss://central.example:14522/ws",
  tls: { certificateId: "qa-cert" }, runtimePackageId: "qa-package",
  limits: { maxWorkers: 8, perUserTurns: 2, totalTurns: 8 }, shutdown: { graceMs: 10000, forceMs: 5000 },
};
assert.equal(readConfigResponse({ initialized: false, config: null }).config, null);
assert.deepEqual(readConfigResponse({ initialized: true, config }).config, config);
for (const invalid of [null, {}, { initialized: false, config }, { initialized: true, config: null }, { initialized: true, config: { ...config, revision: -1 } }]) assert.throws(() => readConfigResponse(invalid));
assert.ok(matchesDraft(config, configToDraft(config)));
assert.equal(matchesDraft(config, { ...configToDraft(config), port: "14523" }), false);
const checks = ["package", "system", "port", "tls", "directory", "isolation"].map(component => ({ component, state: "not-checked", message: "未检查" }));
const inspection = { platform: "win32", configRevision: 2, inspectedAt: Date.now(), checks };
assert.deepEqual(readInspection(inspection), inspection);
assert.throws(() => readInspection({ ...inspection, checks: [] }), "empty results cannot imply success");
assert.throws(() => readInspection({ ...inspection, checks: checks.map(() => checks[0]) }), "duplicate components must not hide unchecked components");
assert.throws(() => readInspection({ ...inspection, checks: checks.map(check => ({ ...check, state: "ready" })) }));
assert.equal(failureMessage({ code: "constructor" }), failureMessage({ code: "unknown", message: "secret" }));
assert.ok(!failureMessage(new Error("secret credential value")).includes("secret"));
for (const code of ["SERVICE_ALREADY_ACTIVE", "SERVICE_CLEANUP_UNVERIFIED", "SERVICE_APP_CLOSING"]) {
  assert.equal(publicFailure({ code }).code, code, "known rejected saves must not become unknown results");
  assert.ok(failureMessage({ code }).includes("配置未保存"));
}
const stopped = { generation: 1, sequence: 1, state: "stopped" as const, cleanupVerified: true, forcedStop: false };
assert.equal(configSaveBlock(stopped), "");
assert.equal(configSaveBlock({ ...stopped, state: "failed" }), "");
assert.ok(configSaveBlock(null).includes("尚未确认"));
for (const state of ["starting", "running", "stopping"] as const) {
  assert.ok(configSaveBlock({ ...stopped, state, cleanupVerified: false }).includes("运行概览停止服务"));
}
assert.ok(configSaveBlock({ ...stopped, state: "failed", cleanupVerified: false }).includes("退出尚未确认"));
console.log("Central management UI smoke passed: native response boundaries, revision/draft mapping, complete inspection shape, sanitized failures.");
