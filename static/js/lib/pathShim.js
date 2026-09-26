// Minimal POSIX-path helpers -- just enough of node:path's API surface for
// the ported modules (contextEngine.js etc.), so they don't need a real
// path-browserify dependency for a handful of calls.

export function basename(p, ext) {
  const base = p.split("/").filter(Boolean).pop() || "";
  if (ext && base.endsWith(ext) && base !== ext) return base.slice(0, -ext.length);
  return base;
}

export function extname(p) {
  const base = basename(p);
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx);
}

export function dirname(p) {
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || ".";
}

export function join(...parts) {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/");
}

export default { basename, extname, dirname, join };
