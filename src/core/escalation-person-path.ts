/** Availability of the person approval route, including private cross-process heartbeats. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { relayHome } from "./config.js";
import { db, getRun, registryMark, sameMark, type RegistryMark } from "./db.js";
import { owningRootBinding } from "./escalation-policy.js";

// Cross-process, short-lived person-route availability is published by the root server in the
// private state (see escalations.ts). This callback also makes host qualification changes immediate.
const paths = new Map<string, () => { confirm: boolean; dialog: boolean }>();
export function publishEscalationPersonPath(owner: string, qualified: () => { confirm: boolean; dialog: boolean }): () => void {
  paths.set(owner, qualified);
  return () => { if (paths.get(owner) === qualified) paths.delete(owner); };
}
export const localEscalationPersonPath = (owner: string) => paths.get(owner)?.();

const personPathDir = () => path.join(relayHome(), "person-paths");
const personPathFile = (identity: string) => path.join(personPathDir(), `${identity}.json`);
const reportedPersonPathFailures = new Set<string>();
function checkPersonPathDir(dir = personPathDir(), st = fs.lstatSync(dir)): void {
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error(`${dir} is not a private directory owned by this user`);
}

/**
 * Whether a run of the registry has this root token, as last read, with the registry's mark then:
 * answered again only while the registry has not changed since (registryMark), and read afresh
 * otherwise. The root server asks on every watch tick and every call.
 */
const owners = new Map<string, { mark: RegistryMark; owns: boolean }>();
function ownsAnyRun(owner: string): boolean {
  const mark = registryMark(), last = owners.get(owner);
  if (last && sameMark(last.mark, mark)) return last.owns;
  const owns = Boolean(db().prepare("SELECT 1 FROM runs WHERE root_token = ? LIMIT 1").get(owner));
  owners.set(owner, { mark, owns });
  return owns;
}
/** The heartbeat's identity for a root token: a digest of the token alone, so worked out once per token. */
const identities = new Map<string, string>();
function identityOf(owner: string): string {
  let identity = identities.get(owner);
  if (identity === undefined) {
    if (identities.size >= 256) identities.clear();
    identities.set(owner, (identity = owningRootBinding("", owner).session_identity));
  }
  return identity;
}

/** Root-server heartbeat. Ephemeral availability must not rewrite captured run state, and
 * no bearer token is persisted. Atomic replacement keeps concurrent readers from seeing a
 * partial heartbeat. Expired files grant nothing, including after root ownership changes. */
export function refreshEscalationPersonPath(owner: string, qualified: { confirm: boolean; dialog: boolean }): void {
  if (!ownsAnyRun(owner)) return;
  const identity = identityOf(owner), file = personPathFile(identity);
  try {
    if (!qualified.confirm && !qualified.dialog) {
      if (!fs.existsSync(personPathDir())) { reportedPersonPathFailures.delete(identity); return; }
      checkPersonPathDir();
      fs.rmSync(file, { force: true });
      reportedPersonPathFailures.delete(identity);
      return;
    }
    // Made when it is not a directory yet (mkdir then refuses whatever else is in its place), and
    // checked either way.
    const dir = personPathDir();
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(dir); } catch { /* made below */ }
    if (!st?.isDirectory()) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    checkPersonPathDir(dir, st?.isDirectory() ? st : undefined);
    const value = { ...qualified, identity, expires_at: Date.now() + 5000 };
    const tmp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    let renamed = false;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, file);
      renamed = true;
    } finally { if (!renamed) fs.rmSync(tmp, { force: true }); }
    reportedPersonPathFailures.delete(identity);
  } catch (err) {
    // A stale heartbeat must not leave person-only authority open. Remove it only after proving the
    // parent is relay's private directory; never follow an unsafe replacement directory.
    try { checkPersonPathDir(); fs.rmSync(file, { force: true }); } catch { /* unavailable is closed */ }
    if (!reportedPersonPathFailures.has(identity)) {
      reportedPersonPathFailures.add(identity);
      console.error(`relay: person approval path is unavailable (${(err as Error).message}); person-only decisions remain closed`);
    }
  }
}
export function escalationPersonPathAvailable(runId: string): boolean {
  const run = getRun(runId); if (!run?.root_token) return false;
  const local = localEscalationPersonPath(run.root_token);
  if (local) return local.confirm || local.dialog;
  try {
    checkPersonPathDir();
    const identity = identityOf(run.root_token);
    const fd = fs.openSync(personPathFile(identity), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.nlink !== 1 || st.size > 4096) return false;
      const saved = JSON.parse(fs.readFileSync(fd, "utf8"));
      return saved?.identity === identity && Number.isFinite(saved.expires_at) && saved.expires_at > Date.now() && (saved.confirm === true || saved.dialog === true);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}
