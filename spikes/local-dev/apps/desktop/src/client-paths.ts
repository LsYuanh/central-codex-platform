// Client paths must not use the browser/central host's path implementation.
export function parentClientPath(raw: string): string {
  const path = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!path) return raw.startsWith("/") ? "/" : "..";
  if (/^[a-z]:$/i.test(path)) return `${path}/`;
  if (/^\/\/[^/]+\/[^/]+$/.test(path)) return path;
  const slash = path.lastIndexOf("/");
  if (slash === 0) return "/";
  if (slash < 0) return path === "." ? ".." : path === ".." ? "../.." : ".";
  const parent = path.slice(0, slash);
  return /^[a-z]:$/i.test(parent) ? `${parent}/` : parent;
}

export function joinClientPath(base: string, name: string): string {
  const path = base.trim().replace(/\\/g, "/");
  return path && path !== "." ? `${path.replace(/\/+$/, "")}/${name}` : name;
}
