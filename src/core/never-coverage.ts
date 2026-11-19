// Which targets' jobs the never floor binds: the one place that decides it. The backends
// (claude.ts, never-admission.ts, acp.ts, confine/turn.ts), approvals and doctor all ask here,
// so what doctor says cannot drift from what a launch does.
import type { Target } from "../targets/types.js";
import { stage2Enabled } from "./stage2-switch.js";

type Stage2Config = { targets?: { codex?: { stage2?: boolean } } };

/**
 * When a target's jobs get the floor in their sandbox: "always", or only while stage 2 is on.
 * Codex and Claude always (Claude since the decision of 2026-11-04: its variant gates, managed
 * settings refusal and command-approval refusal then apply with stage 2 off too). Relay-owned
 * Seatbelt profiles (Copilot, Gemini, Grok) get it with stage 2 only: the floor is part of Release
 * A's experimental wiring there, and Copilot's and Grok's released login routes (keychain, token
 * store, certificate trust) conflict with its denies.
 */
export const NEVER_FLOOR_WHEN: Readonly<Record<Target, "always" | "stage2">> = {
  codex: "always",
  claude: "always",
  copilot: "stage2",
  gemini: "stage2",
  grok: "stage2",
};

/** Targets whose released login route conflicts with the floor: refused whenever it applies. */
export const NEVER_FLOOR_CONFLICT: Readonly<Partial<Record<Target, string>>> = {
  copilot: "never: Copilot's current KEYCHAIN/TRUST login route bypasses credential/network isolation. Use a qualified store-denying target; credential separation is deferred.",
  grok: "never: Grok's current token-store/TRUST route bypasses credential/network isolation. Use a qualified store-denying target; credential separation is deferred.",
};

/** Settings under which a floored Claude job is refused (never-admission.ts): each can take the job around the checked sandbox or tool route. allow_dangerous refuses write jobs only. */
export function claudeFloorVariants(cfg: { child_settings?: string; child_hooks?: boolean; child_mcp?: string; allow_dangerous?: boolean }): string[] {
  return [
    ...(cfg.child_settings !== "isolated" ? [`child_settings "${cfg.child_settings ?? "unset"}"`] : []),
    ...(cfg.child_hooks ? ["child_hooks true"] : []),
    ...(cfg.child_mcp !== "relay-only" ? [`child_mcp "${cfg.child_mcp ?? "unset"}"`] : []),
    ...(cfg.allow_dangerous ? ["allow_dangerous (write jobs)"] : []),
  ];
}

/** Whether relay applies the never floor to this target's jobs under this config. An unknown id gets it. */
export function neverFloorApplies(target: string, cfg?: Stage2Config, env: NodeJS.ProcessEnv = process.env): boolean {
  const when = (NEVER_FLOOR_WHEN as Record<string, "always" | "stage2" | undefined>)[target] ?? "always";
  return when === "always" || stage2Enabled(env, cfg);
}

/** What happens to this target's jobs: the floor enforced, not applied, or the job refused because its login route conflicts with it. */
export function neverFloorCoverage(target: Target, cfg?: Stage2Config, env: NodeJS.ProcessEnv = process.env): "enforced" | "not enforced" | "refused" {
  if (!neverFloorApplies(target, cfg, env)) return "not enforced";
  return NEVER_FLOOR_CONFLICT[target] ? "refused" : "enforced";
}

/**
 * Keychain IPC: whether a floored job's commands can reach the security daemons
 * (com.apple.SecurityServer, com.apple.securityd.xpc), which the floor's keychain-file denies
 * (credentials.keychain) do not cover. Relay's own Seatbelt is deny-default, allows them only for a
 * profile taking the keychain downgrade (confine/seatbelt.ts KEYCHAIN, Copilot, refused under the
 * floor), and adds a final deny with the floor (confine/seatbelt-never.ts, denyKeychain; it names
 * com.apple.securityd, not com.apple.securityd.xpc). The native sandboxes decide for themselves, and relay
 * adds no such deny to them (backends/claude.ts applyClaudeNeverPolicy; backends/codex.ts
 * codexPermissions), as read from the binaries on 2026-11-04:
 * - Claude Code 2.1.309's sandbox profile allows com.apple.SecurityServer and
 *   com.apple.securityd.xpc on every turn, network or not.
 * - Codex 0.164.0's base profile (deny default) allows neither; its network profile, added on a
 *   turn with shell network, allows com.apple.SecurityServer ("for TLS certificate information").
 *   With stage 2 on, a Codex turn with network runs its commands in relay's executor, under relay's
 *   Seatbelt.
 * Null where the floor is not enforced for the target. "Open" is daemon reachability, not
 * retrieval: an item in a file-based keychain (the login keychain, where gh's keyring token and
 * git's osxkeychain credentials live) also needs its keychain file, which the floor denies, so it
 * stays out of reach (measured with sandbox-exec on 2026-11-04: denying the file alone, or the
 * daemons alone, gives exit 44). The decoy-keychain checks verify both each release: a floored decoy
 * is refused, and its control without the file deny matches this state (qualification item 33 for
 * Codex, release check claude-floor for Claude: scripts/codex-qualify/stage2-escalation-cases.mjs).
 * What the daemons serve without that file, such as data-protection keychain items, is not covered,
 * nor is a copy of a keychain file kept outside the denied directories.
 */
