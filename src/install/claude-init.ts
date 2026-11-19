// Doctor's local /skills probe: the same isolated skill/plugin settings as a turn, no model
// prompt, no MCP servers, hooks or tools. /skills is the local command used by
// scripts/probe-skill-isolation.mjs. Stop at init, then verify the process ended without a result.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { claudeSkillIsolation, claudeSkillsProblem } from "../backends/claude.js";
import { claudeTempPath } from "../backends/native-temp.js";
import { installedVersion } from "../backends/cli-version.js";
import { ensurePrivateRoot, nativeTempRoot } from "../confine/private-root.js";
import { privateTurnTemp } from "../confine/turn.js";
import { drainGroup, groupAlive, isGroupSignalRefusal, pidAlive, sendGroupSignal } from "../core/procs.js";
import { executable } from "../core/executables.js";

/**
 * A probe failure is diagnostic only; it never makes doctor crash or changes launch policy. Claude
 * gets a private temporary directory the way a turn does (native-temp.ts): one in ~/.rn, named
 * through relay's short link on a long home, so that Claude does not fall back to shared /tmp
 * during the probe either. The probe never makes the link: without it, it is not run and says so.
 * `versionProblem` is the turn's check on Claude's version for that link.
 */
export async function claudeInitProblem(bin: string, selected: NodeJS.ProcessEnv, versionProblem: () => string | null): Promise<string | null> {
  let dir: string | undefined;
  try {
    dir = privateTurnTemp(ensurePrivateRoot(nativeTempRoot()), "");
    let tmp: string;
    try { tmp = claudeTempPath(dir, versionProblem, { create: false }); }
    catch (err) { return `Claude's init-only probe was not run: ${(err as Error).message}`; }
    const env = { ...selected, TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1", CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1" };
    delete (env as NodeJS.ProcessEnv).CLAUDECODE;
    const settings = path.join(dir, "settings.json");
    // The same plugin settings a turn on this version gets: cc-plugin-privacy left on where relay keeps it.
    fs.writeFileSync(settings, JSON.stringify({ ...claudeSkillIsolation(dir, env, installedVersion("claude", bin, selected)), disableAllHooks: true,
      fastMode: false, env: { TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" } }));
    let exe: string;
    try { exe = executable(bin, (env as NodeJS.ProcessEnv).PATH); }
    catch (err) { return `Claude's init-only probe could not start (${(err as NodeJS.ErrnoException).code ?? "error"})`; }
    const child = spawn(exe, ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
      "--setting-sources", "", "--settings", settings, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--tools", "", "--permission-mode", "dontAsk", "--permission-prompts", "none", "/skills"],
    { cwd: dir, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let init: Record<string, unknown> | undefined, result = false, assistant = false, problem: string | undefined;
    let stoppedAtInit = false, bytes = 0;
    const stop = () => {
      if (!child.pid) return;
      try { sendGroupSignal(child.pid, "SIGKILL"); } catch (err) { if (!isGroupSignalRefusal(err)) child.kill("SIGKILL"); }
    };
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.length > 1024 * 1024) { problem = "Claude's init report exceeded the probe limit"; stop(); return; }
      // Nothing after init is read. The prompt is the local /skills command, with no tools and no
      // MCP servers, so its own reply can already be queued behind init when the stop lands; that
      // is no model work. A result or assistant event before init is what this check is for.
      if (stoppedAtInit) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.type === "result") { result = true; stop(); }
      if (event?.type === "assistant") { assistant = true; stop(); }
      if (!init && event?.type === "system" && event.subtype === "init") {
        init = event;
        stoppedAtInit = true;
        stop();
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { problem = "Claude's init stream exceeded the probe limit"; stop(); }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end();
    const timer = setTimeout(() => { problem = "Claude's init-only probe timed out"; stop(); }, 10_000);
    try {
      await new Promise<void>((resolve) => {
        child.once("error", (err: NodeJS.ErrnoException) => { problem = `Claude's init-only probe could not start (${err.code ?? "error"})`; });
        child.once("close", () => resolve());
      });
    } finally {
      clearTimeout(timer);
      lines.close();
      if (child.pid) await drainGroup(child.pid);
    }
    const stopProblem = child.pid && (pidAlive(child.pid) || groupAlive(child.pid)) ? "Claude's init-only probe did not stop completely"
      : result || assistant ? "Claude's init-only probe emitted a result or assistant event; relay could not verify a stop before model work"
      : problem ?? (!init || !stoppedAtInit ? "Claude's init-only probe exited without an init report" : null);
    // Even a failed stop must name an unfamiliar built-in if the init report exposed it.
    return [init ? claudeSkillsProblem(init, undefined) : null, stopProblem].filter(Boolean).join(". ") || null;
  } catch (err) {
    return `Claude's init-only probe failed (${(err as NodeJS.ErrnoException).code ?? "could not prepare or read init"})`;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}
