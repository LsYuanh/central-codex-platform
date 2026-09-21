// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const spikeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = spikeRoot;
const envPath = path.join(spikeRoot, ".env");
const migrationPath = path.join(repositoryRoot, "legacy", "database", "migrations", "001_initial.sql");

function readEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
  );
}

function databasePath(databaseUrl) {
  if (databaseUrl === ":memory:" || databaseUrl === "sqlite::memory:") return ":memory:";
  const prefix = "sqlite://";
  if (!databaseUrl.startsWith(prefix)) {
    throw new Error(`DATABASE_URL must use SQLite (expected ${prefix}...): ${databaseUrl}`);
  }
  const relativePath = databaseUrl.slice(prefix.length).replace(/^\/+/, "");
  if (!relativePath || relativePath.startsWith("://")) {
    throw new Error("DATABASE_URL must include a SQLite file path");
  }
  return path.resolve(spikeRoot, relativePath);
}

let env = {};
try {
  env = readEnv(await readFile(envPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
env = { ...env, ...process.env };

const url = env.DATABASE_URL ?? "sqlite://./data/central.db";
const dbPath = databasePath(url);
if (dbPath !== ":memory:") await mkdir(path.dirname(dbPath), { recursive: true });
const busyTimeoutMs = Number(env.DATABASE_BUSY_TIMEOUT_MS ?? "5000");
if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
  throw new Error("DATABASE_BUSY_TIMEOUT_MS must be an integer between 0 and 60000");
}

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  throw new Error("Node.js 24+ is required: node:sqlite is unavailable in this runtime");
}

const database = new DatabaseSync(dbPath);
try {
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;`);
  const migration = await readFile(migrationPath, "utf8");
  database.exec(migration);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)")
    .run("001_initial");
  console.log(`SQLite database initialized: ${dbPath}`);
} finally {
  database.close();
}
