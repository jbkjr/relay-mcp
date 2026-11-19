import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { relayHome } from "../core/config.js";
import { configProtection, relayWriteProtected, relayCredentialProtected } from "../core/protected-config.js";
import type { Confinement, ConfinedLaunch, ConfinementPolicy, TokenStore } from "./index.js";
import { within } from "./paths.js";
import { PROXY_TOKEN, proxyEnv } from "./proxy.js";
import { relaySocketsDir } from "./sockets.js";
import { stage2NetworkRules } from "./seatbelt-stage2.js";
import { neverSeatbeltRules } from "./seatbelt-never.js";
import { assertOverlayRoot } from "../core/restart-overlay.js";
import { HARNESS_CONFIG } from "./harness-config.js";

export { HARNESS_CONFIG } from "./harness-config.js";

/**
 * macOS Seatbelt through `sandbox-exec`, ported from docs/research/seatbelt-prototype/profile.ts.
 *
 * The profile is deny-default with a condensed version of Codex's base allowlist. It holds no path:
 * every path reaches sandbox-exec as a `-D` parameter, resolved and checked first, so no path can
 * change the profile's meaning.
 *
 * Rule precedence, as measured on macOS 27.0.1 (26A434; docs/design-token-store.md): between rules on
 * the same operation, the last that matches wins, so the hard denies come last. But a rule that names
 * a specific operation (file-write-data, file-write-create, file-write-unlink, file-test-existence, …)
 * takes precedence over one on its wildcard family (file-write*, file-read*) whatever their order: a
 * later `(deny file-write* X)` does not override an earlier `(allow file-write-create X)`, and an
 * earlier `(deny file-write-create X)` is not overridden by a later `(allow file-write* X)`. So every
 * deny that must beat an operation-specific allow names that operation too, and comes after it; a
 * generator test (test/confine.test.ts, "rule precedence") checks the whole profile for both.
 */

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** fcntl commands that modify a file through a read-only descriptor (<sys/fcntl.h>; 80 is private). */
export const F_MAKECOMPRESSED = 80;
export const F_TRANSFEREXTENTS = 110;

/**
 * A path as Seatbelt sees it. Seatbelt matches resolved paths (`/tmp` is `/private/tmp`), so the
 * longest existing prefix is resolved and the rest appended. Refuses what cannot be a safe parameter.
 */
export function canonical(p: string, what = "path"): string {
  if (typeof p !== "string" || !p) throw new Error(`${what} is empty`);
  if (/[\0\r\n]/.test(p)) throw new Error(`${what} contains a NUL or line break: ${JSON.stringify(p)}`);
  if (!path.isAbsolute(p)) throw new Error(`${what} is not absolute: ${JSON.stringify(p)}`);
  let abs = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = path.join(fs.realpathSync.native(abs), ...tail);
      if (/[\0\r\n]/.test(real)) throw new Error(`${what} resolves through a name with a line break: ${JSON.stringify(real)}`);
      return real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
      tail.unshift(path.basename(abs));
      const up = path.dirname(abs);
      if (up === abs) return path.join(abs, ...tail);
      abs = up;
    }
  }
}

/**
 * A short label for this turn's sandbox, put on the profile's `(deny default)` rule and appended to
 * every denial the kernel logs, so relay can stream just this turn's denials (diagnostics.ts) and a
 * harness that cannot work inside the profile says which rule stopped it. Deterministic from the
 * policy (the turn's temp dir is unique to it), so wrapping a policy twice gives one profile; a
 * caller may pass its own readable label in `policy.tag`.
 */
export function diagnosticTag(policy: ConfinementPolicy): string {
  if (policy.tag !== undefined) {
    if (!/^[A-Za-z0-9 ._:/-]{1,64}$/.test(policy.tag)) throw new Error(`the turn's diagnostic tag may only be short and plain: ${JSON.stringify(policy.tag)}`);
    return `relay-sandbox ${policy.tag}`;
  }
  return `relay-sandbox ${crypto.createHash("sha256").update(canonical(policy.tmpDir, "tmpDir")).digest("hex").slice(0, 16)}`;
}

const hardDeniedCovers = (p: string, denied: string[]) => denied.some((d) => within(p, d));

const BASE = `
; --- process model: children inherit this profile; no signals or inspection outside it.
; What may be executed is listed per turn (see EXEC below); forking is free.
(allow process-fork)
(allow signal (target same-sandbox))
; deny-default leaves process information open, so it is closed explicitly, then opened to the
; turn's own processes (the process itself among them).
(deny process-info*)
(allow process-info* (target same-sandbox))

; --- reads: broad, as Claude's and Codex's sandboxes allow (denied directories are carved out below)
(allow file-read*)
(allow file-test-existence)

; --- devices and terminals
(allow file-read* file-write-data file-ioctl
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")
  (literal "/dev/ptmx") (regex #"^/dev/fd/[0-9]+$"))
; (no terminal by pattern: /dev/ttysNNN would reach the person's other sessions; the turn's own, if any, is a parameter)
(allow pseudo-tty)

; --- sysctls: by name, what the system's libraries, Node, git and the shells read (found from the
; sandbox's own denials). No kern.* prefix: kern.proc.* and kern.procargs2 would describe every
; process, and the command line and environment of each.
(allow sysctl-read
  (sysctl-name-prefix "hw.optional.") (sysctl-name-prefix "hw.perflevel")
  (sysctl-name "hw.activecpu") (sysctl-name "hw.byteorder") (sysctl-name "hw.cacheconfig") (sysctl-name "hw.cachelinesize")
  (sysctl-name "hw.cachesize") (sysctl-name "hw.cpufamily") (sysctl-name "hw.cpufrequency") (sysctl-name "hw.cpufrequency_max")
  (sysctl-name "hw.cpusubfamily") (sysctl-name "hw.cpusubtype") (sysctl-name "hw.cputype") (sysctl-name "hw.l1dcachesize")
  (sysctl-name "hw.l1icachesize") (sysctl-name "hw.l2cachesize") (sysctl-name "hw.l3cachesize") (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.logicalcpu_max") (sysctl-name "hw.machine") (sysctl-name "hw.memsize") (sysctl-name "hw.model") (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels") (sysctl-name "hw.packages") (sysctl-name "hw.pagesize") (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max") (sysctl-name "hw.tbfrequency") (sysctl-name "hw.vectorunit")
  (sysctl-name "hw.pagesize_compat") (sysctl-name "hw.cachelinesize_compat") (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.cpufrequency_compat") (sysctl-name "hw.tbfrequency_compat") (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat") (sysctl-name "hw.l2cachesize_compat") (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name-prefix "machdep.cpu.")
  (sysctl-name "kern.argmax") (sysctl-name "kern.boottime") (sysctl-name "kern.hostname") (sysctl-name "kern.maxfiles")
  (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.maxproc") (sysctl-name "kern.ngroups") (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osvariant_status") (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel") (sysctl-name "kern.usrstack64") (sysctl-name "kern.version") (sysctl-name "kern.iossupportversion")
  (sysctl-name "kern.safeboot")
  ; read-only limits and versions behind the sysconf() values runtimes read (Python's
  ; multiprocessing: SC_SEM_NSEMS_MAX, SC_AIO_MAX, SC_SAVED_IDS, SC_VERSION). None names a process.
  (sysctl-name-prefix "kern.sysv.") (sysctl-name "kern.aiomax") (sysctl-name "kern.aioprocmax")
  (sysctl-name "kern.saved_ids") (sysctl-name "kern.posix1version")
  (sysctl-name "sysctl.proc_cputype") (sysctl-name "sysctl.name2oid") (sysctl-name "vm.loadavg") (sysctl-name-prefix "net.routetable."))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))

; --- IPC that libSystem, Node, Rust std and git need. Named POSIX semaphores only under /mp-, the
; prefix Python's multiprocessing names its own with (/mp-<random>; decided 2026-10-16): that namespace
; is machine-wide, so another process's /mp- semaphore is reachable by its random name, which there
; is no call to list; any other name (another program's semaphores) stays closed. No system-fsctl (FSIOC_CAS_BSDFLAGS,
; an alternate chflags, would change a file's BSD flags through a mutating fsctl); nothing needs it.
; No iokit-open: RootDomainUserClient (IOPMrootDomain) carries power-policy setters, not only queries,
; and no harness relay launches opens it (Codex's base and srt allow it for power assertions, which
; relay's harnesses do not make).
(allow ipc-posix-sem (ipc-posix-name-prefix "/mp-"))
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs.") (ipc-posix-name "apple.shm.notification_center"))
(allow user-preference-read)
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
; Mach services by global name, each for what it serves every process: user and group lookups
; (opendirectoryd), per-user temporary directories (dirhelper), preferences (cfprefsd: allowed because
; reads are broad anyway; under narrower reads it would expose files outside them), notifications
; (notifyd), and logging (without diagnosticd every process floods the log with denials). The
; certificate trust daemons are a per-harness downgrade (TRUST below); nothing else is reachable.
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.logd") (global-name "com.apple.system.logger") (global-name "com.apple.diagnosticd"))
; the system log's socket: a local log, which Codex's profile allows too (no other Unix socket is
; reachable but the turn's own and its bridge, below)
(allow network-outbound (literal "/private/var/run/syslog"))
`;

