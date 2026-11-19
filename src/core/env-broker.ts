import { escalationEnabled } from "./config.js";
// Root-owned environment authority. Worker environments carry runtime controls only. Workers
// also hold the root's secret values in memory for redaction only, never as launch authority.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Instance } from "./caller.js";
import { configPath, loadConfig, networkOn, relayHome, type RelayConfig, type Target } from "./config.js";
import { getNode, getRun, getTurn, runConfig, updateTurn, workCwd } from "./db.js";
import { claimGone, requestApproval, webGranted } from "./approvals.js";
import { procStart, sameProcess } from "./procs.js";
import { socketPeer } from "../confine/peer.js";
import { ensureRelaySocketsDir } from "../confine/sockets.js";
import { capturedRootEnvironment, effectiveChildEnv, runtimeEnvironment, selectEnvironment } from "./env-policy.js";
import { redact, registerReleasedEnvironment, registerRootRedactionValues, secretValues, withTurnSecrets } from "./secrets.js";
import { targetDef } from "../targets/index.js";
import { clipped } from "./shown.js";

export const ENV_SOCKET = "RELAY_ENV_SOCKET";
type Selection = ReturnType<typeof selectEnvironment>;
interface RootAuthority { inst: Instance; socket: string; close(): Promise<void> }
const roots = new Map<string, RootAuthority>();
const opening = new Map<string, Promise<RootAuthority>>();
const MAX = 4 * 1024 * 1024;

/**
 * Where a root's broker is published for rediscovery: in relay's control directory, which no
 * agent can write, by a hash of the owner token (never the token). A worker that outlived the root
 * which started it (a shared desktop process restarted under a conversation's session token) finds
 * its run's current broker here instead of the dead address it inherited (environmentClaim).
 */
const brokerRecord = (owner: string) =>
  path.join(relayHome(), "brokers", `${crypto.createHash("sha256").update("relay-env-broker-v1").update(owner).digest("hex").slice(0, 32)}.json`);
interface BrokerRecord { socket: string; pid: number; start: string | null }

function publishBroker(owner: string, socket: string): void {
  const file = brokerRecord(owner);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ socket, pid: process.pid, start: procStart(process.pid) } satisfies BrokerRecord), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Workers this root started have its address already; only rediscovery after a restart is lost.
  }
}
function unpublishBroker(owner: string, socket: string): void {
  try { if ((JSON.parse(fs.readFileSync(brokerRecord(owner), "utf8")) as BrokerRecord).socket === socket) fs.rmSync(brokerRecord(owner), { force: true }); } catch { /* Gone already. */ }
}

/**
 * The broker of the run's current owner, as it published itself, when that process is the run's
 * recorded lease holder and still alive; otherwise null. Read from the registry and the control
 * directory, never from anything an agent supplies.
 */
function currentBroker(claim: { turn: number } | { worker: string }): BrokerRecord | null {
  try {
    const nodeId = "turn" in claim ? getTurn(claim.turn)?.node_id : claim.worker;
    const run = nodeId ? getRun(getNode(nodeId)?.run_id ?? "") : undefined;
    if (!run?.root_token || !run.root_pid) return null;
    const rec = JSON.parse(fs.readFileSync(brokerRecord(run.root_token), "utf8")) as BrokerRecord;
    if (typeof rec.socket !== "string" || !path.isAbsolute(rec.socket) || rec.pid !== run.root_pid || rec.start !== run.root_start) return null;
    return sameProcess(rec.pid, rec.start) ? rec : null;
  } catch {
    return null;
  }
}

function rootFor(runId: string): RootAuthority | undefined {
  const owner = getRun(runId)?.root_token;
  return owner ? roots.get(owner) : undefined;
}

/**
 * Why a grant only the person can allow, given to a job before it starts (grant.local_network),
 * cannot be asked for here, or null: as for grant.env, the owning root session must have a person
 * path (confirm, or an approval dialog relay knows a person answers), and approval requests must be on.
 */
