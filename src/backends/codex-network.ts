// The network a Codex turn gets when it is given one (a grant or child_network), and what relay
// checks before it trusts it. Codex's own sandbox with `network.enabled = true` alone opens every
// outbound connection, Unix sockets anywhere and all of loopback (sandboxing/src/seatbelt.rs
// dynamic_network_policy_for_network). With its network proxy on (features.network_proxy, experimental
// in 0.163.0 and 0.164.0), the shell's traffic goes through a proxy Codex runs outside the sandbox,
// Seatbelt lets commands reach only that proxy's two loopback ports, and the proxy refuses loopback,
// private and other non-public destinations unless allow_local_binding is on. So relay gives a
// network grant one of three modes:
//
// - strict: the proxy, allow_local_binding off, Unix sockets only under the turn's TMPDIR and (a
//   write turn) the job's worktree;
// - local: the same with allow_local_binding on (all of loopback and the LAN), a write job's only,
//   with the person's consent (grant.local_network);
// - hosted: no shell network at all, Codex's hosted web search only, where relay cannot verify the
//   proxy (an unknown feature key is silently ignored by Codex, so reading back the key proves nothing).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { publicAddress } from "../confine/proxy.js";

export type CodexNetworkMode = "strict" | "local" | "hosted";

/** What a proxied turn's network does and does not reach, in the words the agent and the caller are told. */
export const NETWORK_MODE_TEXT: Record<CodexNetworkMode, string> = {
  strict: "strict: shell network through Codex's proxy. HTTP(S) works (curl, git over https, npm, pip); raw TCP, ssh remotes, direct DNS, this Mac's loopback and the local network do not. Residual: system trustd certificate fetches can bypass these network restrictions",
  local: "local: shell network through Codex's proxy, with this Mac's loopback and the local network open (the person consented). HTTP(S) works; raw TCP to other hosts, ssh remotes and direct DNS do not. Residual: system trustd certificate fetches can bypass these network restrictions",
  hosted: "hosted search only: Codex's hosted web search works; the shell has no network",
};

// --- Addresses ---

/** An IPv4 address as its four octets, or null. */
function octets(ip: string): number[] | null {
  if (net.isIPv4(ip)) return ip.split(".").map(Number);
  return null;
}

/** An IPv6 address (zone id dropped) as its eight 16-bit groups, an embedded dotted IPv4 tail included, or null. */
export function ipv6Groups(ip: string): number[] | null {
  const a = ip.split("%")[0];
  if (!net.isIPv6(a)) return null;
  // A dotted IPv4 tail (`::ffff:127.0.0.1`) as the two hex groups it stands for.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(a)?.[1];
  const o = tail ? octets(tail) : null;
  const text = o ? `${a.slice(0, -tail!.length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}` : a;
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const gap = rest !== undefined ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(gap, 0)).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const inV4 = (o: number[], base: number[], prefix: number): boolean => {
  const n = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const b = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (n & mask) === (b & mask);
};

/**
 * Codex's proxy's own classification of an IPv4 address as non-public, which it refuses with
 * allow_local_binding off: network-proxy/src/policy.rs is_non_public_ipv4 (rust-v0.164.0 lines
 * 62-80; unchanged in 0.163.0 and 0.165.0). Rust's is_loopback, is_private, is_link_local,
 * is_unspecified, is_multicast and is_broadcast, then its CIDR list.
 */