const KEYCHAIN = `
; --- keychain (a stated downgrade: other items its tools are trusted for become readable)
(allow mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc")
  (global-name "com.apple.security.agent") (global-name "com.apple.security.keychainsyncingoveridsproxy"))
; The keychain-change notification segment is read only: reading it lets a keychain reader notice a
; change; writing it is how a keychain modifier announces one, which relay's login-reading harnesses never do.
(allow ipc-posix-shm-read* (ipc-posix-name "com.apple.AppleDatabaseChanged"))
`;

const TRUST = `
; --- certificate trust (a stated downgrade: these daemons fetch from URLs their caller supplies, for
; revocation and issuer lookups, a way out the network rules do not see). Go's TLS and the Security
; framework need them; Node does not.
(allow mach-lookup (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.ocspd"))
`;

const NETWORK_ON = `
; --- network on: IPv4 anywhere but this Mac's own addresses, and DNS; no IPv6. Still no Unix sockets
; but the turn's own and the bridge, and no listening. Creating IP and Unix sockets needs no rule;
; kernel-control sockets (AF_SYSTEM, SYSPROTO_CONTROL), which the network stack uses, do. Not every
; domain: that would open routing sockets (AF_ROUTE) too.
; IPv4 only (review R1, measured on macOS 27.0.1): "localhost" matches this Mac's addresses but not
; their IPv4-mapped spellings, loopback's apart, so ::ffff:0.0.0.0 and ::ffff:<an interface address>
; reached its services past (remote ip "localhost:*"); only (remote ip6 "*:*") refuses them, all IPv6
; with them. No rule says "ip": beside an ip4 or ip6 rule, an "ip" rule matched other addresses (measured).
(allow network-outbound (remote ip4 "*:*"))
(deny network-outbound (remote ip4 "localhost:*"))
(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.mDNSResponder")
  (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.networkd") (global-name "com.apple.nehelper"))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
`;

/**
 * Executables every turn may run, by resolved path: the system's (SIP-protected) and the usual
 * package-manager and developer-tool locations. The harness, relay's own Node (the bridge, the
 * probes), the policy's `execPaths` and the turn's writable directories are added per turn.
 */
const EXEC_SYSTEM = `
  (subpath "/bin") (subpath "/sbin") (subpath "/usr/bin") (subpath "/usr/sbin") (subpath "/usr/libexec")
  (subpath "/System/Library") (subpath "/System/Cryptexes") (subpath "/System/Volumes/Preboot/Cryptexes") (subpath "/Library/Apple")
  (subpath "/Library/Developer/CommandLineTools") (regex #"^/Applications/Xcode[^/]*\\.app/Contents/Developer/")
  (subpath "/opt/homebrew") (subpath "/usr/local")`;

/** A file is allowed by name, a directory with everything under it. */
const execFilter = (p: string, param: string) => {
  let dir = false;
  try {
    dir = fs.statSync(p).isDirectory();
  } catch {}
  return dir ? `(subpath ${param})` : `(literal ${param})`;
};

