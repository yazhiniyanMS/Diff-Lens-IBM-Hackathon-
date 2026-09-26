import fs from "node:fs";
import path from "node:path";

/**
 * Minimal file-backed session store. Chosen over a native SQLite binding
 * to avoid a native-build dependency for a hackathon MVP; the interface
 * (get/save/list, keyed by session id) is intentionally the same shape a
 * SQLite- or Postgres-backed store would expose, so swapping the backend
 * later doesn't touch calling code.
 */
export class SessionStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  save(session) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this._file(session.id), JSON.stringify(session, replacer, 2));
    return session;
  }

  get(id) {
    const file = this._file(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  list() {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        return { id: s.id, createdAt: s.createdAt, repoPath: s.repoPath, base: s.base, head: s.head };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  delete(id) {
    const file = this._file(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

function replacer(_key, value) {
  if (value instanceof Set) return [...value];
  return value;
}

let defaultStore = null;
export function getStore() {
  if (!defaultStore) {
    const dir = process.env.DIFFLENS_DATA_DIR || path.join(process.cwd(), ".difflens", "sessions");
    defaultStore = new SessionStore(dir);
  }
  return defaultStore;
}
