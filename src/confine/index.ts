import os from "node:os";
import { hardLinksOutside } from "./hardlinks.js";
import { within } from "./paths.js";
import { assertProbes, ConfinementRefused, probeBoundary, startDecoySemaphores, type ProbeReport } from "./probe.js";
import { boundaryPaths, canonical, seatbelt, type DirPin, type TokenFilePin } from "./seatbelt.js";
import { PROBES_ENABLED } from "./turn-probe.js";
import type { Stage2Network } from "./seatbelt-stage2.js";
import { TARGETS } from "../targets/index.js";

export { ConfinementRefused, type ProbeReport, type ProbeResult } from "./probe.js";
export { dirIdentity, tokenFileIdentity, tokenStoreProblem, quarantineTokenStore, type DirPin, type TokenFilePin } from "./seatbelt.js";

/**
 * Relay-owned confinement: the operating-system sandbox relay itself puts around a harness that
 * cannot be confined and verified through its own settings (Claude and Codex keep theirs). A
 * missing or non-enforcing mechanism means relay refuses such a harness; it never runs it unconfined.
 */

/** Network for a confined turn. Unix sockets and loopback stay closed in every mode except relay's own. */
export type NetworkPolicy =
  /**
   * Only the turn's CONNECT proxy (proxy.ts) on this loopback port, with this token; no DNS. The
   * launch environment points the harness at it. `openProxy(...).network` is this value.
   */
  | { mode: "off-except-proxy"; proxyPort: number; proxyToken: string }
  /** IPv4 to anywhere but this Mac's own addresses, and DNS; no IPv6 (seatbelt.ts NETWORK_ON, review R1). */
  | { mode: "on" }
  /** Stage 2 (docs/codex-confinement-design.md §5.1): outbound IP, loopback but denied ports, a TCP bind block. Codex's executor only. */
  | Stage2Network;

/**
 * Where a harness keeps its state during a confined turn, as its harness profile declares. Relay
 * never reads or copies credentials: a temporary home reaches the real login store only through
 * links to the files named, and the real store is writable only at the token files named.
 */
export interface HarnessState {
  /**
   * "temp" (the default): a fresh home inside the turn's temp dir, discarded with it; HOME and the
   * XDG directories point into it, so the harness loads none of the person's own configuration.
   * "real": the person's own home, readable but not writable, except the token files.
   */
  home: "temp" | "real";
  /** With "temp": the harness's own home variables (GROK_HOME, …), each set to this path inside the temporary home. */
  homeVars?: Record<string, string>;
  /** With "temp": links made inside the temporary home (path relative to it) to real login-store files the harness must read. */
  links?: Record<string, string>;
  /**
   * Specific files of the real login store the harness rewrites to refresh its login: their data
   * writable (rewrite in place), nothing beside them, and each checked before every turn to be a
   * regular file with one name, owned by this user, not a link; pin one (`tokenFileIdentity` at
   * setup) to refuse a turn when it has been replaced. Never directories, never executables, so never configuration
   * directories, hooks or binaries. A harness that refreshes by writing a new file and renaming it
   * into place cannot refresh under relay-enforced confinement.
   */
  tokenFiles?: (string | TokenFilePin)[];
  /**
   * A login directory in the person's home where the harness refreshes its login by writing a temp
   * file and renaming it into place (Grok's ~/.grok): see TokenStore. A stated downgrade.
   */
  tokenStore?: TokenStore;
  /** Environment the harness profile supplies, such as switching its auto-updater off. Cannot replace what relay sets. */
  env?: Record<string, string>;
  /**
   * Relay-owned state kept from turn to turn of one item (what resuming a session needs), outside
   * the turn's temp dir: a directory relay created and owns (mode 0700, the person's own, writable by
   * no one else), such as a harness home relay builds. Read-only to the agent except the `writable`
   * subdirectories (paths relative to `root`), which relay creates when missing. Before every turn
   * relay checks, without following links, that the root and each writable subdirectory, and every
   * directory between them, is a real directory and not a link: a writable subdirectory can be
   * deleted and replaced by the agent, and a link there would carry the next turn's writes out.
   */
  persistent?: { root: string; writable: string[] };
}