/** The interpreter a script names on its `#!` line, when it names one directly (not through `env`). */
function shebang(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(256);
    const line = buf.subarray(0, fs.readSync(fd, buf, 0, 256, 0)).toString("latin1").split("\n")[0];
    const m = /^#!\s*(\/\S+)/.exec(line);
    return m && m[1] !== "/usr/bin/env" ? m[1] : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The resolved paths a policy's boundary is made of, checked: what the profile writes as parameters,
 * and what the host-side checks (hard links, probes) must agree with. `hardDenied` are the paths
 * the profile denies whatever else allows (last-match), among them the denied directories. `fixed`
 * are the paths that may not be removed, renamed or made again (see below).
 *
 * Seatbelt decides by path, and a writable `subpath` also allows unlinking or renaming the root
 * itself and any directory inside it. So a turn could rename its worktree away and leave a link,
 * which the next turn's resolved paths would follow, or carry a protected path out from under its
 * rule (move the worktree into its temp dir, rewrite `.git` there, move it back). Hence `fixed`:
 * every writable root, the worktree, and every ancestor, inside a writable root, of those and of
 * every hard-denied path; the profile denies unlink and create on each, as final rules. And before
 * every turn the worktree and each writable root are checked without following links (rootDir,
 * checkPin), so a swap that got through anyway refuses the turn.
 */
export function boundaryPaths(policy: ConfinementPolicy) {
  const worktree = canonical(policy.worktree, "worktree");
  const tmpDir = canonical(policy.tmpDir, "tmpDir");
  // Relay's control directory is denied whatever the caller passes.
  // So is the directory holding relay's own sockets (every turn's broker, sockets.ts).
  const config = configProtection();
  const relayProtected = [canonical(relayHome(), "relay's control directory"), canonical(relaySocketsDir(), "relay's sockets directory"), ...config.paths.flatMap((p) => [canonical(p, "relay's config or install file"), p]),
    ...relayCredentialProtected().flatMap((p) => [canonical(p.path, p.what), p.path])];
  const denied = [...new Set([...relayProtected, ...policy.denied.map((d, i) => canonical(d, `denied[${i}]`))])];
  // What relay runs outside the sandbox (review r_0c11d860 X1): its own package (dist/, its native
  // helper), the Node it runs on, its git, every target's CLI (name, file, installation) and the
  // directories on its PATH. Readable, since a harness may run them, but never written, whatever
  // the caller passes.
  const installDenied = [...new Set([
    ...relayWriteProtected().flatMap((x) => [canonical(x.path, "relay's installation"), path.resolve(x.path)]),
    ...(policy.writeDenied ?? []).flatMap((p) => [canonical(p, "write-denied runtime tree"), path.resolve(p)]),
  ])].filter((x) => !hardDeniedCovers(x, denied));
  // State directories are the turn's own: anything that outlives the turn is reached only through token files.
  const stateDirs = (policy.stateDirs ?? []).map((p, i) => canonical(p, `stateDirs[${i}]`));
  for (const d of stateDirs) if (!within(d, tmpDir)) throw new Error(`state directory ${d} is not inside the turn's temporary directory ${tmpDir}`);
  const grants = (policy.writable ?? []).map((p, i) => canonical(p, `writable[${i}]`));
  // A granted directory relay pinned at authorisation: it must still be that same directory, reached
  // through real directories only, so an agent granted an ancestor cannot redirect another grant
  // through an intermediate symlink (review C4/X2). When pins are supplied there must be exactly one
  // per grant and each must be valid — a missing or malformed pin fails the turn closed, so a legacy
  // grant authorised before relay pinned grants is refused until the root grants it again (review X2).
  if (policy.writablePins !== undefined) {
    if (policy.writablePins.length !== grants.length) {
      throw new Error(`relay-enforced confinement needs exactly one pin per granted directory (${grants.length} grants, ${policy.writablePins.length} pins). A grant authorised before relay pinned grants must be granted again by the root session.`);
    }
    grants.forEach((g, i) => checkGrantPin(policy.writablePins![i], g, i));
  }
  const granted = [...(policy.worktreeWritable ? [worktree] : []), ...grants, ...stateDirs];
  const persistent = policy.state?.persistent ? persistentState(policy.state.persistent) : null;
  if (persistent) {
    // Read-only means no writable root may reach into it, nor it into one.
    for (const w of [...granted, tmpDir, worktree]) {
      if (within(persistent.root, w) || within(w, persistent.root)) throw new Error(`relay-owned state ${persistent.root} overlaps ${w}, which would make it writable or put the turn inside it`);
    }
  }
  const writable = [...granted, ...(persistent?.writable ?? []), tmpDir];
  const tokenFiles = (policy.state?.tokenFiles ?? []).map((f, i) => tokenFile(f, `state.tokenFiles[${i}]`));
  // A writable root inside a denied directory would be silently unusable: a mistake in the caller.
  for (const w of [...writable, ...tokenFiles, ...(persistent ? [persistent.root] : [])]) {
    const d = [...denied, ...installDenied].find((x) => within(w, x));
    if (d) throw new Error(`writable path ${w} lies inside denied directory ${d}`);
  }
  // Each root as found now, without following links: the worktree when writable or pinned (a read
  // turn's may be the person's own directory, reached through their own link, and carries no
  // writes), against relay's pin when it has one; the grants, the state directories and the temp
  // dir. Persistent state is checked above.
  if (policy.worktreeWritable || policy.worktreePin !== undefined) rootDir(policy.worktree, "the worktree");
  if (policy.worktreePin !== undefined) checkPin(policy.worktreePin, worktree);
  (policy.writable ?? []).forEach((p, i) => rootDir(p, `writable[${i}]`));
  (policy.stateDirs ?? []).forEach((p, i) => rootDir(p, `stateDirs[${i}]`));
  rootDir(policy.tmpDir, "tmpDir");

  const git = policy.gitEnv ? trustedGitDirs(worktree, policy.gitEnv) : gitDirs(worktree);
  const gitPointer = git.pointer;
  // A .git made between the worktree and the repository's top (the worktree's own included) would
  // hide the real repository from the next turn's discovery: denied wherever it could be written.
  const nestedGitPointers: string[] = [];
  for (let dir = worktree; dir !== git.top; dir = path.dirname(dir)) {
    const p = path.join(dir, ".git");
    if (p !== gitPointer && (dir === worktree || writable.some((w) => within(p, w)))) nestedGitPointers.push(p);
    if (path.dirname(dir) === dir) break;
  }
  const gitDenied = [...new Set([git.gitDir, git.commonDir].filter((d): d is string => !!d && d !== gitPointer))];
  // A granted directory may be a git repository of its own (a sibling project granted for writing):
  // its `.git` holds hooks and config that relay's own git, outside the sandbox, may read, so it is
  // hard-denied for every grant, present or not, like the worktree's (review C3).
  const alreadyDenied = (p: string) => p === gitPointer || hardDeniedCovers(p, [gitPointer, ...nestedGitPointers, ...gitDenied, ...denied]);
  const grantGitPointers = [...new Set(grants.map((g) => path.join(g, ".git")))].filter((p) => !alreadyDenied(p));
  // Harness and tool configuration at the top of each writable root the agent owns (not the temp dir's
  // home or relay-owned state): denied whether present or not. Only the top level. A copy deeper in a
  // subtree is not blocked, though the harnesses do load such copies:
  // - Gemini CLI 0.64.0, in a trusted folder, reads `.gemini/settings.json` from its working
  //   directory and `.gemini/.env` from there or the nearest directory above that has one
  //   (`_doLoadSettings`, `findEnvFile`);
  // - Codex 0.163.0 loads a `.codex/` layer, hooks included, from every directory between the
  //   project root and its working directory, subject to its trust decision for each
  //   (config/src/loader/mod.rs, the `cwd.ancestors()` walk), and `.agents/skills` and
  //   `.codex/skills` the same way (core/extensions.ts here mirrors it);
  // - Claude Code reads `.claude/settings.json` from its working directory, `.claude/skills` and
  //   `.claude/commands` from there up to the repository's top, and nested `.claude/skills` below it
  //   as it reads files in that subtree, so a session at the root loads them too (as relay models it
  //   in core/claude-settings.ts).
  // Relay starts every turn at the worktree's root and runs Gemini untrusted, so a deeper copy reaches
  // its own turns only through Claude's nested skills; it reaches the person's agents once merged,
  // when one runs in that subdirectory. Denying the names at any depth is possible without a path in
  // the profile (a regex anchored by the root's depth inside `(subpath ROOT)`), but it would also
  // stop legitimate edits (relay's own adapters/codex/.agents, a monorepo's per-package skills); the
  // decision is deferred, for .claude, .codex, .agents and .gemini together.
  const configRoots = [...(policy.worktreeWritable ? [worktree] : []), ...grants];
  const configDenied = [...new Set(configRoots.flatMap((w) => HARNESS_CONFIG.map((n) => path.join(w, n))))]
    .filter((c) => c !== gitPointer && !hardDeniedCovers(c, [gitPointer, ...nestedGitPointers, ...gitDenied, ...denied]) && !grantGitPointers.some((g) => within(c, g)));
  const hardDenied = [gitPointer, ...nestedGitPointers, ...gitDenied, ...grantGitPointers, ...denied, ...installDenied];
  // A token file's allow names file-write-data, which the hard denies (file-write*) would not override
  // (see the top): one inside a denied or protected path would be writable there, so it is refused.
  for (const t of tokenFiles) {
    const inside = [...hardDenied, ...configDenied].find((d) => within(t, d));
    if (inside) throw new Error(`token file ${t} lies inside ${inside}, which the sandbox protects, so relay does not make it writable`);
  }
  // A login store's allows name operations too: it must stay clear of every path the profile writes
  // or protects, either way round, or a rule meant for one would decide for the other. (A read
  // turn's worktree is neither, so it may hold the store: a read job from the home folder.)
  const store = policy.state?.tokenStore ? tokenStore(policy.state.tokenStore) : null;
  if (store) {
    // Not the installation's denies: they name every operation the store's allows name and come after
    // them, so they win either way round (Grok keeps its binary in ~/.grok/bin, inside its store).
    const clash = [...writable, ...(persistent ? [persistent.root] : []), ...tokenFiles, ...hardDenied.filter((d) => !installDenied.includes(d)), ...configDenied]
      .find((o) => within(o, store.dir) || within(store.dir, o));
    if (clash) throw new Error(`${store.name} (${store.dir}) overlaps ${clash}, which the sandbox writes or protects, so relay does not open it`);
  }
  const fixed = new Set<string>();
  for (const p of [...writable, worktree, ...hardDenied]) {
    // Up from each, while inside a writable root: once outside every one, so is every ancestor.
    for (let a = p; writable.some((w) => within(a, w)); a = path.dirname(a)) {
      fixed.add(a);
      if (path.dirname(a) === a) break;
    }
  }
  // Relay's own directories (its control directory and its sockets directory) cannot be moved either,
  // from anywhere above them: their ancestors, outside the writable roots too.
  const relayAncestors = new Set<string>();
  for (const d of [...denied.slice(0, 2), ...config.directories, ...installDenied]) for (let a = path.dirname(d); a !== path.dirname(a); a = path.dirname(a)) relayAncestors.add(a);
  return {
    worktree, tmpDir, denied, installDenied, writable, tokenFiles, persistent, gitPointer, nestedGitPointers, grantGitPointers, gitDir: git.gitDir, commonDir: git.commonDir,
    hardDenied, fixed: [...fixed], relayAncestors: [...relayAncestors].filter((a) => !fixed.has(a)), configDenied, store,
  };
}

/** A directory relay created, as it found it then: its resolved path, device and inode, checked again every turn. */
export interface DirPin {
  path: string;
  dev: number;
  ino: number;
}

/** What relay records for a directory it has just created (a job's worktree), to pin it across turns. */
export function dirIdentity(p: string): DirPin {
  const real = canonical(p, "directory");
  const st = fs.lstatSync(real);
  if (!st.isDirectory()) throw new Error(`${real} is not a directory`);
  return { path: real, dev: st.dev, ino: st.ino };
}

const isOwn = (st: fs.Stats) => typeof process.getuid !== "function" || st.uid === process.getuid();

/** Every component of an absolute path from `from` down, looked at without following links: each a real directory. */
function realDirs(p: string, what: string, from = path.parse(p).root) {
  let at = from;
  for (const part of path.relative(from, p).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    const st = fs.lstatSync(at, { throwIfNoEntry: false });
    if (!st) throw new Error(`${what}: ${at} is missing`);
    if (st.isSymbolicLink()) throw new Error(`${what}: ${at} is a symbolic link, which the sandbox would follow, so relay does not run on it`);
    if (!st.isDirectory()) throw new Error(`${what}: ${at} is not a directory`);
  }
}

/**
 * A writable root or the worktree, as named, checked before every turn without following links: it
 * must exist and be a directory itself, not a link (a turn that swapped it for one would carry the
 * next turn's writes wherever it points), and be this user's own.
 */
function rootDir(p: string, what: string) {
  const at = path.resolve(p);
  const st = fs.lstatSync(at, { throwIfNoEntry: false });
  if (!st) throw new Error(`${what} is missing: ${at}. A writable directory must exist before the turn, or the agent could make it a link`);
  if (st.isSymbolicLink()) throw new Error(`${what} is a symbolic link: ${at}. The sandbox would follow it, so relay does not run on it`);
  if (!st.isDirectory()) throw new Error(`${what} is not a directory: ${at}`);
  if (!isOwn(st)) throw new Error(`${what} is not owned by this user: ${at}`);
}

/**
 * A granted directory relay pinned at authorisation: the pin's path must still be reached through
 * real directories only and still be that same directory (device and inode), the person's own, and
 * the grant must still resolve to exactly it. A symlink put at any component since would make the
 * resolved path differ, or make a component not a real directory; either refuses the turn.
 */
export function checkGrantPin(pin: DirPin, resolved: string, i: number) {
  const what = `the directory relay granted for writable[${i}]`;
  if (!pin || typeof pin.path !== "string" || !path.isAbsolute(pin.path) || !Number.isFinite(pin.dev) || !Number.isFinite(pin.ino)) {
    throw new Error(`the pin for writable[${i}] is not a pinned directory: ${JSON.stringify(pin)}`);
  }
  realDirs(pin.path, what);
  const st = fs.lstatSync(pin.path);
  if (st.dev !== pin.dev || st.ino !== pin.ino) throw new Error(`${what} (${pin.path}) is not the directory relay granted (it has been replaced since), so relay does not run on it`);
  if (!isOwn(st)) throw new Error(`${what} (${pin.path}) is not owned by this user`);
  if (resolved !== pin.path) throw new Error(`writable[${i}] now resolves to ${resolved}, not the ${pin.path} relay granted (an intermediate component has been changed to a link), so relay does not run on it`);
}

/** Applied by native backends too, immediately before constructing their launch policy. */
export function checkWriteGrant(paths: readonly string[], pins: readonly DirPin[] = []): void {
  if (pins.length !== paths.length) throw new Error("write paths need exactly one recorded directory pin each; the root session must grant these paths again");
  paths.forEach((p, i) => checkGrantPin(pins[i], canonical(p, `writable[${i}]`), i));
}

/**
 * The worktree's root as relay created it: the pinned path must still be reached through real
 * directories only and still be the same directory (device and inode), the person's own, and the
 * worktree must lie inside it, reached from it through real directories too.
 */
function checkPin(pin: DirPin, worktree: string) {
  if (!pin || typeof pin.path !== "string" || !path.isAbsolute(pin.path) || !Number.isFinite(pin.dev) || !Number.isFinite(pin.ino)) {
    throw new Error(`the worktree's pin is not a pinned directory: ${JSON.stringify(pin)}`);
  }
  realDirs(pin.path, "the directory relay pinned for the worktree");
  const st = fs.lstatSync(pin.path);
  if (st.dev !== pin.dev || st.ino !== pin.ino) throw new Error(`${pin.path} is not the directory relay created for this job (it has been replaced since), so relay does not run on it`);
  if (!isOwn(st)) throw new Error(`${pin.path} is not owned by this user`);
  if (!within(worktree, pin.path)) throw new Error(`the worktree ${worktree} is not inside the directory relay pinned for it (${pin.path}), so relay does not run on it`);
  realDirs(worktree, "the worktree", pin.path);
}

/**
 * The repository the worktree belongs to: the first `.git` found walking up from the worktree, as git
 * itself finds it (a turn may start in a subdirectory). `pointer` is that `.git` (or the worktree's
 * own, where there is none), `top` the directory holding it; `gitDir` the worktree's git directory
 * and `commonDir` the repository's shared one, read from the pointer and the git directory's
 * `commondir` file, which the sandbox never lets the agent write. Undefined where there is none.
 */
function gitDirs(worktree: string): { pointer: string; top?: string; gitDir?: string; commonDir?: string } {
  for (let dir = worktree; ; dir = path.dirname(dir)) {
    const pointer = path.join(dir, ".git");
    const st = fs.lstatSync(pointer, { throwIfNoEntry: false });
    if (st) return { pointer, top: dir, ...gitDirsAt(dir, pointer, st) };
    if (path.dirname(dir) === dir) return { pointer: path.join(worktree, ".git") };
  }
}

/**
 * The same, for a turn in a job's worktree, from the git directories the repository records for it
 * (the trusted git env relay's own git uses, git.ts jobTree), never from the worktree's `.git` file,
 * which the job's agent can rewrite: a pointer it aimed elsewhere would have the profile deny that
 * place and leave the real git directories writable. `commondir` is read from the recorded git
 * directory, inside the repository's own, which no agent can write.
 */
function trustedGitDirs(worktree: string, env: { GIT_DIR: string; GIT_WORK_TREE: string }): { pointer: string; top: string; gitDir: string; commonDir: string } {
  const top = canonical(env.GIT_WORK_TREE, "the worktree relay's git runs in");
  if (!within(worktree, top)) throw new Error(`the turn's directory ${worktree} is not inside the worktree relay's git runs in (${top})`);
  const gitDir = canonical(env.GIT_DIR, "the worktree's git directory");
  return { pointer: path.join(top, ".git"), top, gitDir, commonDir: commonDirOf(gitDir) };
}

/** The repository's shared git directory, from a worktree git directory's `commondir` file; the git directory itself when it has none (a main checkout). */
function commonDirOf(gitDir: string): string {
  try {
    return canonical(path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim()), "the repository's git directory");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return gitDir;
  }
}