function codexNonPublicV4(o: number[]): boolean {
  return inV4(o, [127, 0, 0, 0], 8) // is_loopback
    || inV4(o, [10, 0, 0, 0], 8) || inV4(o, [172, 16, 0, 0], 12) || inV4(o, [192, 168, 0, 0], 16) // is_private
    || inV4(o, [169, 254, 0, 0], 16) // is_link_local
    || inV4(o, [0, 0, 0, 0], 32) // is_unspecified
    || inV4(o, [224, 0, 0, 0], 4) // is_multicast
    || inV4(o, [255, 255, 255, 255], 32) // is_broadcast
    || inV4(o, [0, 0, 0, 0], 8) // "this network" (RFC 1122)
    || inV4(o, [100, 64, 0, 0], 10) // CGNAT (RFC 6598)
    || inV4(o, [192, 0, 0, 0], 24) // IETF Protocol Assignments (RFC 6890)
    || inV4(o, [192, 0, 2, 0], 24) // TEST-NET-1
    || inV4(o, [198, 18, 0, 0], 15) // Benchmarking (RFC 2544)
    || inV4(o, [198, 51, 100, 0], 24) // TEST-NET-2
    || inV4(o, [203, 0, 113, 0], 24) // TEST-NET-3
    || inV4(o, [240, 0, 0, 0], 4); // Reserved (RFC 6890)
}

/**
 * Codex's proxy's classification of an address as non-public (policy.rs is_non_public_ip, lines
 * 55-60, and is_non_public_ipv6, lines 105-119, rust-v0.164.0): an IPv6 address Rust's to_ipv4
 * turns into an IPv4 one (`::a.b.c.d` and `::ffff:a.b.c.d`, so `::1` as 0.0.0.1) is judged as that,
 * or loopback; otherwise loopback, unspecified, multicast (ff00::/8), unique local (fc00::/7) and
 * unicast link-local (fe80::/10). Anything else, a global IPv6 address included, is public to it.
 */
export function codexNonPublicIp(ip: string): boolean {
  const v4 = octets(ip);
  if (v4) return codexNonPublicV4(v4);
  const g = ipv6Groups(ip);
  if (!g) return true;
  const loopback = g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    return codexNonPublicV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]) || loopback;
  }
  return loopback || g.every((x) => x === 0) || (g[0] & 0xff00) === 0xff00 || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80;
}

/**
 * The first address of this Mac's own interfaces, internal ones included (a public address aliased
 * on lo0 is still this Mac's), that either Codex's proxy or relay's own proxy (confine/proxy.ts
 * publicAddress) treats as public, with why that matters, or null. Codex's
 * proxy decides by the address alone: one of the Mac's own public addresses (a global IPv6 address,
 * say) is a public destination to it, so a command could reach every service listening on all
 * interfaces of this Mac (sshd among them) through the proxy. Strict mode is not offered then.
 */
export function ownPublicAddress(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): { address: string; why: string } | null {
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      const address = a.address.split("%")[0];
      const codex = !codexNonPublicIp(address);
      if (codex || publicAddress(address)) {
        return {
          address,
          why: `this Mac's interface ${name} has the address ${address}, which ${codex ? "Codex's network proxy" : "relay"} treats as public, so a command could reach this Mac's own services through the proxy at that address`,
        };
      }
    }
  }
  return null;
}

// --- Exec-policy rules ---

/**
 * The folders Codex reads `rules/*.rules` from for a turn in `cwd` (core/src/exec_policy.rs
 * load_exec_policy, rust-v0.164.0 lines 667-686: each config layer's folder, config/src/state.rs
 * config_folder: the user layer's ($CODEX_HOME), the system layer's (/etc/codex) and each project
 * layer's `.codex`). Taken from the layers config/read reports, and, so that a layer it leaves out
 * still counts, also $CODEX_HOME (or ~/.codex), /etc/codex and the `.codex` folder of the turn's
 * directory and of every directory above it (config/src/loader/mod.rs discover_project_layers reads
 * those between the project root and cwd; every ancestor is a superset).
 */
export function codexRuleFolders(o: { layers?: unknown; env: NodeJS.ProcessEnv; cwd: string }): string[] {
  const out = new Set<string>();
  if (Array.isArray(o.layers)) {
    for (const l of o.layers) {
      const n = (l as { name?: Record<string, unknown> } | null)?.name;
      if (!n || typeof n !== "object") continue;
      if ((n.type === "user" || n.type === "system") && typeof n.file === "string") out.add(path.dirname(n.file));
      if (n.type === "project" && typeof n.dotCodexFolder === "string") out.add(n.dotCodexFolder);
    }
  }
  const home = o.env.HOME || os.homedir();
  out.add(o.env.CODEX_HOME || path.join(home, ".codex"));
  out.add("/etc/codex");
  for (let d = path.resolve(o.cwd); ; d = path.dirname(d)) {
    out.add(path.join(d, ".codex"));
    if (path.dirname(d) === d) break;
  }
  return [...out];
}

