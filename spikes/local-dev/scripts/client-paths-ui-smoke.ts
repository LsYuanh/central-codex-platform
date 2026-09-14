import assert from "node:assert/strict";
import { joinClientPath, parentClientPath } from "../apps/desktop/src/client-paths.ts";

for (const [path, expected] of [
  ["C:\\Workplace\\project", "C:/Workplace"], ["C:/Workplace", "C:/"], ["C:/", "C:/"],
  ["/Users/project", "/Users"], ["/Users", "/"], ["/", "/"],
  ["\\\\server\\share\\project", "//server/share"], ["//server/share", "//server/share"],
  [".", ".."], ["..", "../.."], ["src/components", "src"],
]) assert.equal(parentClientPath(path), expected, path);
assert.equal(joinClientPath("/", "file.txt"), "/file.txt");
assert.equal(joinClientPath("C:\\", "file.txt"), "C:/file.txt");
assert.equal(joinClientPath("\\\\server\\share", "file.txt"), "//server/share/file.txt");
assert.equal(joinClientPath(".", "file.txt"), "file.txt");
console.log("CLIENT_PATHS_UI_SMOKE_OK");