/**
 * A login directory where a confined turn may refresh its harness's login by temp file and rename,
 * and nothing else (docs/design-token-store.md; decision D10, 2026-10-17, "Exact-name
 * renames"). In it the turn may rewrite, create (as regular files), remove and rename onto exactly
 * the names in `files` and names matching `tempName`, rewrite and create the `locks` (not remove
 * them), and set the modes of its temp and token files; no link of any kind, no directory, no other
 * name, nothing in a subdirectory, no other file's mode. An exchange of two names (renamex_np
 * RENAME_SWAP) is the exception Seatbelt cannot refuse at a name that may be removed, the token's
 * or a temp name: relay checks the store after every turn as well as before; an unsafe store
 * fails the turn and its offending entries and token files are quarantined by rename before relay
 * reports it (review r_75bf1f48; the maintainer's quarantine decision, 2026-10-18). Before every turn relay checks the directory
 * (a real one, the person's own, writable by no one else, clear of every path the profile writes
 * or protects) and every name it would make writable that exists, looked up as the turn would (a
 * regular file of one name, the person's own, not executable, under exactly that name); it never
 * deletes there.
 */
export interface TokenStore {
  /** How doctor and the turn's log name it: "Grok's login directory". */
  name: string;
  /** The directory, absolute. */
  dir: string;
  /** Files whose data the turn may rewrite and which a rename may replace ("auth.json"). */
  files: string[];
  /** Names the turn may create and rewrite, not remove ("auth.json.lock"). */
  locks: string[];
  /**
   * The temp-name pattern, for one name: an anchored regular expression of literals, `\.` and
   * character classes, one at least repeated (`^\.[0-9]+\.[0-9]+\.tmp$`). It is the only
   * pattern written into the profile, so it is held to that form.
   */
  tempName: string;
}