/**
 * Exec-policy rules files in these folders that hold `network_rule`, read as plain text, or why they
 * could not all be read. A rule allowing an exact local host (`127.0.0.1`, `localhost`) counts in
 * Codex's proxy as an explicit local allowlist entry, which opens that host even with
 * allow_local_binding off (network-proxy/src/runtime.rs:866-868, is_explicit_local_allowlisted
 * at :1343; connect_policy.rs:103-110), and relay cannot read rules back from the app server. Any
 * `network_rule` at all, in any form, keeps a turn out of strict mode: the text is not parsed.
 */
export function networkRuleFiles(folders: string[]): { files: string[] } | { error: string } {
  const files: string[] = [];
  for (const folder of folders) {
    const dir = path.join(folder, "rules");
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return { error: `relay could not read Codex's rules folder ${dir} (${code ?? (err as Error).message})` };
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".rules")) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).isDirectory()) continue;
        if (fs.readFileSync(file, "utf8").includes("network_rule")) files.push(file);
      } catch (err) {
        return { error: `relay could not read Codex's rules file ${file} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})` };
      }
    }
  }
  return { files };
}

// --- The canary ---

/**
 * Run by Codex itself in the turn's sandbox (command/exec with relay's profile) before any agent
 * runs: whether it was given a proxy, and what becomes of a direct loopback connection, a Unix
 * socket outside the places allowed, and a request for loopback through the proxy. argv: the port
 * and socket of relay's own listeners. Prints one JSON line.
 */
export const CANARY_SCRIPT = `(()=>{const net=require("net");const [port,sock]=process.argv.slice(1);const r={proxy:process.env.HTTP_PROXY||null};let n=0;
const done=()=>{if(++n===3){process.stdout.write(JSON.stringify(r)+"\\n");process.exit(0)}};
const t=(k,o)=>{const s=net.connect(o);s.setTimeout(5000);s.on("connect",()=>{r[k]="connected";s.destroy();done()});s.on("error",(e)=>{r[k]=e.code||String(e.message);done()});s.on("timeout",()=>{r[k]="timeout";s.destroy();done()})};
t("loop",{host:"127.0.0.1",port:+port});t("unix",{path:sock});
if(!r.proxy){r.viaProxy="no proxy";done()}else{let u;try{u=new URL(r.proxy)}catch{r.viaProxy="bad proxy";done();return}
const q=net.connect({host:u.hostname,port:+u.port},()=>q.write("GET http://127.0.0.1:"+port+"/relay-canary HTTP/1.1\\r\\nHost: 127.0.0.1:"+port+"\\r\\nConnection: close\\r\\n\\r\\n"));
let b="";q.setTimeout(5000);q.on("data",(d)=>{b+=d});q.on("end",()=>{r.viaProxy=b.split("\\r\\n")[0];done()});q.on("timeout",()=>{r.viaProxy="timeout";q.destroy()});q.on("error",(e)=>{if(r.viaProxy===undefined){r.viaProxy=e.code||"error";done()}})}})()`;

/** relay's own listeners for one canary: a loopback port and a Unix socket outside every place a turn may use. They count what reaches each. */
export interface CanaryTargets { port: number; sock: string; hits(): CanaryHits; close(): void }
export interface CanaryHits { tcp: number; unix: number }

