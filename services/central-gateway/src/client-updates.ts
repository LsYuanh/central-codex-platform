// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const UPDATE_LIMIT = 512 * 1024 * 1024;
export type UpdateBusyReason = "active-turn" | "device-operation" | "command-running" | "command-state-unknown" | "agent-unavailable" | "install-lease";
export class UpdateDeviceBusy extends Error {
  constructor(public readonly reason: UpdateBusyReason) { super("UPDATE_DEVICE_BUSY"); }
}
const targets = new Set(["windows-x86_64", "darwin-aarch64", "darwin-x86_64"]);
const filename = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,179}$/;
export type ClientRelease = { version: string; notes: string; pub_date: string; platforms: Record<string, { file: string; signature: string }> };
export function validateRelease(raw: unknown): ClientRelease {
  const r = raw as ClientRelease;
  if (!r || !/^\d+\.\d+\.\d+$/.test(r.version) || typeof r.notes !== "string" || r.notes.length > 16000 ||
      typeof r.pub_date !== "string" || !Number.isFinite(Date.parse(r.pub_date)) || !r.platforms || typeof r.platforms !== "object" || Array.isArray(r.platforms)) throw Error("UPDATE_MANIFEST_INVALID");
  const entries = Object.entries(r.platforms);
  if (!entries.length || entries.length > 3) throw Error("UPDATE_MANIFEST_INVALID");
  for (const [target, p] of entries) {
    if (!targets.has(target) || !p || !filename.test(p.file) || !p.file.startsWith(`${r.version}-${target}.`) ||
        !(target.startsWith("windows") ? p.file.endsWith(".exe") : p.file.endsWith(".app.tar.gz")) ||
        typeof p.signature !== "string" || !/^[A-Za-z0-9+/=]+$/.test(p.signature) || p.signature.length > 4096 || p.signature.length < 80) throw Error("UPDATE_MANIFEST_INVALID");
  }
  return r;
}

/** Only publishes explicitly registered installer files. No arbitrary file-serving route. */
export class ClientUpdates {
  private leases = new Map<string, { token: string; expires: number; version?: string }>();
  constructor(private directory: string | undefined) {}
  locked(device: string) {
    const lease = this.leases.get(device);
    if (lease && lease.expires <= Date.now()) this.leases.delete(device);
    return this.leases.has(device);
  }
  prepare(device: string, token: string, busy: boolean | UpdateBusyReason, version?: string) {
    if (this.locked(device)) throw new UpdateDeviceBusy("install-lease");
    if (busy) throw new UpdateDeviceBusy(busy === true ? "device-operation" : busy);
    this.leases.set(device, { token, expires: Date.now() + 60_000, version });
    return { token, expiresInMs: 60_000 };
  }
  release(device: string, token: string) {
    if (this.leases.get(device)?.token === token) this.leases.delete(device);
  }
  resume(device: string, version: string) {
    if (this.leases.get(device)?.version === version) this.leases.delete(device);
  }
  async serve(request: IncomingMessage, response: ServerResponse, url: URL) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end(); return; }
      if (!this.directory) { response.writeHead(503); response.end("UPDATE_NOT_CONFIGURED"); return; }
      const root = await realpath(resolve(this.directory));
      const manifestPath = join(root, "latest.json");
      const info = await lstat(manifestPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw Error("UPDATE_MANIFEST_INVALID");
      const release = validateRelease(JSON.parse(await readFile(manifestPath, "utf8")));
      if (url.pathname === "/client-updates/latest.json") {
        const origin = `https://${request.headers.host}`;
        const platforms = Object.fromEntries(Object.entries(release.platforms).map(([target, p]) => [target, {
          url: `${origin}/client-updates/files/${p.file}`, signature: p.signature,
        }]));
        const body = JSON.stringify({ version: release.version, notes: release.notes, pub_date: release.pub_date, platforms });
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        response.end(request.method === "HEAD" ? undefined : body); return;
      }
      const name = url.pathname.slice("/client-updates/files/".length);
      if (!url.pathname.startsWith("/client-updates/files/") || !filename.test(name) || !Object.values(release.platforms).some(p => p.file === name)) {
        response.writeHead(404); response.end(); return;
      }
      const path = join(root, name), file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink() || await realpath(path) !== path || file.size < 1 || file.size > UPDATE_LIMIT) throw Error("UPDATE_ARTIFACT_INVALID");
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": (await stat(path)).size });
      if (request.method === "HEAD") { response.end(); return; }
      const stream = createReadStream(path);
      response.on("close", () => stream.destroy());
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(503);
      response.end("UPDATE_RELEASE_UNAVAILABLE");
    }
  }
}
