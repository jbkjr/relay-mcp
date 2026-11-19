import crypto from "node:crypto";
import type { Grant } from "../backends/types.js";
import type { Mode, RelayConfig, Target } from "./config.js";
import { getNode, now, runConfig, setParam, type NodeRow } from "./db.js";
import { sessionParams } from "./params.js";
import { requestApproval } from "./approvals.js";
import { JOB_BLOCK_SIZE, STATIC_DENIED_TCP, STATIC_DENIED_UDP } from "../confine/ports.js";
import { targetDef, targetLabel } from "../targets/index.js";
import { overlayInterlock } from "./restart-overlay.js";

/**
 * Stage 2's grant, consent and interlock (docs/codex-confinement-design.md §6, decisions D1, D2;
 * review X5, C2). Owner: WP-E.
 *
 * The switch: `targets.codex.stage2: true` in relay's config (the run's, which is fixed when the run
 * starts). RELAY_EXPERIMENTAL_CODEX_STAGE2=1 in relay's environment also switches it on, for tests
 * and development.
 */
export { STAGE2_FLAG_ENV, stage2Enabled } from "./stage2-switch.js";
import { stage2Enabled } from "./stage2-switch.js";

/** What the static denied ports are, for the person (§5.3, decision D5). A port without a name here is listed by number. */
const PORT_NAMES: Record<number, string> = {
  22: "ssh", 5900: "screen sharing", 3283: "Remote Management",
  3031: "Remote Apple Events", 445: "SMB file sharing", 548: "AFP file sharing", 631: "printing",
};
const portList = (ports: readonly number[]) => ports.map((p) => (PORT_NAMES[p] ? `${p} (${PORT_NAMES[p]})` : String(p))).join(", ");

/**
 * What consenting to a Codex job's raw network does (§6, §5.2-5.9; decisions D3, D4, D6, D9): the
 * effect relay shows the person with the request (approvals.ts effectOf). Every clause is a
 * consequence the design states; none claims more than the profile enforces.
 */
export const RAW_NETWORK_CONSENT_TEXT =
  "lets this Codex job's shell use raw network for the rest of the job, inside relay's own sandbox instead of Codex's: " +
  "TCP, UDP, ssh and DNS to any host, not only HTTP(S) through a proxy. " +
  "It can reach every device and service on your local network (LAN) and your tailnet, on any port, with your account's reach. " +
  "On this Mac it can reach every service on loopback except the denied ports: " +
  `TCP ${portList(STATIC_DENIED_TCP)}, the ports your never.ports entries name, every TCP port anything on this Mac (your processes or the system's) is listening on when each turn starts, and relay's own reserved ports; ` +
  `UDP ${STATIC_DENIED_UDP.join(" and ")} (port mappings on your router) to every host. ` +
  "A service you start after a turn starts is reachable. " +
  "Over IPv6 those TCP ports are refused at every host, since relay's sandbox cannot otherwise refuse the IPv6 forms of this Mac's addresses: IPv6 to those port numbers anywhere, and IPv4 that a program sends through an IPv6 socket (as Java does), fails. " +
  "Otherwise the deny covers only this Mac's own addresses as destinations: a router port forward reached back through NAT hairpin, a tailnet subnet router or a VM bridge can still lead to a denied service. " +
  `It can listen only on its own block of ${JOB_BLOCK_SIZE} TCP ports (given to it as PORT and PORTS), and a server it binds there on 0.0.0.0 can be reached from your LAN and tailnet. ` +
  "Inside the job, git commands that write (git add, commit, stash, checkout -b) fail: relay commits the job's work at the end of each turn, with its own message. " +
  "Without it, give the job grant.network alone: public internet through relay's stage-2 mediated proxy, and nothing local without a separately approved addition; no Go/Swift TLS until Release B, and tools ignoring proxy variables fail closed";

/**
 * What a stage-2 turn's agent is told at the top of its input (WP-C prepends it in
 * codexBackend.start, as chooseNetwork's prefix is for proxied turns): the network it has, where it
 * may listen, and that git cannot write (decision D6).
 */
export const RAW_NETWORK_TURN_NOTE =
  "[relay] This turn your shell has raw network (TCP, UDP, ssh, DNS) to the internet, the local network and this Mac's loopback, except some denied local ports. " +
  "Listen only on the TCP ports in $PORTS ($PORT is the first), bound to 127.0.0.1: other ports, and port 0, are refused. " +
  "git commands that write (add, commit, stash, checkout -b, rebase) fail here: leave your changes in the working tree, and relay commits them when the turn ends.";