function gitDirsAt(top: string, pointer: string, st: fs.Stats): { gitDir?: string; commonDir?: string } {
  if (st.isDirectory()) return { gitDir: pointer, commonDir: pointer };
  if (!st.isFile()) throw new Error(`.git is neither a file nor a directory: ${pointer}`);
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(pointer, "utf8"));
  if (!m) return {};
  const raw = path.resolve(top, m[1]);
  if (!fs.existsSync(raw)) return {};
  const gitDir = canonical(raw, "the worktree's git directory");
  return { gitDir, commonDir: commonDirOf(gitDir) };
}

/** The profile for a policy's shape, and the parameters that carry its paths. `harness` is the command the launch runs. */
export function seatbeltProfile(policy: ConfinementPolicy, harness?: string): { profile: string; params: [string, string][] } {
  const params: [string, string][] = [];
  const param = (name: string, value: string) => {
    params.push([name, value]);
    return `(param "${name}")`;
  };

  const { tmpDir, denied, installDenied, writable, tokenFiles, gitPointer, nestedGitPointers, grantGitPointers, gitDir, commonDir, fixed, relayAncestors, configDenied, store } = boundaryPaths(policy);
  let proxyPort: number | undefined;
  if (policy.network.mode === "off-except-proxy") {
    proxyPort = policy.network.proxyPort;
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error(`proxy port is not a port: ${proxyPort}`);
    if (typeof policy.network.proxyToken !== "string" || !PROXY_TOKEN.test(policy.network.proxyToken)) throw new Error("the proxy token is missing or not a per-turn token");
  } else if (policy.network.mode !== "on" && policy.network.mode !== "stage2") {
    throw new Error(`unknown network mode ${(policy.network as { mode: unknown }).mode}`);
  }

  // Every deny carries the turn's tag, so relay can stream exactly this turn's denials from the
  // system log and a harness the profile stops says which rule stopped it (diagnostics.ts, review C4).
  const diagMsg = `(with message ${param("DIAG_TAG", diagnosticTag(policy))})`;
  const L: string[] = ["(version 1)", `(deny default ${diagMsg})`, BASE.replace("(deny process-info*)", `(deny process-info* ${diagMsg})`)];
  if (policy.keychain) L.push(KEYCHAIN);
  if (policy.certificateTrust) L.push(TRUST);
  // Executables: the fixed list, then this turn's. Writable directories stay executable so that the
  // agent can run what it builds; see "What the exec list does not do" in docs/architecture.md.
  const exec = [
    ...(harness ? [["HARNESS", canonical(harness, "the harness command")]] : []),
    ...(harness && shebang(harness) ? [["INTERPRETER", canonical(shebang(harness)!, "the harness's interpreter")]] : []),
    ["RELAY_NODE", canonical(process.execPath, "relay's Node")],
    ...(policy.execPaths ?? []).map((p, i) => [`EXEC_${i}`, canonical(p, `execPaths[${i}]`)]),
  ];
  L.push(`; --- executables\n(allow process-exec${EXEC_SYSTEM}\n  ${exec.map(([k, v]) => execFilter(v, param(k, v))).join(" ")}\n  ${writable.map((_, i) => `(subpath (param "WRITABLE_${i}"))`).join(" ")})`);
  L.push(`; --- writes: these directories only\n(allow file-write*\n  ${writable.map((w, i) => `(subpath ${param(`WRITABLE_${i}`, w)})`).join("\n  ")})`);
  (policy.overlayFiles ?? []).forEach((root, i) => {
    assertOverlayRoot(root);
    if (root.scope !== "file") throw new Error("overlayFiles requires exact files");
    const file = param(`OVERLAY_FILE_${i}`, root.root);
    L.push(`(allow file-write* (literal ${file}))`);
    L.push(`(deny file-link (literal ${file}) ${diagMsg})\n(deny file-write-create (require-all (literal ${file}) (vnode-type SYMLINK)) ${diagMsg})`);
  });
  // Unix sockets of the turn's own, under its temp dir: made, listened on and connected to there only.
  const tmp = param("TMPDIR", tmpDir);
  L.push(`; --- the turn's own Unix sockets\n(allow network-bind (local unix-socket (subpath ${tmp})))\n(allow network-outbound (remote unix-socket (subpath ${tmp})))`);
  if (tokenFiles.length) {
    L.push(`; --- the harness's login token files in its real store: their data only, nothing beside them\n(allow file-write-data\n  ${tokenFiles.map((f, i) => `(literal ${param(`TOKEN_FILE_${i}`, f)})`).join("\n  ")})`);
  }
  if (store) {
    // A login store (TokenStore, a stated downgrade): its exact names and its temp names, as regular
    // files, and the modes of its temp and token files, which a refresh sets (Grok: fs_atomic.rs).
    // Measured on decoys (docs/design-token-store.md): the denies name the operations they mean and
    // come after the allows, since a file-write* deny would not override these (see the top).
    const dir = param("TOKEN_STORE", store.dir);
    const names = [
      ...store.files.map((f, i) => `(literal ${param(`TOKEN_STORE_FILE_${i}`, f)})`),
      ...store.locks.map((f, i) => `(literal ${param(`TOKEN_STORE_LOCK_${i}`, f)})`),
      // The one pattern written into the profile: of the reviewed form tokenStore checks, never a path.
      `(require-all (subpath ${dir}) (regex #"${store.temp}"))`,
    ];
    L.push([
      "; --- the harness's login store: its token, lock and temp names, regular files only; nothing else in it",
      `(allow file-write-data\n  ${names.join("\n  ")})`,
      `(allow file-write-create\n  ${names.map((n) => `(require-all (vnode-type REGULAR-FILE) ${n})`).join("\n  ")})`,
      // Unlink only where a rename needs it: the token (replaced by the rename) and temp names (moved
      // from). Not the lock, which Grok never removes: an exchange (renamex_np RENAME_SWAP) needs an
      // unlink at the name, and could otherwise put a link there that the harness, outside the
      // sandbox, would open and write through (measured; review r_75bf1f48).
      `(allow file-write-unlink\n  ${[...names.slice(0, store.files.length), names.at(-1)].join("\n  ")})`,
      // Modes: a temp file's, set before its rename, and the token's, made owner-only after it and on
      // every read (Grok); no more than a temp file's mode and a rename already allow.
      `(allow file-write-mode\n  ${[...names.slice(0, store.files.length), names.at(-1)].join("\n  ")})`,
      `(deny file-write-create (require-all (subpath ${dir}) (vnode-type SYMLINK)) ${diagMsg})`,
      `(deny file-link (subpath ${dir}) ${diagMsg})`,
      ...store.subdirs.map((d, j) => `(deny file-write-create file-write-data file-write-unlink file-write-mode (subpath ${param(`TOKEN_STORE_SUBDIR_${j}`, d)}) ${diagMsg})`),
    ].join("\n"));
  }
  if (policy.network.mode === "stage2") {
    // Stage 2 (WP-A): its own network block, every port and path a parameter. Worktree sockets only
    // on a write turn in a worktree relay made and pinned (review C4). No certificate trust: trustd
    // fetches the URLs a certificate names, past every rule here (§3.1).
    if (policy.network.worktreeSockets && !(policy.worktreeWritable && policy.worktreePin)) throw new Error("stage 2 allows Unix sockets in the worktree only on write turns in a worktree relay created and pinned");
    if (policy.certificateTrust) throw new Error("stage 2 does not run with certificate trust: trustd would fetch URLs past the profile's network rules");
    L.push(stage2NetworkRules(policy.network, param, diagMsg, { tmpDir, worktree: canonical(policy.worktree, "worktree") }));
  } else if (policy.network.mode === "on") {
    L.push(NETWORK_ON.replace('(deny network-outbound (remote ip4 "localhost:*"))', `(deny network-outbound (remote ip4 "localhost:*") ${diagMsg})`));
  } else {
    // A validated integer, so it is written into the profile; no DNS, which would be a channel out.
    L.push(`; --- network off except relay's CONNECT proxy\n(allow network-outbound (remote tcp "localhost:${proxyPort}"))`);
  }
  // Hard denies, last so that they win.
  const git = param("GIT_POINTER", gitPointer);
  L.push(`; --- hard denies (last match wins)\n; the worktree's .git: host-side git must never be redirected or given hooks or config by the agent\n(deny file-write* (literal ${git}) (subpath ${git}) ${diagMsg})`);
  // The worktree's git directory and the repository's shared one hold config and hooks that relay's
  // own git, outside the sandbox, reads: never writable, whatever a grant covers.
  if (gitDir && gitDir !== gitPointer) L.push(`(deny file-write* (subpath ${param("GIT_DIR", gitDir)}) ${diagMsg})`);
  if (commonDir && commonDir !== gitPointer && commonDir !== gitDir) L.push(`(deny file-write* (subpath ${param("GIT_COMMON_DIR", commonDir)}) ${diagMsg})`);
  // A .git of its own below the repository's would hide the real one from the next turn's discovery.
  nestedGitPointers.forEach((p, i) => L.push(`(deny file-write* (literal ${param(`NESTED_GIT_${i}`, p)}) (subpath (param "NESTED_GIT_${i}")) ${diagMsg})`));
  // A granted repository's own .git (hooks, config): never writable, present or not (review C3).
  grantGitPointers.forEach((p, i) => L.push(`(deny file-write* (literal ${param(`GRANT_GIT_${i}`, p)}) (subpath (param "GRANT_GIT_${i}")) ${diagMsg})`));
  // Denied directories, relay's control and sockets directories first: nothing in them read, written
  // or connected to (another turn's broker socket included).
  // file-test-existence by name: the base allows it unfiltered, and file-read* would not override that (see the top).
  denied.forEach((d, i) => L.push(`(deny file-read* file-write* file-test-existence (subpath ${param(`DENIED_${i}`, d)}) ${diagMsg})\n(deny network-outbound (remote unix-socket (subpath (param "DENIED_${i}"))) ${diagMsg})`));
  // What relay runs outside the sandbox and its PATH: never written, created, removed or renamed
  // (review r_0c11d860 X1). Each operation named as well, so no operation-specific allow could
  // outrank it (see the top).
  if (installDenied.length) L.push(`; --- relay's installation, which relay runs outside the sandbox\n(deny file-write* file-write-data file-write-create file-write-unlink file-write-mode file-link\n  ${installDenied.map((d, i) => `(literal ${param(`INSTALL_${i}`, d)}) (subpath (param "INSTALL_${i}"))`).join("\n  ")} ${diagMsg})`);
  if (relayAncestors.length) L.push(`(deny file-write-unlink file-write-create\n  ${relayAncestors.map((a, i) => `(literal ${param(`RELAY_ANCESTOR_${i}`, a)})`).join("\n  ")} ${diagMsg})`);
  // Harness and tool configuration at the top of each writable root: never written, created or removed.
  if (configDenied.length) L.push(`; --- harness and tool configuration an agent could plant\n(deny file-write*\n  ${configDenied.map((c, i) => `(literal ${param(`CONFIG_${i}`, c)}) (subpath (param "CONFIG_${i}"))`).join("\n  ")} ${diagMsg})`);
  // Writable roots, the worktree, and the ancestors of protected paths inside writable roots: never
  // removed, renamed (rename needs unlink at the source, create at the destination) or made again,
  // so no rule's path can be moved out from under it (see boundaryPaths).
  if (fixed.length) L.push(`(deny file-write-unlink file-write-create\n  ${fixed.map((f, i) => `(literal ${param(`FIXED_${i}`, f)})`).join("\n  ")} ${diagMsg})`);
  // Terminals: reads are broad, so the person's other sessions' terminals are denied explicitly,
  // reading included; then the turn's own, if it has one, by name.
  // Existence tests stay allowed here (the base allows them unfiltered): which terminals exist is no
  // secret (/dev is listable), and openpty tests a new one's name before its extension applies.
  L.push(`(deny file-read* file-write* file-ioctl (regex #"^/dev/ttys[0-9]+$") ${diagMsg})`);
  // A pseudo-terminal the turn opens itself (through /dev/ptmx) carries the kernel's sandbox
  // extension for it, which no other terminal has.
  // This rule is from OpenAI Codex (codex-rs/sandboxing/src/seatbelt.rs at 0e67502), Copyright 2025
  // OpenAI, licensed under the Apache License, Version 2.0; copied unchanged. The licence and Codex's
  // NOTICE are in LICENSES/ (Apache-2.0.txt, codex-NOTICE.txt; see LICENSES/README.md).
  L.push(`(allow file-read* file-write* file-ioctl (require-all (regex #"^/dev/ttys[0-9]+$") (extension "com.apple.sandbox.pty")))`);
  if (policy.tty !== undefined) {
    if (typeof policy.tty !== "string" || !/^\/dev\/ttys[0-9]+$/.test(policy.tty)) throw new Error(`tty must be the turn's own pseudo-terminal, /dev/ttysNNN: ${JSON.stringify(policy.tty)}`);
    L.push(`(allow file-read* file-write-data file-ioctl (literal ${param("TTY", policy.tty)}))`);
  }
  // The turn's bridge to relay, after the denies above: the one socket in relay's sockets directory it may reach.
  if (policy.bridgeSocket !== undefined) {
    // Its path's existence too: connecting looks the name up, which the sockets directory's deny of
    // existence tests would otherwise refuse (measured: the socket's own name is enough).
    L.push(`; --- the turn's bridge to relay\n(allow network-outbound (remote unix-socket (path-literal ${param("BRIDGE_SOCKET", canonical(policy.bridgeSocket, "bridgeSocket"))})))\n(allow file-test-existence (literal (param "BRIDGE_SOCKET")))`);
  }
  // The bridge secret's file, for a harness whose own tool helper presents it (Gemini's tool
  // discovery): by name, beside the turn's own socket, after the denies above. Reading it, its
  // status and the lookup of its name; nothing else in the broker directory, which stays denied
  // (listing it included), and nothing written. Another turn's profile names no such file.
  if (policy.bridgeSecret !== undefined) {
    if (policy.bridgeSocket === undefined) throw new Error("bridgeSecret needs bridgeSocket: the secret's file is the turn's own only beside its own socket");
    const secret = canonical(policy.bridgeSecret, "bridgeSecret");
    const socket = canonical(policy.bridgeSocket, "bridgeSocket");
    if (path.dirname(secret) !== path.dirname(socket) || secret === socket) throw new Error(`bridgeSecret must be a file beside the turn's bridge socket, in its broker directory ${path.dirname(socket)}: ${JSON.stringify(policy.bridgeSecret)}`);
    if (!within(secret, canonical(relaySocketsDir(), "relay's sockets directory"))) throw new Error(`bridgeSecret must be in relay's sockets directory, which every other turn's profile denies: ${JSON.stringify(policy.bridgeSecret)}`);
    L.push(`; --- the bridge secret's file, the turn's own\n(allow file-read-data file-read-metadata file-test-existence (literal ${param("BRIDGE_SECRET_FILE", secret)}))`);
  }
  // LaunchServices and AppleEvents would start processes outside the sandbox.
  L.push(`(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents") ${diagMsg})`);
  // No XPC service of any name, whatever a rule above allows: a final rule, so that no later
  // downgrade can open them by accident.
  L.push(`(deny mach-lookup (xpc-service-name-prefix "") ${diagMsg})`);
  // F_MAKECOMPRESSED (80) and F_TRANSFEREXTENTS (110) change a file through a descriptor opened
  // read-only, so reads being broad would make every readable file changeable. "deny default" does
  // not cover them (fcntl is allowed unless a rule names the command), hence an explicit rule.
  L.push(`(deny system-fcntl (fcntl-command ${F_MAKECOMPRESSED} ${F_TRANSFEREXTENTS}) ${diagMsg})`);
  if (policy.neverPolicy) L.push(...neverSeatbeltRules(policy.neverPolicy, param, diagMsg, {
    worktree: canonical(policy.worktree, "worktree"), tmpDir,
    ...(policy.network.mode === "stage2" ? { execPort: policy.network.execPort, bindPorts: policy.network.bindPorts, mediatedPort: policy.network.mediatedPort } : {}),
  }));
  return { profile: L.join("\n") + "\n", params };
}

