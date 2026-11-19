// What relay knows about each host it installs into: a program whose sessions call relay. Each
// host belongs to one target's family, which the installer writes as --host; the desktop app is
// a host of the claude family. The entries are in claude.ts, codex.ts and claude-desktop.ts.
import type { RelayConfig } from "../core/config.js";
import type { Plan, Run } from "../install/common.js";
import type { Target } from "../targets/index.js";

/** Every host relay installs into, in the order install, doctor and the usage text list them. */
export const HOST_IDS = ["claude", "codex", "claude-desktop"] as const;
export type HostId = (typeof HOST_IDS)[number];

/** Doctor's report, for a host to add its lines to. */
export interface DoctorReport {
  line(label: string, text: string): void;
  warn(label: string, text: string): void;
  fail(label: string, text: string): void;
  /** One line on whether a registration runs this checkout's launcher, in the current form. `name`: the server's name there (default relay). */
  registration(label: string, host: HostId, command: unknown, args: unknown, extra?: string, name?: string): void;
}

/**
 * One skill's text, shared by every host's adapter. A reference skill is text the agent loads
 * itself when it needs it (a prompting brief), not a command the user runs with arguments.
 */
export interface SkillText { description: string; hint: string; body: string; reference?: boolean }

/** The reference skill carrying the brief on writing tasks for a target: write-for-codex. */
export const briefSkill = (target: Target): string => `write-for-${target}`;

/** What adapters/generate.mjs hands a host's adapter writer. */
export interface AdapterContext {
  /** adapters/<dir>, to write into. */
  out: string;
  /** relay's version: the plugin carries it, and install refreshes a stale one. */
  version: string;
  /** The plugin's description. */
  description: string;
  skills: Record<string, SkillText>;
  write(file: string, text: string): void;
}

export interface HostDef {
  id: HostId;
  /** The family of the sessions this host runs, written into its registration as --host. */
  target: Target;
  /** As the user knows it: "Claude Code", "the Claude desktop app". */
  name: string;
  /** What install or uninstall would do here, gathered before anything is changed. */
  plan(run: Run): Plan;
  /** Whether relay is registered here, as far as can be told without changing anything. */
  registered(): "registered" | "none" | "unknown";
  /** Said after install or uninstall changed something here. */
  afterChange?: string;
  /**
   * Doctor: how the host's CLI is signed in. Called only when that CLI runs. `account`: how the
   * app server of doctor's codex launch check said relay's Codex home is signed in (account/read's
   * account type, null for none), when it ran and said.
   */
  doctorLogin?(cfg: RelayConfig, report: DoctorReport, launch?: { account?: string | null }): void;
  /** The plugin relay ships for this host, generated into adapters/<dir> by adapters/build.mjs (adapters/generate.mjs). */
  adapter?: {
    dir: string;
    /** How an agent in this host names one of the plugin's skills: relay:delegate, $relay-delegate. */
    ref(skill: string): string;
    write(ctx: AdapterContext): void;
  };
  /** Doctor: relay's registration here. present says which targets' CLIs run. */
  doctorRegistration(cfg: RelayConfig, present: Partial<Record<Target, boolean>>, report: DoctorReport): void;
}