export async function openCanaryTargets(): Promise<CanaryTargets> {
  // Short, under /tmp (a Unix socket path is limited to 104 bytes), private to this user, and outside
  // the turn's TMPDIR and worktree.
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/relay-cn-"));
  fs.chmodSync(dir, 0o700);
  const sock = path.join(dir, "s");
  const hits: CanaryHits = { tcp: 0, unix: 0 };
  const tcp = net.createServer((s) => { hits.tcp++; s.destroy(); });
  const unix = net.createServer((s) => { hits.unix++; s.destroy(); });
  try {
    await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(0, "127.0.0.1", () => resolve()); });
    await new Promise<void>((resolve, reject) => { unix.once("error", reject); unix.listen(sock, () => resolve()); });
  } catch (err) {
    tcp.close(); unix.close(); fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    port: (tcp.address() as net.AddressInfo).port, sock, hits: () => ({ ...hits }),
    close: () => { tcp.close(); unix.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const SANDBOX_DENIED = new Set(["EPERM", "EACCES"]);

/**
 * What the canary's output says is wrong with the turn's network for `mode`, or null. Strict: a
 * proxy on loopback, Seatbelt refusing a direct loopback connection and the Unix socket, the proxy
 * refusing loopback (403), and nothing reaching relay's listeners. Local: the proxy, and the socket
 * refused, nothing reaching it (loopback is open by design, relay's port included).
 */
export function canaryProblem(stdout: string, mode: "strict" | "local", hits: CanaryHits): string | null {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(stdout.trim().split("\n").pop() ?? "");
  } catch {
    return `its sandbox check printed no result (${JSON.stringify(stdout.slice(0, 200))})`;
  }
  if (typeof r.proxy !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(r.proxy)) return `a command in its sandbox was not given Codex's network proxy (HTTP_PROXY ${JSON.stringify(r.proxy ?? null)})`;
  if (!SANDBOX_DENIED.has(String(r.unix))) return `a command in its sandbox could reach a Unix socket outside the places relay allows (${JSON.stringify(r.unix)})`;
  if (mode === "strict") {
    if (!SANDBOX_DENIED.has(String(r.loop))) return `a command in its sandbox could connect to this Mac's loopback directly (${JSON.stringify(r.loop)})`;
    if (typeof r.viaProxy !== "string" || !r.viaProxy.startsWith("HTTP/1.1 403")) return `Codex's proxy did not refuse a request for this Mac's loopback (${JSON.stringify(r.viaProxy ?? null)})`;
  }
  const reached = hits.unix + (mode === "strict" ? hits.tcp : 0);
  if (reached > 0) return `a command in its sandbox reached relay's own test listener (${reached} connection${reached === 1 ? "" : "s"})`;
  return null;
}

/**
 * For relay doctor: the non-empty exec-policy rules files Codex loads for every directory
 * ($CODEX_HOME/rules, or ~/.codex/rules, and /etc/codex/rules; project rules depend on a job's
 * directory, which doctor has none of), and what they mean for relay's jobs. Reads a few small files.
 */
export function codexRulesDoctor(env: NodeJS.ProcessEnv = process.env): string {
  const folders = [env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"), "/etc/codex"];
  const found: string[] = [];
  const networked: string[] = [];
  const unread: string[] = [];
  for (const folder of folders) {
    const dir = path.join(folder, "rules");
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".rules")).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") unread.push(dir);
    }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        const text = fs.readFileSync(file, "utf8");
        if (!text.trim()) continue;
        found.push(file);
        if (text.includes("network_rule")) networked.push(file);
      } catch {
        unread.push(file);
      }
    }
  }
  const where = folders.map((f) => path.join(f, "rules")).join(" or ");
  if (!found.length && !unread.length) return `no exec-policy rules in ${where} (project .codex/rules are read per job)`;
  return [
    found.length ? `exec-policy rules in ${found.join(", ")}: relay's Codex jobs run the commands they allow inside the sandbox (relay's profile denies reads of credential stores, so no rule takes a command out of it)` : "",
    networked.length ? `${networked.join(", ")} hold network_rule, so network-granted Codex jobs fall back to hosted web search only` : "",
    unread.length ? `relay could not read ${unread.join(", ")}, so network-granted Codex jobs fall back to hosted web search only` : "",
  ].filter(Boolean).join("; ");
}