/** A token file, as relay found it when it set the harness up: device and inode, checked again every turn. */
export interface TokenFilePin {
  path: string;
  dev: number;
  ino: number;
}

/** The path a token file is named by, with its directory resolved and its own name not followed. */
function tokenPath(f: string | TokenFilePin, what: string): string {
  const p = typeof f === "string" ? f : f?.path;
  if (typeof p !== "string" || !p) throw new Error(`${what} is empty`);
  return path.join(canonical(path.dirname(p), what), path.basename(p));
}

/** What relay records for a token file at trusted setup, to pin it across turns. Looks at the file's identity only; never opens it. */
export function tokenFileIdentity(p: string): TokenFilePin {
  const real = tokenPath(p, "token file");
  const st = fs.lstatSync(real);
  return { path: real, dev: st.dev, ino: st.ino };
}

/**
 * A token file the harness may rewrite in place, checked before every turn without following
 * links: it must exist, be a regular file (not a link, directory or executable) with exactly one
 * name, owned by this user and, when pinned, still the file relay set up. The profile then allows
 * only data writes to it (truncate, write, append): no unlink, rename, create, link or mode change,
 * so the agent cannot swap it for a link that a later turn's profile would follow. Relay looks at
 * the file's metadata only; it never opens it.
 */
export function tokenFile(f: string | TokenFilePin, what: string): string {
  const real = tokenPath(f, what);
  const st = fs.lstatSync(real, { throwIfNoEntry: false });
  if (!st) throw new Error(`${what} is missing: ${real}. A token file must exist before the turn; the sandbox lets the harness rewrite it, not create it`);
  if (st.isSymbolicLink()) throw new Error(`${what} is a symbolic link: ${real}. Relay grants writes to the file itself, never through a link, so it does not run on this`);
  if (!st.isFile()) throw new Error(`${what} is not a regular file: ${real}. Only specific token files can be writable, never directories`);
  if (st.mode & 0o111) throw new Error(`${what} is executable: ${real}. Token files only, never binaries or scripts`);
  if (st.nlink !== 1) throw new Error(`${what} has ${st.nlink} hard links: ${real}. Another name for it could be outside the store, so relay does not run on it`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${what} is not owned by this user: ${real}`);
  if (typeof f !== "string" && (st.dev !== f.dev || st.ino !== f.ino)) {
    throw new Error(`${what} is not the file relay set up (${real} has been replaced since), so relay does not run on it`);
  }
  return real;
}

/** A login store's temp-name pattern: anchored; literals, `\.` and character classes, each perhaps repeated; one at least repeated. */
const TEMP_ATOM = String.raw`(?:[A-Za-z0-9_-]|\\\.|\[[A-Za-z0-9-]+\])[+*]?`;
const TEMP_NAME = new RegExp(String.raw`^\^(?:${TEMP_ATOM})+\$$`);
/** A name in a login store: one plain component. */
const STORE_ENTRY = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

/** A login store as checked for this turn: what the profile is written from. */
export interface CheckedStore {
  name: string;
  dir: string;
  files: string[];
  locks: string[];
  /** The temp-name pattern for a whole path, matching its last component: the profile's regex. */
  temp: string;
  /** The temp-name pattern for one name. */
  tempName: RegExp;
  /** The store's subdirectories as found now, each denied by name. */
  subdirs: string[];
}

/**
 * Checks a login store (TokenStore) before a turn, without following links, and returns what the
 * profile is written from. Every name relay would make writable that exists (the files, the locks
 * and every name matching the temp pattern) must be a regular file with one name, the person's own
 * and not executable: a hard link planted there before the turn would carry the turn's writes to the
 * file's other name (measured; review r_64e5a9ce X1). Relay looks at metadata only, never opens a
 * file there, and deletes nothing: an unsafe entry refuses the turn and is named.
 */
function inspectTokenStore(s: TokenStore, what = "state.tokenStore"): CheckedStore & { problems: StoreEntryProblem[] } {
  if (!s || typeof s !== "object") throw new Error(`${what} is not a login store`);
  if (typeof s.name !== "string" || !/^[^\0\r\n]{1,80}$/.test(s.name)) throw new Error(`${what}.name must be one line: ${JSON.stringify(s.name)}`);
  if (typeof s.dir !== "string" || !path.isAbsolute(s.dir) || /[\0\r\n]/.test(s.dir)) throw new Error(`${what}.dir must be an absolute path: ${JSON.stringify(s.dir)}`);
  const top = fs.lstatSync(s.dir, { throwIfNoEntry: false });
  if (!top || top.isSymbolicLink() || !top.isDirectory()) throw new Error(`${s.name} (${s.dir}) is ${top ? "not a plain directory" : "missing"}; relay makes a login store writable only where it is a real directory`);
  if (typeof process.getuid === "function" && top.uid !== process.getuid()) throw new Error(`${s.name} (${s.dir}) is not owned by this user`);
  if (top.mode & 0o022) throw new Error(`${s.name} (${s.dir}) is writable by others (mode ${(top.mode & 0o777).toString(8)})`);
  const dir = canonical(s.dir, `${what}.dir`);
  const names = (list: unknown, field: string): string[] => {
    if (!Array.isArray(list)) throw new Error(`${what}.${field} must be a list of names`);
    return list.map((n, i) => {
      if (typeof n !== "string" || !STORE_ENTRY.test(n)) throw new Error(`${what}.${field}[${i}] must be a plain file name: ${JSON.stringify(n)}`);
      return n;
    });
  };
  const files = names(s.files, "files");
  const locks = names(s.locks, "locks");
  if (!files.length) throw new Error(`${what} names no file`);
  if (new Set([...files, ...locks]).size !== files.length + locks.length) throw new Error(`${what} names a file twice`);
  if (typeof s.tempName !== "string" || !TEMP_NAME.test(s.tempName) || !/[+*]/.test(s.tempName)) {
    throw new Error(`${what}.tempName must be an anchored pattern of literals, \\. and character classes, one at least repeated: ${JSON.stringify(s.tempName)}`);
  }
  // A class's range must not take in "/", so that the pattern cannot match across a path (review r_75bf1f48 C4).
  for (const [, cls] of s.tempName.matchAll(/\[([A-Za-z0-9-]+)\]/g)) {
    for (let i = 0; i < cls.length; i++) {
      if (cls[i + 1] === "-" && i + 2 < cls.length) {
        if (cls.charCodeAt(i) <= 0x2f && cls.charCodeAt(i + 2) >= 0x2f) throw new Error(`${what}.tempName has a class whose range takes in "/": ${JSON.stringify(s.tempName)}`);
        i += 2;
      }
    }
  }
  const tempName = new RegExp(s.tempName);
  for (const n of [".", "..", ...files, ...locks]) if (tempName.test(n)) throw new Error(`${what}.tempName matches ${JSON.stringify(n)}`);
  if (tempName.test(path.basename(dir))) throw new Error(`${what}.tempName matches the store's own name, ${path.basename(dir)}, which would let the store itself be removed`);
  const entries = fs.readdirSync(dir);
  const problems: StoreEntryProblem[] = [];
  // A volume that ignores case or Unicode form in names (macOS's default) reaches AUTH.json through
  // auth.json, so a name relay makes writable reaches whatever entry folds to it (measured: writes
  // through auth.json reached an outside file planted as AUTH.json; review r_75bf1f48 C1). Each
  // declared name is looked up as the turn will, and must reach an entry of exactly that name; and
  // every entry that folds to a declared or temp name is checked as one, and must be exactly one.
  const fold = (n: string) => n.normalize("NFC").toUpperCase().toLowerCase();
  const folded = new Set([...files, ...locks].map(fold));
  const foldedTemp = new RegExp(s.tempName, "i");
  for (const n of [...files, ...locks]) {
    const p = path.join(dir, n);
    if (fs.lstatSync(p, { throwIfNoEntry: false }) && !entries.includes(n) && !entries.some((e) => fold(e) === fold(n))) {
      throw new Error(`${p} reaches an entry of another name that relay cannot identify, so relay does not run`);
    }
  }
  const subdirs: string[] = [];
  for (const n of entries) {
    const p = path.join(dir, n);
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    const exact = files.includes(n) || locks.includes(n) || tempName.test(n);
    let reason: string | null = null;
    if (!exact && (folded.has(fold(n)) || foldedTemp.test(fold(n)))) {
      reason = `${p} differs only in case or form from a name relay makes writable in ${s.name}, and on such a volume the turn's writes would reach it, so relay does not run; it leaves it for you to look at`;
    } else if (exact) {
      if (st.isSymbolicLink()) reason = `${p} is a symbolic link. Every name relay makes writable in ${s.name} must be the file itself, so it does not run; relay leaves it for you to look at`;
      else if (!st.isFile()) reason = `${p} is not a regular file. Only files can be writable in ${s.name}, so relay does not run; it leaves it for you to look at`;
      else if (st.mode & 0o111) reason = `${p} is executable. Relay makes only plain token files writable, so it does not run on it`;
      else if (st.nlink !== 1) reason = `${p} has ${st.nlink} hard links: another name for it could be anywhere, and the turn's writes would reach it. Relay does not run until the extra name is gone`;
      else if (typeof process.getuid === "function" && st.uid !== process.getuid()) reason = `${p} is not owned by this user`;
    } else if (st.isDirectory()) subdirs.push(p);
    if (reason) problems.push({ name: n, stat: st, reason });
  }
  if (subdirs.length > 64) throw new Error(`${s.name} (${dir}) has ${subdirs.length} subdirectories; relay denies each by name and stops at 64`);
  return { name: s.name, dir, files: files.map((f) => path.join(dir, f)), locks: locks.map((f) => path.join(dir, f)), temp: `/${s.tempName.slice(1)}`, tempName, subdirs, problems };
}

interface StoreEntryProblem { name: string; stat: fs.Stats; reason: string }

export function tokenStore(s: TokenStore, what = "state.tokenStore"): CheckedStore {
  const { problems, ...checked } = inspectTokenStore(s, what);
  if (problems.length) throw new Error(problems[0].reason);
  return checked;
}

export interface StoreQuarantine {
  problem: string | null;
  moved: { name: string; to: string }[];
  errors: string[];
}

/**
 * After the harness and its children stop, move unsafe entries themselves, never their targets.
 * Also remove token names from use, so even a bad lock or temp file requires a fresh login.
 * `destination` is below relay's denied control directory, with run/node/turn components supplied
 * by relay, never by the harness. No file is opened, copied, deleted or overwritten here.
 */
export function quarantineTokenStore(s: TokenStore, destination: string, turn: string): StoreQuarantine {
  const result: StoreQuarantine = { problem: null, moved: [], errors: [] };
  let checked: ReturnType<typeof inspectTokenStore>;
  try { checked = inspectTokenStore(s); }
  catch (err) {
    result.problem = (err as Error).message;
    result.errors.push(`QUARANTINE FAILED for ${s.dir}: ${(err as Error).message}`);
    return result;
  }
  if (!checked.problems.length) return result;
  result.problem = checked.problems.map((p) => p.reason.replace(/; (?:relay|it) leaves it for you to look at$/, "")).join("; ");
  const entries = new Map(checked.problems.map((p) => [p.name, p.stat]));
  for (const p of checked.files) {
    try {
      const st = fs.lstatSync(p, { throwIfNoEntry: false });
      const fold = (n: string) => n.normalize("NFC").toUpperCase().toLowerCase();
      // On a case-insensitive volume the declared name may reach the alias already listed. On
      // a case-sensitive volume both can exist, so keep the token too when it is another inode.
      if (st && !entries.has(path.basename(p)) && ![...entries].some(([n, other]) => fold(n) === fold(path.basename(p)) && other.dev === st.dev && other.ino === st.ino)) entries.set(path.basename(p), st);
    } catch (err) { result.errors.push(`QUARANTINE FAILED for ${p}: ${(err as Error).message}`); }
  }
  // New directories are private; existing components below the control directory must be too.
  // The final directory must be new so a repeated turn cannot overwrite evidence.
  const privateDirectory = (dir: string, fresh = false): void => {
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st) {
      if (fresh) throw new Error(`quarantine destination already exists: ${dir}`);
      if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === "function" && st.uid !== process.getuid()) || (st.mode & 0o022)) {
        throw new Error(`quarantine ancestor is not a directory owned by this user and writable only by them: ${dir}`);
      }
      return;
    }
    privateDirectory(path.dirname(dir));
    fs.mkdirSync(dir, { mode: 0o700 });
    const made = fs.lstatSync(dir);
    if (!made.isDirectory() || made.isSymbolicLink() || (made.mode & 0o077) || (typeof process.getuid === "function" && made.uid !== process.getuid())) throw new Error(`unsafe quarantine directory: ${dir}`);
  };
  let directoryError: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(turn)) throw new Error(`invalid quarantine turn: ${JSON.stringify(turn)}`);
    privateDirectory(path.resolve(destination), true);
  } catch (err) { directoryError = err; }
  const identity = (a: fs.Stats, b: fs.Stats | undefined) => b && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;
  for (const [name, before] of entries) {
    const source = path.join(checked.dir, name);
    let to = path.join(destination, name);
    try {
      if (directoryError) throw directoryError;
      if (!identity(before, fs.lstatSync(source, { throwIfNoEntry: false }))) throw new Error("entry identity changed before quarantine");
      try { fs.renameSync(source, to); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        to = path.join(checked.dir, `.relay-quarantine.${turn}.${name}`);
        if (fs.lstatSync(to, { throwIfNoEntry: false })) throw new Error(`fallback already exists: ${to}`);
        fs.renameSync(source, to);
      }
      result.moved.push({ name, to });
      // lstat sees the moved link itself. Check both names for a concurrent replacement as well.
      const after = fs.lstatSync(to, { throwIfNoEntry: false });
      const remaining = fs.lstatSync(source, { throwIfNoEntry: false });
      if (!identity(before, after)) throw new Error(`entry identity differs after rename to ${to}`);
      if (remaining) throw new Error(`entry remains at ${source} after rename to ${to}`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      result.errors.push(`QUARANTINE FAILED for ${JSON.stringify(name)} (${source} -> ${to}): ${e.code ? `${e.code}: ` : ""}${e.message}`);
    }
  }
  return result;
}