/** What one turn may touch. Every path must be absolute; relay resolves symlinks before use. */
export interface ConfinementPolicy {
  /**
   * The directory the agent works in. When writable or pinned it, like every writable directory and
   * the temp dir, must exist and be a real directory, not a link, owned by this user; relay checks
   * before every turn.
   */
  worktree: string;
  /**
   * The job's worktree root as relay created it (`dirIdentity` then); `worktree` is it or lies
   * inside it. Before every turn the pinned path must still be reached through real directories
   * only, and be the same directory (device and inode), or the turn is refused.
   */
  worktreePin?: DirPin;
  /** Write turns may write the worktree; read turns may not. Its `.git` is never writable. */
  worktreeWritable: boolean;
  /**
   * For a turn in a job's worktree: its git directory and worktree as the repository records them
   * (git.ts jobTree, the env relay's own git runs with). The profile then denies those, not wherever
   * the worktree's `.git` file, which the agent can rewrite, points.
   */
  gitEnv?: { GIT_DIR: string; GIT_WORK_TREE: string };
  /** Further directories the root granted for writing. */
  writable?: string[];
  /** Additional immutable runtime trees from the turn's saved config: readable/executable, never writable. */
  writeDenied?: string[];
  /** Each `writable` entry's identity as relay pinned it when the grant was authorised (dirIdentity), index-aligned. When present, a turn verifies the grant still resolves to that same directory through real directories only, so an intermediate symlink cannot redirect it. */
  writablePins?: DirPin[];
  /** Exact file additions; pinned and rechecked at the final launch gate. */
  overlayFiles?: import("../core/restart-overlay.js").OverlayRecord["request"]["roots"];
  /** Trusted consumed overlay roots, for scratch-only positive boundary controls. */
  overlayRoots?: import("../core/restart-overlay.js").OverlayRecord["request"]["roots"];
  neverPolicy?: import("../core/never-policy.js").NeverPolicy;
  /** The harness's per-turn state directories (writable); they must exist and lie inside `tmpDir`. */
  stateDirs?: string[];
  /**
   * Further executables or directories of executables the turn may run, beyond the system's, the
   * usual package-manager and developer-tool locations, the harness itself, relay's Node and the
   * writable directories: the harness's interpreter when it is found through `env`, toolchains in the
   * person's home (rustup, nvm, uv, …). Anything else cannot be executed.
   */
  execPaths?: string[];
  /** Where the harness keeps its state; a temporary home when absent. */
  state?: HarnessState;
  /** The turn's private temporary directory (writable); the launch points TMPDIR at it. */
  tmpDir: string;
  /** A short, readable label for this turn (its ids), put on the profile's deny-default rule so relay can stream this turn's sandbox denials (diagnostics.ts). Derived from the temp dir when absent. */
  tag?: string;
  /** Neither readable nor writable, whatever else allows. Relay's control directory is always added. */
  denied: string[];
  /**
   * The turn's own pseudo-terminal slave (/dev/ttysNNN), when the harness is given one; no other
   * terminal is reachable. Relay launches harnesses detached (a new session, no controlling terminal).
   */
  tty?: string;
  /** The turn's bridge socket (see broker.ts), the one Unix socket the agent may connect to. */
  bridgeSocket?: string;
  /**
   * The bridge secret's file (Broker.secretFile), beside `bridgeSocket` in the turn's own broker
   * directory: the one file there the turn may read, for a harness whose own tool helper presents the
   * secret instead of relay's bridge (Gemini's tool discovery, backends/gemini.ts). Every other turn's
   * profile keeps denying it with the rest of relay's sockets directory. Requires bridgeSocket.
   */
  bridgeSecret?: string;
  network: NetworkPolicy;
  /** Lets the harness reach the keychain. A stated downgrade: it can then read other items its tools are trusted for. */
  keychain?: boolean;
  /**
   * Lets the harness reach the system's certificate trust daemons (trustd, ocspd), which a harness
   * that checks certificates through the system needs (Go's TLS, the Security framework; Node does
   * not). A stated downgrade: they fetch from URLs their caller supplies (revocation and issuer
   * lookups), a way out that the network rules do not see.
   */
  certificateTrust?: boolean;
}

/**
 * A confined command line, and the environment the launch must add to the harness's own (TMPDIR,
 * and with the network off the proxy variables, which override any the harness inherits).
 */
export interface ConfinedLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** SHA-256 of the confinement itself (the profile text and every parameter), which the probe report is bound to. */
  fingerprint: string;
  /** SHA-256 of the rules alone (the profile text, without its parameters): the same for a decoy aimed at by the same rules. */
  rules: string;
  /** The label on the profile's deny-default rule, appended to every denial the kernel logs for this turn (diagnostics.ts). */
  diagnosticTag: string;
  /** Another command line under exactly this confinement (same profile, same parameters): how the boundary probes run. */
  rewrap(command: string, args: string[]): { command: string; args: string[] };
}

export interface Confinement {
  readonly id: string;
  /** Null when this mechanism enforces on this machine; otherwise why it cannot. */
  unavailable(): string | null;
  /** The command line that runs `command` with `args` under `policy`. Throws when the policy cannot be expressed safely. */
  wrap(policy: ConfinementPolicy, command: string, args: string[]): ConfinedLaunch;
  /** Asks the kernel whether a running process is confined. Evidence for the launch, not the boundary itself. */
  confined(pid: number): boolean;
}

/** The confinement mechanism for this platform, or why there is none (callers then refuse the harness). */
export function confinement(): { mechanism: Confinement } | { reason: string } {
  if (process.platform !== "darwin") return { reason: `relay has no confinement mechanism for ${process.platform} yet` };
  const reason = seatbelt.unavailable();
  return reason ? { reason } : { mechanism: seatbelt };
}