export function personConsentAdmission(runId: string, what: string): string | null {
  const root = rootFor(runId);
  if (!root || (!root.inst.host.confirmTool && !root.inst.host.personDialog)) {
    return `${what} needs the user's consent through confirm or a qualified approval dialog in the owning root session. No such person path is available here; use a session where relay can ask them.`;
  }
  try {
    if (!escalationEnabled(environmentConfig(runId))) return `${what} needs the user's consent through an approval request, but escalation is off in relay's config.`;
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

/** Names only, and only a person path. Called before creating an item or any harness process. */
export function environmentAdmission(runId: string, target: Target, names: readonly string[]): string | null {
  if (!names.length) return null;
  const root = rootFor(runId);
  if (!root || (!root.inst.host.confirmTool && !root.inst.host.personDialog)) {
    return "grant.env needs the user's consent through confirm or a qualified approval dialog in the owning root session. No such person path is available; ask the person to configure exact child_env.pass entries, or use a session where relay can ask them.";
  }
  try {
    const cfg = environmentConfig(runId);
    if (!escalationEnabled(cfg)) return "grant.env needs person-only approval, but escalation is off; ask the person to configure exact child_env.pass entries or enable approval requests";
    selectEnvironment(target, cfg, capturedRootEnvironment, names);
  }
  catch (err) { return (err as Error).message; }
  return null;
}

/** Child relay servers learn the address, never the root's environment or a value-bearing ticket. */
export function environmentSocketFor(runId: string): string {
  const socket = rootFor(runId)?.socket ?? process.env[ENV_SOCKET];
  if (!socket) throw new Error("the owning root's environment broker is unavailable; restart the root relay server before launching another turn");
  return socket;
}

export function workerEnvironment(runId: string): NodeJS.ProcessEnv {
  const root = rootFor(runId);
  const env = runtimeEnvironment(root ? capturedRootEnvironment : process.env);
  const socket = root?.socket ?? process.env[ENV_SOCKET];
  // Still start a worker when the address is missing: turnEnvironment then records a failed
  // turn. Throwing in dispatch would strand it queued with no worker to report the failure.
  if (socket) env[ENV_SOCKET] = socket;
  else delete env[ENV_SOCKET];
  return env;
}

/** A socket operation is bound to the registry-pinned worker, not to a bearer held by an agent. */
export async function openRootEnvironment(inst: Instance, opts: {
  /** Host-side test seam, as in the confined broker. No config/tool input can supply it. */
  peerIdentity?: typeof socketPeer;
} = {}): Promise<RootAuthority> {
  if (inst.ctx.kind !== "root") throw new Error("only a root server owns an environment broker");
  const existing = roots.get(inst.token);
  if (existing) return existing;
  const pending = opening.get(inst.token);
  if (pending) return pending;
  const started = (async () => {
    const dir = fs.mkdtempSync(path.join(ensureRelaySocketsDir(), "e-"));
    const socket = path.join(dir, "s");
    if (Buffer.byteLength(socket) > 103) { fs.rmSync(dir, { recursive: true }); throw new Error("the root environment broker's socket path exceeds the platform limit"); }
    const connections = new Set<net.Socket>();
    const consumed = new Set<number>();
    const redactionValues = secretValues(capturedRootEnvironment);
    const server = net.createServer((sock) => {
      connections.add(sock);
      sock.on("error", () => {});
      sock.once("close", () => connections.delete(sock));
      sock.setTimeout(5000, () => sock.destroy());
      let buf = "", handled = false;
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        if (handled) return;
        buf += chunk;
        if (buf.length > 1024) return void sock.destroy();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        handled = true;
        sock.setTimeout(0);
        void withTurnSecrets(async () => {
          let id: number;
          try {
            const input = JSON.parse(buf.slice(0, nl)) as { turn?: unknown; worker?: unknown };
            const startup = typeof input.worker === "string" && input.turn === undefined;
            if (!startup && (input.worker !== undefined || !Number.isSafeInteger(input.turn))) throw new Error("invalid environment claim identity");
            id = input.turn as number;
            const turn = startup ? undefined : getTurn(id);
            const node = startup ? getNode(input.worker as string) : turn && getNode(turn.node_id);
            if (!node?.target || !["job", "thread", "participant"].includes(node.kind) || (!startup && !turn)
              || getRun(node.run_id)?.root_token !== inst.token) throw new Error("this root does not own that environment worker or turn");
            const peer = await (opts.peerIdentity ?? socketPeer)(sock);
            const pinned = () => {
              const n = getNode(node.id);
              return !sock.destroyed && getRun(node.run_id)?.root_token === inst.token
                && n?.worker_pid === peer.pid && n.worker_start === peer.start && peer.uid === process.getuid?.()
                && sameProcess(peer.pid, peer.start, { fresh: true });
            };
            // A worker claims a turn as it picks it up, while the turn is still queued (claimGone).
            const live = () => pinned() && (startup || !claimGone(node.id, id));
            if (!pinned()) throw new Error("environment requests require the registry-pinned live worker of this node");
            // Only the pinned worker learns why its turn cannot be claimed: ids and statuses, no values.
            const gone = startup ? null : claimGone(node.id, id);
            if (gone) throw new Error(`this turn's environment cannot be claimed: ${gone}`);
            if (startup) {
              // Housekeeping can log before any turn. This claim releases no agent environment,
              // config or consent capability, and has exactly the same pinned peer checks.
              sock.end(JSON.stringify({ redactionValues }) + "\n");
              return;
            }
            if (!turn) throw new Error("invalid environment turn identity");
            if (consumed.has(id)) throw new Error("this turn's environment claim has already been consumed; resume with a new turn");
            // The opaque claim lives only here, is consumed once and dies with this root server.
            consumed.add(id);
            const grant = JSON.parse(turn.grant_json ?? "{}") as { env?: string[]; network?: boolean };
            const names = grant.env ?? [];
            const cfg = environmentConfig(node.run_id);
            const revision = policyRevision(cfg, node.target);
            const cwd = workCwd(node);
            const directory = directoryIdentity(cwd);
            const selection = selectEnvironment(node.target, cfg, capturedRootEnvironment, names);
            registerReleasedEnvironment(selection.env, selection.releasedNames);
            // What the worker checks again before it launches the turn (claimBinding), as it may wait for a slot first.
            const bound = () => {
              try { return live() && getNode(node.id)?.target === node.target && workCwd(getNode(node.id)!) === cwd
                && (!names.length || inst.host.confirmTool === true || inst.host.personDialog === true)
                && directoryIdentity(cwd) === directory
                && policyRevision(environmentConfig(node.run_id), node.target!) === revision
                && getTurn(id)?.access === turn.access && getTurn(id)?.grant_json === turn.grant_json; }
              catch { return false; }
            };
            if (names.length) {
              const unavailable = environmentAdmission(node.run_id, node.target, names);
              if (unavailable) throw new Error(unavailable);
              // An authenticated claim can wait for a person longer than the transport deadline.
              // This acknowledges only the pending consent, and releases no environment values.
              // requestApproval can wait once behind another request, then once for a decision.
              const timeoutMs = Math.min(2_147_483_647, 2 * cfg.approval_timeout_s * 1000 + 10_000);
              sock.write(JSON.stringify({ pending: true, timeoutMs }) + "\n");
              const policy = effectiveChildEnv(cfg, node.target);
              const fullAccess = cfg.allow_dangerous && turn.access === "write" && targetDef(node.target).capabilities.confinement === "verified";
              const network = networkOn(cfg, grant) || fullAccess;
              const purpose = clipped(redact(turn.body), 1000);
              const answer = await requestApproval(node.id, id, {
                kind: "env", summary: `release environment variables ${names.join(", ")} to ${node.target} for this turn only. Caller-supplied purpose (untrusted): ${purpose}`,
                reason: `Caller-supplied purpose (untrusted): ${purpose}`,
                detail: { names, target: node.target, run: node.run_id, item: node.id, turn: id, cwd, access: turn.access,
                  full_access: fullAccess, network,
                  web: network || webGranted(node.id) ? "network/native web access permitted" : cfg.child_web === "ask" ? "requires approval (Codex search off)" : "native target configuration; model and result channels remain available", standing_passes: policy.pass },
              }, () => !bound());
              if (!answer.allow || !bound()) throw new Error("environment consent was denied, expired, cancelled or its binding changed; no environment values were released. Resume with a fresh grant.env request, or ask the person to configure child_env.pass.");
            }
            if (!bound()) throw new Error("the environment turn or policy changed before release; no values were released");
            // The separate set never becomes part of selection.env or an agent/tool response.
            sock.end(JSON.stringify({ selection: { env: selection.env, releasedNames: selection.releasedNames }, config: cfg, redactionValues }) + "\n");
          } catch (err) {
            // All policy errors are names/reasons; never serialize an environment or URL value.
            if (!sock.destroyed) sock.end(JSON.stringify({ error: (err as Error).message }) + "\n");
          }
        });
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
      fs.chmodSync(socket, 0o600);
      server.unref();
    } catch (err) { fs.rmSync(dir, { recursive: true, force: true }); throw err; }
    publishBroker(inst.token, socket);
    const authority: RootAuthority = { inst, socket, close: async () => {
      roots.delete(inst.token);
      unpublishBroker(inst.token, socket);
      for (const s of connections) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    } };
    roots.set(inst.token, authority);
    return authority;
  })();
  opening.set(inst.token, started);
  try { return await started; } finally { opening.delete(inst.token); }
}

export async function closeRootEnvironment(inst: Instance): Promise<void> { await roots.get(inst.token)?.close(); }

// Names/policy only; comparison stays in memory and is deliberately not a reusable value hash.
// Every config input of a selection is here: the target's effective child_env and child_auth, and
// Claude's child_auth, which decides the host-session endpoint guard for every target. The config
// file's identity is added unless the caller compares a standing selection alone (claimBinding).
function policyRevision(cfg: RelayConfig, target: Target, o: { file?: boolean } = {}): string {
  return JSON.stringify({ policy: effectiveChildEnv(cfg, target), auth: cfg.child_auth, ownAuth: cfg.targets[target].child_auth,
    hostAuth: cfg.targets.claude.child_auth, network: cfg.child_network, web: cfg.child_web, escalation: cfg.escalation,
    ...(o.file === false ? {} : { config_file: configIdentity() }) });
}
function configIdentity(): string {
  try {
    const st = fs.statSync(configPath(), { bigint: true });
    return [st.dev, st.ino, st.mtimeNs, st.ctimeNs, st.size].map(String).join(":");
  } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw err; }
}
function directoryIdentity(cwd: string): string {
  const st = fs.statSync(cwd, { bigint: true });
  if (!st.isDirectory()) throw new Error("the environment turn's working directory is no longer a directory");
  return JSON.stringify([fs.realpathSync(cwd), String(st.dev), String(st.ino)]);
}

/** Run execution limits stay snapshotted; the person's environment/auth policy is read each turn. */
function environmentConfig(runId: string): RelayConfig {
  const cfg = runConfig(runId), current = loadConfig(() => {});
  cfg.child_env = current.child_env;
  cfg.child_auth = current.child_auth;
  for (const target of Object.keys(cfg.targets) as Target[]) {
    cfg.targets[target].child_env = current.targets[target].child_env;
    cfg.targets[target].child_auth = current.targets[target].child_auth;
  }
  return cfg;
}

export function recordEnvironmentRequest(turnId: number, names?: readonly string[]): void {
  if (names?.length) {
    // At queue time grant_json holds names only; the worker records the complete effective grant
    // when it claims the turn. A missing field never reuses a previous turn's request.
    const turn = getTurn(turnId);
    if (!turn || turn.status !== "queued") throw new Error("environment requests belong to a queued turn");
    // Imported lazily below would add no safety: updateTurn persists names, never selected values.
    updateTurn(turnId, { grant_json: JSON.stringify({ env: [...new Set(names)] }) });
  }
}

/** Fail closed when the owner is gone. Workers never fall back to their inherited environment. */
export async function turnEnvironment(turnId: number, signal?: AbortSignal): Promise<{ selection: Pick<Selection, "env" | "releasedNames">; config: RelayConfig }> {
  const result = await environmentClaim({ turn: turnId }, signal);
  registerRootRedactionValues(result.redactionValues);
  return { selection: result.selection!, config: result.config! };
}

/** Said when what a turn's environment was claimed under changed before its launch. */
const CLAIM_CHANGED = "what this turn's environment was claimed under changed while it waited to start (its environment/auth policy, relay's config file for a turn with a grant.env request, the working directory, the turn's grant or its worker), so it was not started with the environment it was given then. Resume it to claim afresh; consent to a grant.env request is asked again";

/**
 * What a turn's environment claim is bound to, as the worker reads it: the turn, its access and
 * recorded grant, the target, the registry-pinned worker, the working directory's identity, and the
 * environment/auth policy. Names and identities only, never a value or a value hash. The broker's
 * bound() checks the same, with the config file's identity, until it releases the selection. At
 * launch the file's identity counts only for a turn with a grant.env request, whose consent is bound
 * to it: a standing selection depends on nothing in the file beyond the policy compared here, so an
 * unrelated edit, a touch or a no-op save does not fail it (or, through settle, its follow-ups).
 */
function claimBinding(turnId: number): string {
  const turn = getTurn(turnId);
  const node = turn ? getNode(turn.node_id) : undefined;
  if (!turn || !node?.target) throw new Error("the environment turn is no longer in the registry");
  const cwd = workCwd(node);
  const requested = Boolean((JSON.parse(turn.grant_json ?? "{}") as { env?: string[] }).env?.length);
  return JSON.stringify({
    turn: turnId, access: turn.access, grant: turn.grant_json, node: node.id, target: node.target, worker: [node.worker_pid, node.worker_start],
    cwd, directory: directoryIdentity(cwd), policy: policyRevision(environmentConfig(node.run_id), node.target, { file: requested }),
  });
}

/** A turn's claimed environment, held in its worker's memory only (never on disk) until the turn launches or ends. */
export interface ClaimedEnvironment {
  /** Fails, and forgets the environment, if what the claim was bound to has changed since (claimBinding); keeps it otherwise. */
  check(): void;
  /** For the launch, once. Refused, and forgotten, if what the claim was bound to has changed since (claimBinding). */
  take(): { selection: Pick<Selection, "env" | "releasedNames">; config: RelayConfig };
  /** Forgets the environment of a turn that ends without launching (cancelled while it waited, say). Nothing once taken. */
  drop(): void;
}

/**
 * Claims a turn's environment from the owning root as its worker picks the turn up, before the turn
 * waits for a concurrency slot: from then on it needs its root no more than a running turn does. The
 * binding is read before the claim is sent and checked on the reply and again at launch, while the
 * broker checks its own reading until it replies, so a change at any point fails the turn closed.
 * Consent to a one-turn request is asked within the claim, so it is decided before the slot wait.
 */
export async function claimTurnEnvironment(turnId: number, signal?: AbortSignal): Promise<ClaimedEnvironment> {
  const binding = claimBinding(turnId);
  const { run_id: runId, target } = getNode(getTurn(turnId)!.node_id)!;
  let held: Awaited<ReturnType<typeof turnEnvironment>> | null = await turnEnvironment(turnId, signal);
  const drop = () => {
    if (!held) return;
    // Drops this worker's references to the values; they were never written anywhere.
    for (const name of Object.keys(held.selection.env)) delete held.selection.env[name];
    held = null;
  };
  const unchanged = () => {
    let same = false;
    // Unchanged since before the claim was sent, and selected under the policy in force now: the
    // broker returns the config it selected from, so an edit undone in between cannot slip through.
    try {
      same = claimBinding(turnId) === binding
        && policyRevision(held!.config, target!, { file: false }) === policyRevision(environmentConfig(runId), target!, { file: false });
    } catch { /* Unreadable counts as changed. */ }
    if (!same) { drop(); throw new Error(CLAIM_CHANGED); }
  };
  unchanged();
  return {
    check: () => {
      if (!held) throw new Error("this turn's environment was already used or dropped; resume it to claim afresh");
      unchanged();
    },
    take: () => {
      if (!held) throw new Error("this turn's environment was already used or dropped; resume it to claim afresh");
      unchanged();
      const claimed = held!;
      held = null;
      return claimed;
    },
    drop,
  };
}

/** Startup redaction only. The values stay inside the redactor, including before a first turn. */
export async function workerRedaction(nodeId: string): Promise<void> {
  const result = await environmentClaim({ worker: nodeId });
  registerRootRedactionValues(result.redactionValues);
}

/** Said when no broker of the run's owner can be reached: the turn fails, nothing waits for one. */
const NO_BROKER = "the owning root's environment broker is unavailable, unresponsive or closed: restart the root, or on a shared relay call relay again from the conversation that owns this run (either opens its broker), then resume this work; environment consent is asked afresh";

function environmentClaim(claim: { turn: number } | { worker: string }, signal?: AbortSignal): Promise<{
  redactionValues: string[]; selection?: Pick<Selection, "env" | "releasedNames">; config?: RelayConfig;
}> {
  return new Promise((resolve, reject) => {
    // The address inherited from the root that started this worker, unless that root has since been
    // replaced: then the run's current owner, as published in the control directory, provided the
    // kernel says the listening process is that owner (checked below before anything is sent).
    const inherited = process.env[ENV_SOCKET];
    const current = currentBroker(claim);
    const moved = current && current.socket !== inherited ? current : null;
    const address = moved?.socket ?? inherited;
    if (!address) return reject(new Error(`no owning root environment broker: ${NO_BROKER}`));
    const sock = net.connect(address);
    let buf = "", settled = false, pending = false;
    let deadline = setTimeout(() => fail(), 10_000);
    const fail = (why = NO_BROKER) => { clearTimeout(deadline); if (!settled) { settled = true; reject(new Error(why)); } sock.destroy(); };
    const abort = () => fail();
    signal?.addEventListener("abort", abort, { once: true });
    sock.once("connect", () => {
      if (!moved) return void sock.write(JSON.stringify(claim) + "\n");
      void socketPeer(sock).then((peer) => {
        if (peer.pid !== moved.pid || peer.start !== moved.start || peer.uid !== process.getuid?.()) return fail(`the environment broker relay recorded for this run is not its owning root process; nothing was claimed. ${NO_BROKER}`);
        // Handing the socket to the kernel-identity helper pauses it; the answer must be read.
        if (!settled) { sock.resume(); sock.write(JSON.stringify(claim) + "\n"); }
      }, () => fail());
    });
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX) return fail();
      while (!settled && buf.includes("\n")) {
        const nl = buf.indexOf("\n"), line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const result = JSON.parse(line);
          if (result.pending === true) {
            if (!("turn" in claim) || pending || !Number.isFinite(result.timeoutMs) || result.timeoutMs <= 0 || result.timeoutMs > 2_147_483_647) return fail();
            pending = true;
            clearTimeout(deadline);
            deadline = setTimeout(() => fail(), result.timeoutMs);
            continue;
          }
          if (result.error) { settled = true; reject(new Error(result.error)); }
          else if (!Array.isArray(result.redactionValues) || !result.redactionValues.every((v: unknown) => typeof v === "string")
            || ("turn" in claim && (!result.selection?.env || !Array.isArray(result.selection.releasedNames) || !result.config))) return fail();
          else { settled = true; resolve(result); }
        } catch { return fail(); }
        clearTimeout(deadline);
        sock.destroy();
      }
    });
    sock.once("error", () => fail());
    sock.once("close", () => { clearTimeout(deadline); signal?.removeEventListener("abort", abort); if (!settled) fail(); });
    if (signal?.aborted) fail();
  });
}