/**
 * What is wrong with a login store now, or null: the same checks as before a turn, for after one.
 * An exchange of two names (renamex_np RENAME_SWAP) is checked by Seatbelt as a create and an unlink
 * at the store's name with that name's own file in view, so it can put a link or a directory at the
 * token's name or a temp name, which no rule can tell from a rename (measured; review r_75bf1f48).
 */
export function tokenStoreProblem(s: TokenStore): string | null {
  try {
    tokenStore(s);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Checks relay-owned persistent state before a turn and returns its resolved root and writable
 * subdirectories. The root must be a real directory (not a link), the person's own and writable by
 * no one else; each writable subdirectory, and every directory on the way to it, must be a real
 * directory, checked without following links; a missing one is created (mode 0700). Throws, so the
 * turn is refused, when something has been swapped for a link or a file.
 */
export function persistentState(p: { root: string; writable: string[] }): { root: string; writable: string[] } {
  if (typeof p?.root !== "string" || !path.isAbsolute(p.root)) throw new Error(`relay-owned state needs an absolute root: ${JSON.stringify(p?.root)}`);
  const top = fs.lstatSync(p.root, { throwIfNoEntry: false });
  if (!top || top.isSymbolicLink() || !top.isDirectory()) throw new Error(`relay-owned state ${p.root} is ${top ? "not a plain directory" : "missing"}; relay creates it before the turn and does not run on anything else`);
  if (typeof process.getuid === "function" && top.uid !== process.getuid()) throw new Error(`relay-owned state ${p.root} is not owned by this user`);
  if (top.mode & 0o022) throw new Error(`relay-owned state ${p.root} is writable by others (mode ${(top.mode & 0o777).toString(8)})`);
  const root = canonical(p.root, "state.persistent.root");
  const writable = (p.writable ?? []).map((rel, i) => {
    const what = `state.persistent.writable[${i}]`;
    if (typeof rel !== "string" || !rel || path.isAbsolute(rel) || /[\0\r\n]/.test(rel) || path.normalize(rel) !== rel.replace(/\/+$/, "") || rel.split("/").includes("..") || rel === ".") {
      throw new Error(`${what} must be a plain relative path inside the state: ${JSON.stringify(rel)}`);
    }
    let at = root;
    for (const part of rel.split("/").filter(Boolean)) {
      at = path.join(at, part);
      const st = fs.lstatSync(at, { throwIfNoEntry: false });
      if (!st) fs.mkdirSync(at, { mode: 0o700 });
      else if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`relay-owned state ${at} has been replaced by something other than a directory, which the sandbox would follow, so relay does not run on it`);
      }
    }
    return at;
  });
  return { root, writable };
}