/**
 * Everything relay does before a confined launch, in order: the hard-link check across every
 * writable directory (hardlinks.ts); wrap the command for this turn; then the boundary probes under exactly that
 * confinement. Throws ConfinementRefused, naming the failed
 * check, when the launch must not happen, or "stopped" once `signal` (the worker's stop) is aborted.
 * Nothing is cached; call it for every turn.
 */
export async function prepareLaunch(mechanism: Confinement, policy: ConfinementPolicy, command: string, args: string[], signal?: AbortSignal, environment?: NodeJS.ProcessEnv): Promise<{ launch: ConfinedLaunch; probes: ProbeReport }> {
  const stopped = () => {
    if (signal?.aborted) throw new ConfinementRefused("stopped", "the turn was stopped while relay was preparing its sandbox, so it does not launch the harness");
  };
  stopped();
  let paths: ReturnType<typeof boundaryPaths>;
  try {
    paths = boundaryPaths(policy);
  } catch (err) {
    throw new ConfinementRefused("boundary", (err as Error).message);
  }
  // The probes put their outside targets in the system temp dir: a turn that may write there (a
  // shared temp dir passed as tmpDir) cannot be probed, and is refused before anything is walked.
  const systemTmp = canonical(os.tmpdir());
  if (paths.writable.some((w) => within(systemTmp, w))) {
    throw new ConfinementRefused("outside-target", `relay cannot probe this turn's confinement: the system temporary directory ${systemTmp} is writable to it (is tmpDir the shared temporary directory?)`);
  }
  // The probes' decoy semaphores take an osascript start to make (probe.ts): begun now, they are made
  // while the hard-link walk and the wrap run. The probes remove them as they finish; this removes
  // them too, on every path, so that they go whether or not the probes were reached or got as far
  // as their own clean-up (a second removal settles with the first).
  const semaphores = startDecoySemaphores();
  try {
    let linked: string[];
    try {
      // The configuration the profile protects inside writable roots counts as outside too: an alias of it
      // under an ordinary name would let writes through to it (review r_7feaed80 X1).
      ({ linked } = hardLinksOutside(paths.writable, { denied: [...paths.hardDenied, ...paths.configDenied] }));
    } catch (err) {
      throw new ConfinementRefused("hardlink", `relay could not check this turn's writable directories for hard links (${(err as Error).message}), so it does not launch the harness`);
    }
    if (linked.length) {
      throw new ConfinementRefused("hardlink", `relay will not launch this turn: ${linked[0]} is a hard link to a file that also has a name the turn may not write (outside its writable directories, or a path the sandbox always denies), and the sandbox, which decides by path, would let writes through to it. Replace it with a copy (pnpm: use a copying package-import method) and try again.`);
    }
    stopped();
    const launch = mechanism.wrap(policy, command, args);
    // A login store is probed on a decoy of relay's own under the same rules, wrapped the same way.
    const probes = await probeBoundary(launch, policy, { harness: command, signal, env: environment, wrap: (p) => mechanism.wrap(p, command, args), semaphores });
    assertProbes(probes);
    return { launch, probes };
  } finally {
    await semaphores.remove();
  }
}

/**
 * What relay-enforced confinement guarantees on this machine and what it does not, for `relay doctor`
 * and docs/security-model.md. Reads nothing beyond whether the mechanism exists; runs no probe.
 */
