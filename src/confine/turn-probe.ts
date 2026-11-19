import { prepareLaunch, type ConfinedLaunch, type Confinement, type ConfinementPolicy, type ProbeReport } from "./index.js";

/**
 * The per-turn checks a relay-enforced launch must pass (ADR 0001): `prepareLaunch` in index.ts.
 * Before the harness starts, relay checks every writable directory for hard links, wraps the
 * harness for this turn, and runs the boundary probes under exactly that confinement (probe.ts);
 * any failure refuses the launch with ConfinementRefused naming the check. Nothing is cached.
 *
 * They run before every relay-enforced launch (the ACP driver, and core/caller.ts's capability
 * check asks that they exist). Enabled since 2026-10-17, after the whole battery passed on this
 * Mac under the exact profiles a Copilot read and write turn get (73 and 94 probes, signed-in
 * runs through relay's MCP path). PROBES_ENABLED is the build's switch: false would make
 * `boundaryProbe` return null, and every relay-enforced launch would be refused (NO_PROBE). Tests
 * can stand another probe in (a failing one, say) only through setBoundaryProbeForTests, called by
 * the tests' own code (in-process, or in relay processes they start through a preload module of
 * their own, test/fixtures/boundary-probes.mjs). No config key or environment variable of relay's
 * reaches it, and none turns the probes off.
 */
export type BoundaryProbe = (mechanism: Confinement, policy: ConfinementPolicy, command: string, args: string[], signal?: AbortSignal, environment?: NodeJS.ProcessEnv) => Promise<{ launch: ConfinedLaunch; probes: ProbeReport }>;

/** Whether this build of relay runs the per-turn boundary probes, and so launches relay-enforced targets at all. */
export const PROBES_ENABLED = true;

/** Why relay refuses a relay-enforced launch when it has no boundary probe (a build with PROBES_ENABLED false). */
export const NO_PROBE = "relay cannot yet probe its sandbox's boundary before each turn (the per-turn probes are not enabled in this build of relay), and it does not launch a harness inside its own sandbox unprobed";

let standIn: BoundaryProbe | null = null;

/**
 * Test-only seam: the probe relay-enforced launches get in this process, or null to remove it.
 * Nothing in relay calls this; only test code does.
 */
export function setBoundaryProbeForTests(probe: BoundaryProbe | null): void {
  standIn = probe;
}

/** The probe every relay-enforced launch runs, or null when there is none (the launch is then refused). */
export function boundaryProbe(): BoundaryProbe | null {
  if (standIn) return standIn;
  return PROBES_ENABLED ? prepareLaunch : null;
}
