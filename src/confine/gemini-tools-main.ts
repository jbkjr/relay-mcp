// The entry point a confined Gemini agent's tool discovery runs (backends/gemini.ts writeGeminiShim):
// `node --no-warnings gemini-tools-main.js <dir> (--list | <tool>)`. It imports gemini-tools.js and
// nothing else, which imports only node:fs, node:net and node:path, so a call loads nothing of
// relay's beyond it. Not cli.js, which is relay's every command: should any module it loads before
// dispatch reach node:sqlite, a Node before 24.15 prints an ExperimentalWarning to stderr on every
// run, and Gemini 0.64.0 takes any stderr for a failed call.
import { geminiTools } from "./gemini-tools.js";

process.exitCode = await geminiTools(process.argv[2], process.argv.slice(3));
