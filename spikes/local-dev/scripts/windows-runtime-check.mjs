// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Inspect PE imports without executing the artifact or relying on the build host's DLLs.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function windowsImports(bytes) {
  const invalid = () => { throw Error("WINDOWS_PE_INVALID"); };
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) invalid();
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) invalid();
  const sections = bytes.readUInt16LE(pe + 6), optional = pe + 24;
  const sectionTable = optional + bytes.readUInt16LE(pe + 20);
  if (sectionTable + sections * 40 > bytes.length) invalid();
  const magic = bytes.readUInt16LE(optional);
  if (![0x10b, 0x20b].includes(magic)) invalid();
  const directory = optional + (magic === 0x20b ? 112 : 96);
  const imageBase = magic === 0x20b ? Number(bytes.readBigUInt64LE(optional + 24)) : bytes.readUInt32LE(optional + 28);
  function offset(rva) {
    for (let i = 0; i < sections; i++) {
      const s = sectionTable + i * 40, va = bytes.readUInt32LE(s + 12), size = bytes.readUInt32LE(s + 16);
      if (rva >= va && rva < va + size) {
        const result = bytes.readUInt32LE(s + 20) + rva - va;
        if (result >= bytes.length) invalid();
        return result;
      }
    }
    invalid();
  }
  const names = [];
  const directoryCount = bytes.readUInt32LE(directory - 4);
  for (const [index, stride, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
    if (index >= directoryCount) continue;
    if (directory + index * 8 + 8 > sectionTable) invalid();
    const rva = bytes.readUInt32LE(directory + index * 8), size = bytes.readUInt32LE(directory + index * 8 + 4);
    if (!rva) continue;
    const start = offset(rva);
    let terminated = false;
    for (let step = 0; step + stride <= size; step += stride) {
      const p = start + step;
      if (p + stride > bytes.length) invalid();
      const address = bytes.readUInt32LE(p + nameOffset);
      if (!address) { terminated = true; break; }
      const nameRva = index === 13 && !(bytes.readUInt32LE(p) & 1) ? address - imageBase : address;
      const n = offset(nameRva), end = bytes.indexOf(0, n);
      if (end < n || end - n > 260) invalid();
      names.push(bytes.toString("ascii", n, end));
    }
    if (!terminated) invalid();
  }
  return [...new Set(names)].sort();
}

export function assertPortableWindowsRuntime(file) {
  const imports = windowsImports(readFileSync(file));
  // Windows system DLLs (including UCRT API sets) are allowed. Separately installed
  // Visual C++ redistributables and debug CRTs must never be required by the package.
  const external = imports.filter(name => /^(vcruntime\d[^.]*|msvcp\d[^.]*|msvcr\d[^.]*|concrt\d[^.]*|ucrtbased)\.dll$/i.test(name));
  if (external.length) throw Error(`WINDOWS_RUNTIME_NOT_SELF_CONTAINED: ${basename(file)} requires ${external.join(", ")}`);
  return { file: basename(file), imports, externalVisualCppRuntime: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length < 3) throw Error("Usage: node scripts/windows-runtime-check.mjs <exe> [exe...]");
  for (const file of process.argv.slice(2)) console.log(JSON.stringify(assertPortableWindowsRuntime(file)));
}
