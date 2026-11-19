import fs from "node:fs";
import path from "node:path";
import { ensurePrivateRoot, privateStateRoot } from "./private-root.js";

/**
 * Where relay keeps its own Unix sockets: one private directory per confined turn (the turn's
 * broker, broker.ts), all inside this one. Every confined turn's profile denies reading, writing
 * and connecting anywhere in it, and removing or renaming it or any directory above it, as final
 * rules; only the turn's own bridge socket is allowed after them. So no turn can find, reach or
 * replace another turn's broker.
 */
export function relaySocketsDir(): string {
  return path.join(privateStateRoot(), "s");
}

/**
 * The sockets directory, made if missing (mode 0700) and checked: a real directory, not a link,
 * this user's own and writable by no one else. Throws otherwise.
 */
export function ensureRelaySocketsDir(): string {
  const dir = relaySocketsDir();
  ensurePrivateRoot(privateStateRoot());
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`relay's sockets directory ${dir} is not a plain directory, so relay does not serve a confined turn from it`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`relay's sockets directory ${dir} is not owned by this user`);
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  return dir;
}
