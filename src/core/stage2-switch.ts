/** Leaf shared by overlay admission and standing grants; no registry/backend imports. */
export const STAGE2_FLAG_ENV = "RELAY_EXPERIMENTAL_CODEX_STAGE2";
export function stage2Enabled(env: NodeJS.ProcessEnv = process.env, cfg?: { targets?: { codex?: { stage2?: boolean } } }): boolean {
  return env[STAGE2_FLAG_ENV] === "1" || cfg?.targets?.codex?.stage2 === true;
}
