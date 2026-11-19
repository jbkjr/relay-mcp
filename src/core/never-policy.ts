import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { canonical, consultHome, expandHome, foldedPath, harnessHome, overlapsEntryAnyCase, relayHome, worktreesHome } from "./config.js";
import { configProtection, relayWriteProtected } from "./protected-config.js";
import { keyAuthority, keyPathsToDeny } from "./api-keys.js";
import { hardLinksOutside } from "../confine/hardlinks.js";
import { nativeTempAlias, nativeTempRoot, privateStateRoot } from "../confine/private-root.js";
import { rangePorts } from "../confine/ports.js";
import { HARNESS_CONFIG } from "../confine/harness-config.js";
import { NEVER_RETIRED_BUILTIN_IDS, NEVER_VERSION, NeverConfigSchema, normalizeNeverHost, type NeverConfig } from "./never-schema.js";

export interface NeverIdentity { path: string; dev: number; ino: number; kind: number; link?: string; missing?: true }
export interface NeverPath { id: string; path: string; access: "all" | "write"; aliases: string[]; pins: NeverIdentity[]; what?: string }
export interface NeverPort { id: string; port: number; transport: "tcp" | "udp" | "both"; destinations: "this-machine" | "any" }
export interface NeverHost { id: string; host: string }
export interface NeverPolicy {
  version: number; hash: string; paths: NeverPath[]; ports: NeverPort[]; hosts: NeverHost[];
  removed: { id: string; acknowledge: string; reason: string }[];
  /** Required OS restrictions; provider admission must reject incompatible variants. */
  keychain: boolean; authority: boolean;
  localAddresses: string[];
  /** Providers carve only trusted per-node/temp control exceptions out of these roots. */
  authorityRoots: string[];
  authorityPins: NeverIdentity[];
  authorityPorts: number[];
}
export interface NeverEndpoint { host: string; port: number; transport: "tcp" | "udp"; operation?: "connect" | "listen"; addresses?: readonly string[]; cnames?: readonly string[]; localAddresses?: readonly string[] }

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
  return JSON.stringify(v);
};
export const neverDigest = (v: unknown): string => crypto.createHash("sha256").update(stable(v)).digest("hex");
const unique = <T>(items: T[]): T[] => [...new Map(items.map(x => [stable(x), x])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, x]) => x);
const immutable = <T>(v: T): T => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { for (const item of Object.values(v)) immutable(item); Object.freeze(v); }
  return v;
};
/**
 * What a decision or launch plan is bound to. localAddresses are left out: they are observed, not
 * chosen, and macOS's own interfaces (awdl0, llw0) add them at any moment. They only ever add denies,
 * decide() rescreens against the current floor and proxies reject current local addresses themselves,
 * so a new one must not void a person's answer. A running proxy keeps the list it was launched with.
 */
export const neverPolicyHash = ({ hash: _hash, localAddresses: _observed, ...chosen }: Omit<NeverPolicy, "hash"> & { hash?: string }): string => neverDigest(chosen);
const finish = (p: Omit<NeverPolicy, "hash">): NeverPolicy => immutable({ ...p, hash: neverPolicyHash(p) });
const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
const folded = (p: string) => foldedPath(path.resolve(p));