/**
 * Admission of a grant with raw_network, for a caller's delegate or resume (caller.ts admitWork,
 * after checkGrant has refused a grant from anyone but the root session). Null when the grant does
 * not ask for it, or asks for it where it can run. The person's consent is asked later, before the
 * job's first turn under it (rawNetworkConsent); where nobody could be asked, admitWork refuses up
 * front (personConsentAdmission).
 *
 * It needs `network: true` in the same grant. Raw network is more network, not another kind: every
 * other place in relay that asks whether a job has network (networkOn, the web tools, capable, the
 * MCP-server rule, authority) reads grant.network, so they all treat the job as networked without
 * each learning about raw_network; and a resume that drops raw_network falls back to strict network,
 * not to none. A grant of raw network without network would contradict itself.
 */
export function rawNetworkGrantProblem(grant: Grant | undefined, mode: Mode, target: Target, cfg?: Pick<RelayConfig, "codex_backend" | "targets">): string | null {
  if (grant?.raw_network === undefined) return null;
  if (typeof grant.raw_network !== "boolean") return "grant.raw_network must be true or false.";
  if (!grant.raw_network) return null;
  if (!stage2Enabled(process.env, cfg)) return "grant.raw_network is not available: relay's stage 2 (Codex commands in relay's own sandbox) is switched off (targets.codex.stage2 in relay's config). Omit it; grant.network gives internet over HTTP(S).";
  if (target !== "codex") return `grant.raw_network is for Codex write jobs only: ${targetLabel(targetDef(target))} has no mode in which relay's own sandbox gives its shell raw network. Omit it.`;
  if (mode !== "write") return "grant.raw_network is for Codex write jobs only: a read-only session's shell never gets raw network. Use grant.network for internet over HTTP(S).";
  if (grant.network !== true) return "grant.raw_network needs network: true in the same grant: it widens the job's network to raw TCP, UDP, ssh and DNS.";
  if (grant.local_network) return "grant.raw_network and grant.local_network cannot be combined: choose one. raw_network gives raw network inside relay's sandbox; local_network gives HTTP(S) through Codex's proxy with this Mac's loopback and local network open.";
  if (cfg?.codex_backend === "exec") return 'grant.raw_network needs codex_backend "app-server": relay runs raw-network Codex jobs through the app server only.';
  return null;
}

/**
 * The key a consent is bound to: the parts of the grant that decide what the job's shell can reach
 * or write, and the consent text the person was shown. A resume whose grant changes any of them,
 * or a relay whose consent text says something else, asks again.
 */
export function rawNetworkKey(grant: Grant): string {
  return JSON.stringify({
    network: grant.network === true, raw_network: grant.raw_network === true, write_paths: [...(grant.write_paths ?? [])].sort(),
    text: crypto.createHash("sha256").update(RAW_NETWORK_CONSENT_TEXT).digest("hex").slice(0, 16),
  });
}

/** The question the person is asked about a Codex job's raw network (the request's `wants`). */
export function rawNetworkText(node: Pick<NodeRow, "id" | "target">): string {
  return `allow ${node.id} (${node.target ? targetLabel(targetDef(node.target)) : "the agent"}, a write job) raw network from its shell (TCP, UDP, ssh, DNS) inside relay's sandbox, with your local network and tailnet reachable, for the rest of the job`;
}

/**
 * Before a turn of a job whose grant says raw_network: the person's consent, once for the grant the
 * turn launches with, stored in the session's params as `raw_network_consent` (params.ts). Same
 * shape as session.ts localNetworkConsent. Null when there is nothing to ask.
 *
 * `node` is the job as the turn read it when it was picked up (session.ts), whose grant the turn
 * records and launches with (grantFor). The decision and the key are that grant's, never the
 * session's current one: a resume while the turn waits (for its slot, or for consent to its
 * extensions) replaces the session's grant at once, and the waiting turn still launches with the
 * one it read (review R2). stage2Admission checks the stored consent against the turn's grant
 * again, last thing before the launch (rawNetworkConsentProblem).
 *
 * A consent is for the grant it was given under (review r_17565c33 C4, as for local network): once
 * the session holds another grant, whatever this turn's access, it is gone, and a grant that comes
 * back later is asked about again. ops.ts resume clears it too, as it stores the new grant.
 */
