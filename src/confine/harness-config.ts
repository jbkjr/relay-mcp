/**
 * Configuration a harness or a developer tool reads from a project's root: an agent that could plant
 * one of these in a writable root could change how a later turn's harness, or the person's own
 * tools, behave. The profile denies writing, creating or removing any of them at the top of each
 * writable root (the worktree and granted directories), whether it is there already or not. Reads
 * are untouched: a project's own config is still readable. `.git` is handled separately, and stays
 * denied entirely. (Codex protocol/src/permissions.rs, srt sandbox-utils.ts: the reasoning is
 * theirs, these names relay's.) `.gemini` is Gemini CLI's: in a trusted folder it loads
 * `.gemini/settings.json` from its working directory and `.gemini/.env` from there or the nearest
 * directory above that has one (0.64.0 `_doLoadSettings`, `findEnvFile`). Relay's own Gemini turns
 * run untrusted and load neither; the person's own Gemini would.
 */
export const HARNESS_CONFIG = [
  ".codex", ".agents", ".claude", ".gemini", ".mcp.json", ".aws", ".envrc", ".vscode", ".idea", ".gitconfig", ".gitmodules",
  ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin",
];