/** Variables relay sets for every confined launch, which a harness profile's environment may not replace. */
const RESERVED_ENV = /^(HOME|TMPDIR|PATH|XDG_[A-Z_]+|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|NODE_USE_ENV_PROXY|NODE_OPTIONS|DYLD_.*|LD_.*)$/;

/**
 * The environment for the harness's state: with a temporary home, the home itself (created inside
 * the turn's temp dir, mode 0700), the harness's home variables and the XDG directories pointing into
 * it, and links to the real token files it must read; then the harness profile's own variables
 * (auto-updaters off). Creates the home; touches nothing outside the turn's temp dir.
 */
function stateEnv(policy: ConfinementPolicy, tmpDir: string): Record<string, string> {
  const state = policy.state ?? { home: "temp" as const };
  const env: Record<string, string> = {};
  const homeVars = state.homeVars ?? {};
  if (state.home === "temp") {
    const home = path.join(tmpDir, "home");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const inside = (rel: string, what: string) => {
      const at = path.resolve(home, rel);
      if (path.isAbsolute(rel) || !within(at, home)) throw new Error(`${what} must be a path inside the temporary home: ${JSON.stringify(rel)}`);
      return at;
    };
    Object.assign(env, {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"),
    });
    for (const [name, rel] of Object.entries(homeVars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RESERVED_ENV.test(name)) throw new Error(`state.homeVars cannot set ${name}`);
      env[name] = inside(rel, `state.homeVars.${name}`);
      fs.mkdirSync(env[name], { recursive: true, mode: 0o700 });
    }
    // Links, not copies: the harness reads its login through them; relay never opens the files.
    for (const [rel, real] of Object.entries(state.links ?? {})) {
      const at = inside(rel, `state.links[${JSON.stringify(rel)}]`);
      fs.mkdirSync(path.dirname(at), { recursive: true, mode: 0o700 });
      fs.rmSync(at, { force: true });
      fs.symlinkSync(canonical(real, `state.links[${JSON.stringify(rel)}]`), at);
    }
  } else if (state.home === "real") {
    if (Object.keys(homeVars).length || Object.keys(state.links ?? {}).length) throw new Error("state.homeVars and state.links apply only to a temporary home");
  } else {
    throw new Error(`unknown state.home ${(state as { home: unknown }).home}`);
  }
  for (const [name, value] of Object.entries(state.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RESERVED_ENV.test(name) || name in env) throw new Error(`state.env cannot set ${name}`);
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`state.env.${name} is not a string`);
    env[name] = value;
  }
  return env;
}