/** Pin existing objects, never absence: creating a missing never name does not remove its deny. */
export function neverPathIdentity(p: string): NeverIdentity[] {
  const pins: NeverIdentity[] = [];
  for (let at = path.resolve(p);;) {
    try {
      const st = fs.lstatSync(at);
      pins.push({ path: at, dev: st.dev, ino: st.ino, kind: st.mode & fs.constants.S_IFMT, ...(st.isSymbolicLink() ? { link: fs.readlinkSync(at) } : {}) });
    } catch (err) {
      if (!["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
    }
    const parent = path.dirname(at); if (parent === at) break; at = parent;
  }
  return unique(pins);
}
function pathEntry(id: string, p: string, access: "all" | "write", home: string, managedNames: ReadonlySet<string>, what?: string): NeverPath {
  const named = path.resolve(p.replace(/^~(?=\/)/, home));
  const real = canonical(named);
  const aliases = [...new Set([named, real])].sort();
  // Relay creates/recreates its state roots and short temp link during normal launch. Their
  // names stay protected; inode pins belong to stable protected objects, not lifecycle roots.
  const pins = id === "relay.authority" ? [] : aliases.flatMap(neverPathIdentity).filter(pin => !managedNames.has(pin.path));
  return { id, path: named, access, aliases, pins: unique(pins), ...(what ? { what } : {}) };
}

/** Trusted supervisor inputs only. home/codexHome must never come from a launched job's env. */
export function resolveNeverPolicy(o: { never?: NeverConfig; home?: string; codexHome?: string; builtins?: boolean }): NeverPolicy {
  const cfg = NeverConfigSchema.parse(o.never ?? {});
  const home = o.home ?? os.homedir();
  const authorityRoots = o.builtins === false ? [] : unique([worktreesHome(), harnessHome(), consultHome(), privateStateRoot(), nativeTempRoot(), nativeTempAlias()].flatMap(p => [p, canonical(p)]));
  const managedNames = new Set([...authorityRoots, relayHome(), canonical(relayHome())]);
  const paths: NeverPath[] = [], ports: NeverPort[] = [];
  // An override of a retired built-in removes nothing, so it is no removal (config load warns).
  const removed = unique(cfg.override_builtin.filter(r => !(NEVER_RETIRED_BUILTIN_IDS as readonly string[]).includes(r.id)));
  const enabled = (id: string) => !removed.some(r => r.id === id);
  const add = (id: string, p: string, access: "all" | "write" = "all", what?: string) => paths.push(pathEntry(id, p, access, home, managedNames, what));
  if (o.builtins !== false) {
    if (enabled("credentials.files")) {
      for (const p of ["~/.ssh", "~/.aws", "~/.gnupg", "~/.netrc", "~/.codex/auth.json", "~/.claude/.credentials.json", "~/.claude/credentials.json", "~/.config/gh/hosts.yml", "~/.config/gcloud", "~/.gemini/oauth_creds.json", "~/.gemini/google_accounts.json", "~/.copilot", "~/.grok/auth.json", "~/.config/relay-keys"]) add("credentials.files", p);
      const keys = keyAuthority();
      if (keys.problem) throw new Error(`never credentials.files cannot resolve configured key stores: ${keys.problem}`);
      for (const p of keyPathsToDeny()) add("credentials.files", p);
    }
    if (enabled("credentials.relay-codex-home")) for (const p of [path.join(home, ".local/share/relay-codex-home"), ...(o.codexHome ? [o.codexHome] : [])]) add("credentials.relay-codex-home", p);
    if (enabled("credentials.keychain")) for (const p of [path.join(home, "Library/Keychains"), "/Library/Keychains"]) add("credentials.keychain", p);
    for (const [id, numbers] of [["service.sshd", [22]], ["service.screen-sharing", [5900]]] as const) {
      if (enabled(id)) for (const port of numbers) ports.push({ id, port, transport: "both", destinations: "this-machine" });
    }
    for (const p of configProtection().paths) add("relay.config", p);
    for (const part of relayWriteProtected()) add("relay.install", part.path, "write", part.what);
    // PC adds its pinned store to relayWriteProtected; retain the default before that merge too.
    add("relay.install", path.join(home, ".local/share/relay-codex-pins"), "write", "relay's pinned Codex installation");
    add("relay.authority", relayHome());
    // Worktrees need per-node exceptions. Their entire parent is NOT an all-read/all-write deny;
    // existing boundaryPaths/other-worktree rules enforce this authority at provider wiring.
  }
  cfg.paths.forEach(p => add(`user.path:${p.path}`, p.path, p.access));
  cfg.ports.forEach(p => ports.push({ id: `user.port:${p.port}/${p.transport}/${p.destinations}`, ...p }));
  return finish({ version: NEVER_VERSION, paths: unique(paths), ports: unique(ports), hosts: unique(cfg.hosts.map(h => ({ id: `user.host:${normalizeNeverHost(h)}`, host: normalizeNeverHost(h) }))), removed,
    keychain: o.builtins !== false && enabled("credentials.keychain"), authority: o.builtins !== false,
    authorityRoots, authorityPins: [], authorityPorts: o.builtins === false ? [] : rangePorts(),
    localAddresses: [...new Set(Object.values(os.networkInterfaces()).flatMap(list => (list ?? []).map(e => normalizeNeverHost(e.address.split("%")[0]))))].sort() });
}

/** A commutative union keeps every historical spelling/identity; removals grant nothing. */
export function mergeNeverPolicies(a: NeverPolicy, b: NeverPolicy): NeverPolicy {
  if (a.version !== NEVER_VERSION || b.version !== NEVER_VERSION) throw new Error("unsupported never policy version");
  const paths = unique([...a.paths, ...b.paths]), ports = unique([...a.ports, ...b.ports]);
  const keychain = a.keychain || b.keychain;
  const removed = unique([...a.removed, ...b.removed]).filter(r => !paths.some(p => p.id === r.id) && !ports.some(p => p.id === r.id) && !(r.id === "credentials.keychain" && keychain));
  return finish({ version: NEVER_VERSION, paths, ports, hosts: unique([...a.hosts, ...b.hosts]), removed, keychain, authority: a.authority || b.authority, localAddresses: unique([...a.localAddresses, ...b.localAddresses]), authorityRoots: unique([...a.authorityRoots, ...b.authorityRoots]), authorityPins: unique([...a.authorityPins, ...b.authorityPins]), authorityPorts: unique([...a.authorityPorts, ...b.authorityPorts]) });
}
export function validateNeverPolicy(value: unknown): NeverPolicy {
  const p = value as NeverPolicy;
  if (!p || p.version !== NEVER_VERSION || !Array.isArray(p.paths) || !Array.isArray(p.ports) || !Array.isArray(p.hosts) || !Array.isArray(p.removed) || !Array.isArray(p.localAddresses) || !Array.isArray(p.authorityRoots) || !Array.isArray(p.authorityPins) || !Array.isArray(p.authorityPorts) || typeof p.keychain !== "boolean" || typeof p.authority !== "boolean") throw new Error("malformed durable never floor");
  if (p.hash !== neverPolicyHash(p)) throw new Error("durable never floor hash mismatch");
  return immutable(p);
}

/** Historical identities remain denied; sealed Codex pin-store replacements require a new run. */
export function neverIdentityProblem(p: NeverPolicy): string | null {
  const pinStores = p.paths.filter(entry => entry.id === "relay.install" &&
    ["relay's pinned Codex installation", "relay's qualified Codex pin store"].includes(entry.what ?? "")).flatMap(entry => entry.aliases);
  const groups = new Map<string, { id: string; pins: NeverIdentity[]; sealedPins: NeverIdentity[] }>();
  for (const entry of [...p.paths, { id: "relay.authority", pins: p.authorityPins }]) for (const pin of entry.pins) {
    const group = groups.get(pin.path) ?? { id: entry.id, pins: [], sealedPins: [] };
    group.pins.push(pin);
    if (entry.id === "relay.install") group.id = entry.id;
    // The pin store's ancestors are ordinary install paths, even when a store entry pins them.
    if (pinStores.some(root => within(pin.path, root))) { group.id = "relay.install"; group.sealedPins.push(pin); }
    groups.set(pin.path, group);
  }
  for (const [name, { id, pins, sealedPins }] of groups) {
    const problem = (state: "changed" | "is unavailable") => `never ${id}: protected path identity ${state} at ${name}${id === "relay.install"
      ? "; it may have been replaced by a package-manager upgrade. Ask the person to start a fresh relay run (cancel this run, restart relay's MCP server for a per-session connection, or use a new session for a shared server), then start new work. Retrying, resuming or adopting this run does not create a fresh run."
      : state === "changed" ? "; refresh the checkpoint and decision" : ""}`;
    try {
      const st = fs.lstatSync(name);
      const matches = (pin: NeverIdentity) => !pin.missing && st.dev === pin.dev && st.ino === pin.ino && (st.mode & fs.constants.S_IFMT) === pin.kind && (pin.link === undefined || (st.isSymbolicLink() && fs.readlinkSync(name) === pin.link));
      // A live checkpoint may absorb ordinary CLI/runtime updates, but cannot bless a replaced
      // sealed pin-store object; only a fresh run drops those old pins.
      if (!pins.some(matches) || sealedPins.some(pin => !pin.missing && !matches(pin))) return problem("changed");
    } catch (err) {
      if (!["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "") || sealedPins.some(pin => !pin.missing) || !pins.some(pin => pin.missing)) return problem("is unavailable");
    }
  }
  return null;
}

/** root=true is for grants/overlays: a root holding a protected child is refused too. */
export function neverPathProblem(p: NeverPolicy, name: string, access: "read" | "write" | "test" | "link", root = false): string | null {
  if (!path.isAbsolute(name)) return "never path screen needs an absolute local path";
  const aliases = [folded(name), folded(canonical(name))];
  let inode: fs.Stats | undefined;
  try { inode = fs.statSync(name); } catch (err) { if (!["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) return "never path identity could not be checked"; }
  const sameInode = (entry: NeverPath) => inode && entry.pins.some(pin => pin.dev === inode.dev && pin.ino === inode.ino && entry.aliases.includes(pin.path));
  // A dedicated config directory, installation or authority root may sort before the file.
  // Explain an exact config-file denial by that file, including linked names and hard links,
  // rather than whichever broader protected resource happens to match first.
  const config = p.paths.find(entry => entry.id === "relay.config" && (entry.aliases.some(a => aliases.includes(folded(a))) || sameInode(entry)));
  if (config) return `${name} is relay's own config file ${config.path}, which no job may change (never relay.config)`;
  // Generic callers have no private-state exception. Compilers preserve their existing narrow
  // own-worktree/control access while denying every other authority root from these shared inputs.
  // A grant over the short link's parent could replace the link itself. Keep its entry name
  // protected even after it starts resolving to the current private root (or is repointed).
  const authority = p.authorityRoots.find(r => aliases.some(a => within(a, folded(r)) || (root && within(folded(r), a))) || (root && overlapsEntryAnyCase(name, r)));
  if (authority) return `never relay.authority refuses ${access} ${name} (protected authority root ${authority})`;
  for (const entry of p.paths) {
    if (entry.access === "write" && access !== "write" && access !== "link") continue;
    const match = entry.aliases.some(a => aliases.some(b => within(b, folded(a)) || (root && within(folded(a), b))));
    if (match || sameInode(entry)) {
      if (entry.id === "relay.config") {
        return `${name} overlaps relay's own config file ${entry.path}, which no job may change (never relay.config)`;
      }
      if (entry.id === "relay.install") {
        // Keep X1's explanation in the durable floor, including when a configured CLI later
        // disappears from the live protected sets. Older entries may lack its descriptive label.
        const what = entry.what ?? p.paths.find(x => x.id === entry.id && x.path === entry.path && x.what)?.what ?? "relay's protected installation";
        const why = what === "a directory on relay's PATH" ? "where a program put by a job would be run outside any sandbox" : "which relay runs outside any sandbox";
        return `${name} overlaps ${what} (${entry.path}), ${why}, so no job may change it (never relay.install)`;
      }
      return `never ${entry.id} refuses ${access} ${name} (protected ${entry.path})`;
    }
  }
  // An alias to an unenumerated child of a protected directory cannot be proved safe by its name.
  if (inode?.isFile() && inode.nlink > 1) return `never cannot screen a multiply-linked file ${name}`;
  return null;
}

export function neverEndpointProblem(p: NeverPolicy, e: NeverEndpoint): string | null {
  let host: string, addresses: string[];
  try { host = normalizeNeverHost(e.host); addresses = (e.addresses ?? []).map(normalizeNeverHost); } catch { return "never endpoint has an invalid or opaque authority"; }
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535 || !["tcp", "udp"].includes(e.transport)) return "never endpoint has an invalid port or transport";
  if (e.operation !== undefined && !["connect", "listen"].includes(e.operation)) return "never endpoint has an unknown operation";
  let cnames: string[];
  try { cnames = (e.cnames ?? []).map(normalizeNeverHost); } catch { return "never endpoint has an invalid CNAME"; }
  const hosts = [host, ...addresses, ...cnames];
  const forbidden = p.hosts.find(h => hosts.includes(h.host));
  if (forbidden) return `never ${forbidden.id} refuses ${e.operation ?? "connect"} ${host}:${e.port}`;
  return neverPortProblem(p, { ...e, host, addresses, cnames });
}

/** Port floor for an already validated authority and canonical numeric endpoints. DNS names
 * need no never-host normalization when there are no forbidden authorities to compare. */
export function neverPortProblem(p: NeverPolicy, e: NeverEndpoint): string | null {
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535 || !["tcp", "udp"].includes(e.transport)) return "never endpoint has an invalid port or transport";
  if (e.operation !== undefined && !["connect", "listen"].includes(e.operation)) return "never endpoint has an unknown operation";
  const host = e.host, hosts = [host, ...(e.addresses ?? []), ...(e.cnames ?? [])];
  const local = new Set(["127.0.0.1", "0.0.0.0", "::", "::1", ...p.localAddresses, ...(e.localAddresses ?? []).map(normalizeNeverHost)]);
  const thisMachine = (h: string) => h === "localhost" || /^127\./.test(h) || local.has(h);
  if (p.authorityPorts.includes(e.port) && (e.operation === "listen" || hosts.some(h => thisMachine(h) || net.isIP(h) === 6))) return `never relay.authority refuses ${e.operation ?? "connect"} ${e.transport} control/reserved port ${e.port}`;
  const port = p.ports.find(r => r.port === e.port && (r.transport === "both" || r.transport === e.transport) && (r.destinations === "any" || e.operation === "listen" || hosts.some(h => thisMachine(h) || net.isIP(h) === 6)));
  return port ? `never ${port.id} refuses ${e.operation ?? "connect"} ${e.transport} ${host}:${e.port}${hosts.some(h => net.isIP(h) === 6) && port.destinations === "this-machine" ? " (IPv6 service-port overblocking)" : ""}` : null;
}
export function neverGrantProblem(p: NeverPolicy, grant: { write_paths?: readonly string[]; raw_network?: boolean }, alreadyWritableRoots: readonly string[] = []): string | null {
  if (grant.raw_network && p.hosts.length) return "never.hosts disables raw network in Release A, including standing grants; request a qualified mediated route";
  for (const name of grant.write_paths ?? []) {
    const expanded = expandHome(name);
    const why = neverPathProblem(p, expanded, "write", true); if (why) return why;
  }
  // A link between two writable roots is safe; only names outside their complete union (or
  // under immutable metadata/protected paths) count as outside. Existing write sessions include
  // their own worktree; a newly delegated job has no existing worktree to include yet.
  if (grant.write_paths?.length) try {
    const roots = [...new Set([...alreadyWritableRoots, ...grant.write_paths].map(name => canonical(expandHome(name))))]
      .filter(name => { try { return fs.statSync(name).isDirectory(); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; throw err; } });
    const denied = [...p.paths.flatMap(x => x.aliases), ...roots.flatMap(root => [path.join(root, ".git"), path.join(root, ".relay"), ...HARNESS_CONFIG.map(name => path.join(root, name))])];
    const hard = hardLinksOutside(roots, { denied });
    if (hard.linked.length) return `never cannot grant a root with an outside hard link (${hard.linked[0]})`;
  } catch (err) { return `never cannot check grant identities: ${(err as Error).message}`; }
  return null;
}

/** Immutable inputs for WP2/WP4 compilers and mediated providers. OS/Mach rules stay mandatory. */
export const neverProfileInputs = (p: NeverPolicy) => ({ hash: p.hash, denyAll: unique(p.paths.filter(x => x.access === "all").flatMap(x => x.aliases)), denyWrite: unique(p.paths.filter(x => x.access === "write").flatMap(x => x.aliases)), ports: p.ports, pins: unique([...p.paths.flatMap(x => x.pins), ...p.authorityPins]), denyKeychain: p.keychain, protectAuthority: p.authority, authorityRoots: p.authorityRoots, authorityPorts: p.authorityPorts, ipv6ServicePortOverblocking: true as const });
export const neverProxyInputs = (p: NeverPolicy) => ({ hash: p.hash, hosts: p.hosts, ports: p.ports, authorityPorts: p.authorityPorts, localAddresses: p.localAddresses, rawAllowed: p.hosts.length === 0 });
export const neverHostedWebDisabled = (p: NeverPolicy): boolean => p.hosts.length > 0;
export function neverHostedWebProblem(p: NeverPolicy, effective: unknown): string | null {
  return neverHostedWebDisabled(p) && effective !== "disabled" ? 'never.hosts requires effective web_search="disabled" readback, withholding hosted search and web__run including open-page' : null;
}