export type KeychainIpc = { networkOff: "closed" | "open"; networkOn: "closed" | "open" };
export function neverKeychainIpc(target: Target, cfg?: Stage2Config, env: NodeJS.ProcessEnv = process.env): KeychainIpc | null {
  if (neverFloorCoverage(target, cfg, env) !== "enforced") return null;
  if (target === "claude") return { networkOff: "open", networkOn: "open" };
  if (target === "codex") return { networkOff: "closed", networkOn: stage2Enabled(env, cfg) ? "closed" : "open" };
  return { networkOff: "closed", networkOn: "closed" }; // Relay's own Seatbelt (ACP targets).
}
const keychainText = (k: KeychainIpc): string => k.networkOff === k.networkOn
  ? `keychain IPC ${k.networkOff}`
  : `keychain IPC ${k.networkOff} on network-off turns, ${k.networkOn} on network-on turns`;

/**
 * Doctor's "never enforced" block, from the same predicate the launches use: a heading, one line
 * per target (all of them, enabled or not) with its path entries and keychain IPC, what "not
 * enforced" and an open keychain IPC leave reachable, and the proxy screen that holds for every
 * agent. The only description of per-target enforcement doctor prints.
 */
export function neverFloorReport(targets: readonly { id: Target; label: string; enabled: boolean }[], cfg: Stage2Config & Parameters<typeof claudeFloorVariants>[0], env: NodeJS.ProcessEnv = process.env): string[] {
  const on = stage2Enabled(env, cfg);
  const lines = [`the floor in each agent's sandbox, with stage 2 ${on ? "on" : "off"} (targets.codex.stage2): its path entries (never.paths and the built-ins, keychain files among them), and keychain IPC (the security daemons) separately:`];
  for (const t of targets) {
    const now = neverFloorCoverage(t.id, cfg, env);
    const stage2Only = NEVER_FLOOR_WHEN[t.id] === "stage2";
    const conflict = Boolean(NEVER_FLOOR_CONFLICT[t.id]);
    let text: string = now;
    if (now === "refused") text = "refused: its login route conflicts with the floor";
    else if (stage2Only && on) text = "path entries enforced, only while stage 2 is on";
    else if (stage2Only) text = conflict ? "not enforced; refused with stage 2 on (its login route conflicts with the floor)" : "not enforced; enforced only with stage 2 on";
    else if (t.id === "codex") text = `path entries enforced in every sandboxed turn's profile${on ? ", and in relay's stage-2 executor" : ""}`;
    else text = "path entries enforced, whatever stage 2 says";
    const keychain = neverKeychainIpc(t.id, cfg, env);
    if (keychain) text += `; ${keychainText(keychain)}`;
    if (t.id === "claude" && now === "enforced") {
      const variants = claudeFloorVariants(cfg);
      text += variants.length ? `; this config's ${variants.join(", ")} refuses its jobs` : "; no inherited settings, hooks or MCP, managed settings, allow_dangerous writes or unsandboxed-command approvals";
    }
    if (t.id === "codex" && cfg.allow_dangerous) text += on ? "; allow_dangerous write jobs refused outside the stage-2 route" : "; not in allow_dangerous write turns, which run without a sandbox";
    lines.push(`${t.label}, ${t.enabled ? "enabled" : "not enabled"}: ${text}`);
  }
  if (targets.some(t => neverFloorCoverage(t.id, cfg, env) === "not enforced")) {
    lines.push("not enforced: that sandbox does not apply the floor's denies, so the agent can read the credential paths (~/.ssh, ~/.aws, CLI logins), keychain files and any never.paths of yours; relay's own config, install and key files stay protected there regardless.");
  }
  if (targets.some(t => { const k = neverKeychainIpc(t.id, cfg, env); return k?.networkOff === "open" || k?.networkOn === "open"; })) {
    lines.push("keychain IPC open: the agent's own sandbox lets its commands reach the security daemons. Items in file-based keychains (the login keychain, where gh's keyring token and git's osxkeychain credentials live) still stay out of reach, since reading one also needs its keychain file, which the floor denies (checked each release: qualification item 33 for Codex, release check claude-floor for Claude). What the daemons serve without that file, such as data-protection keychain items, is not covered, nor is a copy of a keychain file kept outside the denied directories. Only relay's own Seatbelt keeps the daemons closed.");
  }
  lines.push("for every agent, relay's network proxy, where a turn uses one (a Claude network grant, the ACP network-off route), still screens never hosts and ports.");
  return lines;
}