export async function rawNetworkConsent(
  node: NodeRow, turnId: number, access: Mode, cancelCheck: () => boolean,
): Promise<null | { refusal: string } | { cancelled: string }> {
  const params = sessionParams(getNode(node.id)!);
  const standing = params.grant ?? undefined;
  const given = params.raw_network_consent ?? null;
  if (given && (!standing?.raw_network || rawNetworkKey(standing) !== given.grant)) setParam(node.id, "raw_network_consent", null);
  // The turn's own grant, as it read it (above).
  const grant = sessionParams(node).grant ?? undefined;
  if (!grant?.raw_network) return null;
  // A read turn of the job (a discussion on its session, say) keeps only grant.network (session.ts grantFor).
  if (node.target !== "codex" || access !== "write") return null;
  const off = "so its agent was not started. Continue it with a grant without raw_network (grant.network gives internet over HTTP(S))";
  if (grant.network !== true) return { refusal: `this job's grant holds raw_network without network, ${off}.` };
  if (!stage2Enabled(process.env, runConfig(node.run_id))) return { refusal: `relay's stage 2 (raw network in relay's own sandbox) is switched off, ${off}.` };
  const key = rawNetworkKey(grant);
  if (sessionParams(getNode(node.id)!).raw_network_consent?.grant === key) return null;
  const answer = await requestApproval(node.id, turnId, { kind: "raw_network", summary: rawNetworkText(node) }, cancelCheck);
  if (!answer.allow) {
    if (cancelCheck()) return { cancelled: "cancelled while waiting for the user's consent to its raw network" };
    const why = answer.decider
      ? `consent to this job's raw network was refused ${answer.decider}${answer.deciderNote ? ` (${answer.deciderNote})` : ""}`
      : `nobody consented to this job's raw network (${answer.note ?? "no answer"})`;
    return { refusal: `${why}, so its agent was not started. Continue it to be asked again, or continue it with a grant without raw_network (grant.network gives internet over HTTP(S)).` };
  }
  setParam(node.id, "raw_network_consent", { grant: key, by: answer.decider ?? "by the user", at: now() });
  return null;
}

/**
 * Admission step 1 (§2.2): the person's consent, as stored, is for the grant this turn launches
 * with. Null when it is; otherwise why not. Read last thing before the launch (stage2Admission), so
 * a consent that a resume ended while the turn started (ops.ts), or a turn that reached the launch
 * without being asked, refuses rather than runs.
 */
export function rawNetworkConsentProblem(nodeId: string | undefined, grant: Grant | undefined): string | null {
  if (!grant?.raw_network) return "the turn's grant does not hold raw_network";
  const node = nodeId ? getNode(nodeId) : undefined;
  if (!node) return "relay cannot find the job in its registry, so it cannot read the person's consent";
  const given = sessionParams(node).raw_network_consent ?? null;
  if (!given) return "the person has not consented to this job's raw network, or a resume that changed its grant ended the consent while this turn started. Continue it to be asked again";
  if (given.grant !== rawNetworkKey(grant)) return "the person's consent is for another grant than the one this turn holds (a resume changed it while this turn started). Continue it to be asked again";
  return null;
}

/**
 * Local mode (1.0.5's grant.local_network: Codex's proxy with allow_local_binding) while stage 2 is
 * switched on: refused outright, a step towards retiring it (decision D2; review R3, approved by
 * the maintainer 2026-10-28). Codex's local-mode proxy has no authentication and reaches every port on
 * loopback and the LAN, so a raw-network job could go through it to every denied port (§5.4, C2).
 * `cfg`: the run's config. Null when local mode may run, as in 1.0.5 with stage 2 off.
 *
 * Refused at admission (caller.ts admitWork), before the turn of a job that already holds it
 * (session.ts localNetworkConsent) and at the launch (codex.ts chooseNetwork). The other direction
 * stays with localModeInterlock: a raw-network turn is refused while a local-mode turn that started
 * before the switch still runs.
 */
export function localModeRetired(cfg?: Pick<RelayConfig, "targets">): string | null {
  if (stage2Enabled(process.env, cfg)) {
    return "grant.local_network is not available while relay's stage 2 is switched on (targets.codex.stage2 in relay's config): " +
      "Codex's local-network proxy has no authentication, so a raw-network job could reach every local service through it. " +
      "Use grant.raw_network (raw network in relay's own sandbox, with your consent) or grant.network alone (internet over HTTP(S))";
  }
  const overlay = overlayInterlock("local");
  if (overlay) return `grant.local_network is not available: ${overlay}`;
  return null;
}

/** Per-registry launch/overlay/executor interlock. Captures survive flag/grant changes. */
export function localModeInterlock(starting: "stage2" | "local"): string | null {
  return overlayInterlock(starting);
}
