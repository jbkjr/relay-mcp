// How relay runs one turn of each target's CLI, by target id. The registry (targets/) says what a
// target is; this says how it is driven, and is the one place that imports every backend.
//
// Each backend is loaded when its first turn starts, so that a worker loads only the backend of the
// target it runs (the ACP driver, the confinement stack and the other targets' modules stay out of
// a Codex worker). A backend that fails to load rejects start, as any refusal to launch does, and
// the turn fails with that error.
import type { Target } from "../targets/index.js";
import type { Backend } from "./types.js";

const lazy = (load: () => Promise<Backend>): Backend => ({ start: async (spec) => (await load()).start(spec) });

export const BACKENDS: Record<Target, Backend> = {
  claude: lazy(async () => (await import("./claude.js")).claudeBackend),
  codex: lazy(async () => (await import("./codex.js")).codexBackend),
  copilot: lazy(async () => (await import("./copilot.js")).copilotBackend),
  gemini: lazy(async () => (await import("./gemini.js")).geminiBackend),
  grok: lazy(async () => (await import("./grok.js")).grokBackend),
};
