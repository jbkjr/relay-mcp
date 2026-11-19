// Data only: safe to import before a fixture captures its synthetic root environment.
import { TARGETS } from "../dist/targets/index.js";

/** Host identity and endpoint intent belong to each fixture, never the developer's shell. */
export const hostVar = (k: string) => k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("CLAUDE_AGENT_SDK_")
  || k === "CODEX_INTERNAL_ORIGINATOR_OVERRIDE" || TARGETS.some((t) => t.endpointEnv.test(k))
  || /^ANTHROPIC_(MODEL|DEFAULT_(OPUS|SONNET|HAIKU)_MODEL)$/.test(k);