export function confinementSummary(): { available: boolean; enabled: boolean; status: string; enforces: string[]; doesNot: string[] } {
  const found = confinement();
  const targets = TARGETS.filter((t) => t.capabilities.confinement === "relay-enforced");
  const hosts = targets.map((t) => `${t.name}: ${(t.apiHosts ?? []).join(", ")}`).join("; ");
  // A build with PROBES_ENABLED false (turn-probe.ts) launches nothing that needs it, and says so.
  const off = "relay-enforced confinement is built but not enabled in this version of relay";
  return {
    available: "mechanism" in found,
    enabled: PROBES_ENABLED,
    status: !PROBES_ENABLED
      ? `${off} (${"mechanism" in found ? "Seatbelt through /usr/bin/sandbox-exec is present" : `it could not run here anyway: ${found.reason}`}): relay refuses every harness that needs it; Claude and Codex keep verified confinement`
      : "mechanism" in found
        ? "relay-enforced confinement available (Seatbelt through /usr/bin/sandbox-exec), for harnesses whose own sandbox relay cannot verify; Claude and Codex keep verified confinement"
        : `relay-enforced confinement unavailable: ${found.reason}. Relay refuses harnesses that need it; Claude and Codex keep verified confinement`,
    enforces: [
      `registered relay-enforced targets: ${targets.map((t) => t.name).join(", ")}; these rules apply whenever one is switched on and admitted`,
      "writes only to the worktree (write jobs), granted directories, the turn's temp dir, the writable subdirectories its profile names of state relay keeps for the harness between turns (Copilot: session-state and turn; Grok: sessions and turn; Gemini: .cache, containing its runtime directory .cache/.gemini and its sessions) and named token files; in a login store a target declares (a stated downgrade; Grok's ~/.grok), only its token and lock names and one temp-name pattern, as regular files, with no link, directory or other name and nothing in a subdirectory, each existing one checked before and after every turn to be a regular file of one name under exactly that name, and probed on a decoy store under the same rules; the harness's home is a temporary one in the turn's temp dir (Grok, Gemini) unless its profile keeps the person's own, readable and not writable (Copilot); never the worktree's .git or a granted repository's .git, relay's control directory, other worktrees, the real home, harness configuration or binaries; and harness and developer-tool configuration an agent could plant at the top of a writable root (.claude, .codex, .gemini, .mcp.json, .envrc, .vscode, shell rc files, .gitconfig, and the like) is neither created, written nor removed, though a project's own stays readable; the worktree and writable directories themselves are never removed, renamed or replaced, and are checked to be the same real directories before every turn",
      "no reads, writes, directory listing or existence tests of relay's Codex home (by default ~/.local/share/relay-codex-home), the default API key directory (~/.config/relay-keys), or of a key file moved elsewhere by ~/.config/relay/local.json (the moved file alone, not its directory); these denials apply to every relay-enforced target, even when Gemini is switched off; scratch regressions confirm Seatbelt file-read* denials hold through case-swapped and /System/Volumes/Data spellings",
      "network on (granted): IPv4 to anything but this Mac's own addresses (loopback, the LAN and tailnet addresses it holds, their IPv4-mapped spellings), and no IPv6 at all, since Seatbelt can refuse those spellings only by refusing IPv6; no listening on the network",
      "Codex with grant.raw_network (stage 2, switched on by targets.codex.stage2): Codex's command executor runs under these rules, with stage 2's network instead of network on: any host over IP, raw TCP, UDP, ssh and DNS, but not this Mac's own addresses on the denied ports (a static list, every TCP port anything on this Mac listens on at turn start, and relay's reserved range but the job's block), their IPv4-mapped spellings included, and so no IPv6 to those ports at any host, and no UDP to ports 1900 or 5351; TCP listening only on the job's block of ports; Unix sockets under the turn's temp dir, and a relay-made worktree on write turns; the app server stays outside, its own local actions switched off and read back",
      "Codex with stage-2 mediated or no raw network: the executor's own reserved listener still starts, but the PORT/PORTS block is reserved and denied; only person-consented raw network or an explicit listen/port-0 restart overlay opens block binding. A localhost-connect overlay adds no listener authority",
      `network off: only relay's proxy for the turn, which tunnels HTTPS to the exact API hosts the target declares (${hosts}) and nothing else, its telemetry included; no DNS, IP literals, private addresses, this machine's own addresses or cloud-metadata endpoints; no loopback but the proxy, which closes with the turn; except that a harness taking the certificate-trust downgrade (Copilot) can have the system's trust daemons fetch URLs it supplies, past the proxy; Grok takes that downgrade too, Gemini does not`,
      "Unix sockets only of the turn's own, under its temp dir, its bridge to relay, and the system log's (connected to, as every process's logging does); network-on additionally permits the mDNSResponder resolver socket; other turns' bridges are neither listable nor reachable; no routing sockets",
      "either way: no LaunchServices, Apple events or launchctl, no signals to processes outside the sandbox, no terminal but the turn's own (those it opens itself, and one relay gives it)",
      "Mach services only from a fixed list (directory lookups, preferences, notifications, logging); network-on adds dnssd, mDNSResponder, configd, DNSConfiguration, networkd and nehelper resolver services; no XPC services; no pasteboard; no IOKit user client",
      "no inspection of processes outside the sandbox: not their paths or details, not the list of processes, not their command lines or environment; process-info and sysctl kern.procargs2 permit inspection of same-sandbox processes, including their start-up environment",
      "named POSIX semaphores only under /mp- (Python's multiprocessing), any other name out of reach; no mutating fcntl or fsctl (no alternate chflags), and sysctl writes only to kern.grade_cputype",
      "executables only from system, Homebrew, /usr/local and developer-tool locations, the harness, relay's Node and the writable directories",
      "boundary probes under each turn's exact sandbox before every launch, and a hard-link check of every writable directory; any failure refuses the launch",
    ],
    doesNot: [
      "confine reads: everything you can read is readable, except relay's control directory, its sockets directory, its protected config and install paths, relay's Codex home (by default ~/.local/share/relay-codex-home), the default API key directory (~/.config/relay-keys), and a key file moved elsewhere by ~/.config/relay/local.json",
      "protect credentials the harness can read (its own login, other tools' files); the target's API stays reachable, so network off means the target's API hosts only, and for Copilot those include api.github.com, GitHub's whole REST API, where any token the agent holds or reads (its own login is readable through the keychain downgrade) can also change things, as far as that token's permissions allow",
      "allow escalation in 1.0: approval requests from such harnesses are reported, never run outside the sandbox",
      "keep a harness whose profile takes a stated downgrade from what it opens: the keychain (Copilot's login is there; other items its tools are trusted for become readable) or the certificate trust daemons (Copilot checks GitHub's certificates through them; they fetch from URLs their caller supplies, a way out the proxy does not see), or a login store (the harness may replace its token file there with any regular file it writes; and an exchange of two names, which Seatbelt cannot refuse where a rename must be allowed, can put a link at the token's name: relay immediately quarantines unsafe entries and the token files by rename as soon as the turn ends, fails the turn and requires a fresh login before further turns; a failed move is reported loudly; your own harness running concurrently during the turn could still follow the link before quarantine)",
      "stop an agent running a copy of a program it placed in a writable directory (the rules above still bind it)",
      "close the local network or tailnet to a raw-network stage-2 Codex job (Seatbelt cannot express address ranges), or a denied service reached back through a router port forward, NAT hairpin, a tailnet subnet router or a VM bridge; nor deny a local service started after the turn begins; when raw/listen/port-0 authority opens the block, a block port bound on 0.0.0.0 is visible on the LAN and tailnet",
      "isolate named POSIX semaphores under /mp- (where Python's multiprocessing makes its own): that namespace is machine-wide, so another process's /mp- semaphore can be opened, posted or unlinked by a confined process that knows its name; the name is random and there is no call to list them, and Codex's and Claude Code's own runtimes allow semaphores with no name limit at all",
      "keep the turn's proxy credentials out of the harness's environment: HTTPS_PROXY and the like must carry them; the turn's own processes can read each other's start-up environment, including its proxy token, as can your own processes outside the sandbox; other relay-enforced profiles cannot inspect it or connect to this turn's proxy; other loopback-capable processes can connect but need its token; Gemini's API key is handed over ACP, never in an environment",
    ],
  };
}