/**
 * The sandbox-exec command line for a policy. The command must be an absolute path. With a
 * temporary home (the default) this creates it inside the turn's temp dir.
 */
export function seatbeltLaunch(policy: ConfinementPolicy, command: string, args: string[]): ConfinedLaunch {
  if (!path.isAbsolute(command)) throw new Error(`the confined command must be an absolute path: ${command}`);
  const { profile, params } = seatbeltProfile(policy, command);
  const prefix = ["-p", profile, ...params.flatMap(([k, v]) => ["-D", `${k}=${v}`])];
  const tmpDir = canonical(policy.tmpDir, "tmpDir");
  const env = {
    ...stateEnv(policy, tmpDir),
    TMPDIR: tmpDir,
    ...(policy.network.mode === "off-except-proxy" ? proxyEnv(policy.network.proxyPort, policy.network.proxyToken) : {}),
  };
  return {
    command: SANDBOX_EXEC,
    args: [...prefix, command, ...args],
    rewrap: (c, a) => ({ command: SANDBOX_EXEC, args: [...prefix, c, ...a] }),
    // The profile, every parameter, and the variables relay sets for the launch.
    fingerprint: crypto.createHash("sha256").update(JSON.stringify({ prefix, env })).digest("hex"),
    rules: crypto.createHash("sha256").update(profile).digest("hex"),
    env,
    diagnosticTag: diagnosticTag(policy),
  };
}

/**
 * Whether a process runs under a Seatbelt profile: sandbox_check(pid, NULL, 0), asked through
 * osascript's JavaScript bridge, which every Mac has. After exec the harness keeps sandbox-exec's
 * pid, so the pid relay spawned is the one to check. Any failure reads as not confined.
 */
export function sandboxed(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const jxa = `ObjC.bindFunction('sandbox_check',['int',['int','void *','int']]); $.sandbox_check(${pid}, null, 0)`;
  try {
    return execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", jxa], { encoding: "utf8", timeout: 10000 }).trim() === "1";
  } catch {
    return false;
  }
}

export const seatbelt: Confinement = {
  id: "seatbelt",
  unavailable() {
    if (process.platform !== "darwin") return "Seatbelt exists only on macOS";
    try {
      fs.accessSync(SANDBOX_EXEC, fs.constants.X_OK);
    } catch {
      return `${SANDBOX_EXEC} is missing`;
    }
    return null;
  },
  wrap: seatbeltLaunch,
  confined: sandboxed,
};
