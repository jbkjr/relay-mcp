// Relay runs every program outside a sandbox by an absolute path (review r_0c11d860 X1 follow-up):
// a bare name is looked up on PATH when it starts, and a program a job put in a directory earlier on
// PATH would run instead, unconfined. This lint covers src/, the launcher bin/relay and the scripts
// `npm run build` runs. It fails on a spawn whose program is not an absolute path literal,
// process.execPath, or resolved by src/core/executables.ts; on a call through a child_process
// namespace or an aliased import that it cannot check; on `shell: true`; and on a shell script relay
// runs (sh -c, in any spelling it can find) or the launcher with a command that starts with a bare
// name. The few that must stay dynamic are listed below, each with why.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers.ts";
import { executable, findExecutable, gitExecutable, notFound, spawnFound, systemTool } from "../dist/core/executables.js";
import { git } from "../dist/core/git.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const SPAWNERS = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"];
const CALL = new RegExp(`(?<![\\w.$])(${SPAWNERS.join("|")})\\(`, "g");
/** Resolved by executables.ts, or relay's own Node. */
const RESOLVED = /^(?:process\.execPath|(?:executable|findExecutable)\([\s\S]*\)|systemTool\("\/[^"]+"\))$/;

/** First arguments that stay expressions, by file: each is checked to hold an absolute path, or to be run confined. */
const ALLOWED: Record<string, Record<string, string>> = {
  "src/core/claude-settings.ts": { PLUTIL: "const PLUTIL = \"/usr/bin/plutil\"" },
  // gitExecutable(), checked non-null (and not the developer-tools stub) before each.
  "src/install/doctor.ts": { git: "gitExecutable()", "git!": "gitExecutable(), after the version check succeeded" },
  // gitExecutable(), checked non-null just before.
  "src/core/git.ts": { bin: "gitExecutable(), checked non-null just before" },
  // executables.ts itself: spawnFound runs a path as given (resolved) or what findExecutable found, just before, non-null.
  "src/core/executables.ts": { exe: "path.resolve(bin) or findExecutable(bin, searchPath), non-null" },
  // Claude's init probe: executable(bin, env.PATH), just before, so a missing CLI is reported as the probe's own diagnostic.
  "src/install/claude-init.ts": { exe: "executable(bin, env.PATH)" },
  // The probe's own commands, run through the wrapped launch (sandbox-exec, absolute) or set up by relay with absolute paths.
  "src/confine/canary.ts": { "s.command": "a canary step's command: the probe passes absolute paths only (probe.ts)" },
  "src/confine/probe.ts": { "run.command": "the confined launch's command: SANDBOX_EXEC, /usr/bin/sandbox-exec" },
  // Stage 2. The executor's confined launch (seatbeltLaunch: SANDBOX_EXEC, with the Codex binary
  // resolveBin found, absolute, which canonical() requires); the port snapshot's macOS tools; the
  // sandbox_check helper, only dist/native/relay-sbcheck in relay's own package, identity- and
  // sha256-checked before each run (sbcheck.ts helperProblem).
  "src/backends/codex-env.ts": { "launch.command": "a ConfinedLaunch's command: SANDBOX_EXEC" },
  "src/confine/ports.ts": { LSOF: "const LSOF = \"/usr/sbin/lsof\"", NETTOP: "const NETTOP = \"/usr/bin/nettop\"" },
  "src/confine/sbcheck.ts": { helper: "sandboxCheckHelper(), checked by helperProblem just before" },
  // The build: git found by findExecutable just before.
  "scripts/stamp-build.mjs": { gitBin: "findExecutable(\"git\"), checked non-null" },
};
const ABSOLUTE_CONSTANTS: Record<string, RegExp> = {
  "src/core/claude-settings.ts": /const PLUTIL = "\/[^"]+";/,
  "src/confine/ports.ts": /const LSOF = "\/usr\/sbin\/lsof";\nconst NETTOP = "\/usr\/bin\/nettop";/,
  "src/confine/seatbelt.ts": /export const SANDBOX_EXEC = "\/usr\/bin\/sandbox-exec";/,
};

/** Shell builtins and keywords a script may start a command with. */
const SHELL_WORDS = new Set(["exec", "kill", "trap", "shift", "while", "until", "if", "then", "else", "elif", "fi", "do", "done", "for", "case", "esac", "in", "true", "false", ":", "wait", "exit", "return", "set", "unset", "cd", "pwd", "echo", "printf", "test", "[", "command", "local", "export", "read", "break", "continue", "{", "}", "!"]);
/** Programs a shell script could name: the launcher must not run any of them by a bare name. */
const UTILITIES = ["readlink", "dirname", "basename", "realpath", "ls", "sort", "cat", "grep", "sed", "awk", "head", "tail", "tr", "cut", "uname", "mkdir", "rm", "cp", "mv", "ln", "find", "xargs", "env", "sleep", "tty", "ps", "id", "date", "wc", "tee", "chmod", "stat", "git", "node", "npm", "perl", "python3", "osascript", "pgrep", "sw_vers", "xcode-select", "sandbox-exec", "log", "launchctl"];

function files(dir: string, ext: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name), ext) : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []);
}

/** The scripts `npm run build` runs (package.json scripts.build). */
function buildScripts(): string[] {
  const build = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts.build as string;
  return [...build.matchAll(/node (scripts\/[\w.-]+\.m?js)/g)].map((m) => path.join(ROOT, m[1]));
}

/** The text of the call's first argument, up to the first comma or closing parenthesis at its own depth. */
function firstArg(src: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return src.slice(from, i).trim();
      depth--;
    } else if (c === "," && depth === 0) return src.slice(from, i).trim();
  }
  return src.slice(from).trim();
}

/** The commands of a shell script that start with a bare program name. */
function bareCommands(script: string): string[] {
  const bad: string[] = [];
  for (const segment of script.split(/;|&&|\|\||\||\n|\$\(|`|\bdo\b|\bthen\b|\belse\b/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    let w = words[0];
    if (w === "exec" || w === "!") w = words[1];
    if (!w || w.startsWith("/") || w.startsWith("\"") || w.startsWith("'") || w.startsWith("$") || w.startsWith("(") || w.startsWith(")") || SHELL_WORDS.has(w) || /^\d*[<>&]/.test(w) || /^[A-Za-z_]\w*\(\)$/.test(w) || w.startsWith("#")) continue;
    bad.push(w);
  }
  return bad;
}

/** The launcher's lines that run one of UTILITIES by a bare name, and its PATH lookups other than node's. */
function launcherProblems(text: string): string[] {
  const bad: string[] = [];
  const at = new RegExp(`(?:^|[;&|({]\\s*|\\$\\(\\s*|\\b(?:then|do|else|exec)\\s+)(${UTILITIES.map((u) => u.replace(/[-]/g, "\\-")).join("|")})\\b`, "g");
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/(^|\s)#.*$/, "").replace(/'[^']*'/g, "''");
    for (const m of code.trimStart().matchAll(at)) bad.push(`bin/relay:${i + 1}: runs ${m[1]} by a bare name`);
    for (const m of code.matchAll(/command -v ([\w.-]+)/g)) if (m[1] !== "node") bad.push(`bin/relay:${i + 1}: looks ${m[1]} up on PATH`);
  });
  return bad;
}

/** Every shell script handed to a shell with -c, in the spellings the lint can find, from a file's text. */
function shellScripts(src: string): { script: string | null; name: string }[] {
  const out: { script: string | null; name: string }[] = [];
  const lit = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
  for (const m of src.matchAll(new RegExp(String.raw`["'](?:[\w./-]*\/)?(?:sh|bash|zsh|dash|ksh)["']\s*,\s*\[?\s*["']-c["']\s*,\s*([A-Za-z_]\w*|${lit})`, "g"))) {
    let script: string | null = m[1];
    if (/^[A-Za-z_]/.test(script)) {
      const def = new RegExp(String.raw`const ${script} = (${lit})`).exec(src);
      script = def ? def[1] : null;
    }
    out.push({ script: script ? script.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, "\"") : null, name: m[1] });
  }
  // A whole command line in one string: "sh -c '…'", "/bin/bash -lc …".
  for (const m of src.matchAll(/["`](?:[\w./-]*\/)?(?:sh|bash|zsh)\s+-\w*c\s+([^"`]*)/g)) out.push({ script: m[1].trim().replace(/^'|'$/g, ""), name: m[0] });
  return out;
}

/** Problems in one file's text: `used` collects the ALLOWED entries it relied on. */
function lintFile(rel: string, src: string, used: Set<string>, counted: { calls: number }): string[] {
  const problems: string[] = [];
  const check = (fn: string, at: number) => {
    const arg = firstArg(src, at);
    const line = src.slice(0, at).split("\n").length;
    counted.calls++;
    if (/^["'`]/.test(arg)) {
      if (!/^["'`]\//.test(arg)) problems.push(`${rel}:${line}: ${fn}(${arg}) runs a bare name`);
      return;
    }
    if (RESOLVED.test(arg)) return;
    if (ALLOWED[rel]?.[arg]) return void used.add(`${rel} ${arg}`);
    problems.push(`${rel}:${line}: ${fn}(${arg}): not an absolute path, process.execPath or executables.ts; resolve it or list it in ALLOWED with why`);
  };
  for (const m of src.matchAll(CALL)) check(m[1], m.index! + m[0].length);
  // Calls through a namespace or default import of child_process (cp.spawn(…), child_process.exec(…)).
  const spaces = [...src.matchAll(/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+["'](?:node:)?child_process["']|(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+import|require)\(["'](?:node:)?child_process["']\)/g)].map((m) => m[1] ?? m[2]);
  for (const ns of spaces) for (const m of src.matchAll(new RegExp(`\\b${ns}\\.(${SPAWNERS.join("|")})\\(`, "g"))) check(`${ns}.${m[1]}`, m.index! + m[0].length);
  // A spawner imported under another name would escape the call pattern: refused outright.
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g)) {
    for (const spec of m[1].split(",")) if (/\bas\b/.test(spec) && SPAWNERS.includes(spec.trim().split(/\s+/)[0])) problems.push(`${rel}: imports ${spec.trim()} from child_process: call it by its own name, so the lint can check it`);
  }
  if (/[{,]\s*shell\s*:\s*(?!false\b)[^,}\s]/.test(src)) problems.push(`${rel}: passes a shell option to a spawn: a shell looks every command up on PATH`);
  for (const { script, name } of shellScripts(src)) {
    if (script === null) { problems.push(`${rel}: the shell script ${name} is not a literal constant in the file, so it cannot be checked`); continue; }
    const bad = bareCommands(script);
    if (bad.length) problems.push(`${rel}: a shell script runs ${bad.join(", ")} by a bare name`);
  }
  return problems;
}

test("lint: relay runs no program by a bare name: every spawn's program is an absolute path or resolved by executables.ts, and no shell script it runs, nor its launcher, starts a command with a bare name (review r_0c11d860 X1)", () => {
  const problems: string[] = [];
  const used = new Set<string>();
  const counted = { calls: 0 };
  for (const file of [...files(SRC, ".ts"), ...buildScripts()]) {
    const rel = path.relative(ROOT, file);
    problems.push(...lintFile(rel, fs.readFileSync(file, "utf8"), used, counted));
  }
  problems.push(...launcherProblems(fs.readFileSync(path.join(ROOT, "bin", "relay"), "utf8")));
  for (const [rel, entries] of Object.entries(ALLOWED)) for (const arg of Object.keys(entries)) {
    if (!used.has(`${rel} ${arg}`)) problems.push(`ALLOWED lists ${rel} ${arg}, which no longer occurs: remove it`);
  }
  for (const [rel, re] of Object.entries(ABSOLUTE_CONSTANTS)) {
    if (!re.test(fs.readFileSync(path.join(ROOT, rel), "utf8"))) problems.push(`${rel}: the constant ALLOWED relies on is no longer an absolute path`);
  }
  assert.ok(counted.calls > 20, `the lint found only ${counted.calls} calls: is its pattern still right?`);
  assert.deepEqual(problems, []);
});

test("lint: its checks catch a bare command, a namespace call, an aliased import, a shell option and the launcher's utilities, and let builtins and absolute paths through", () => {
  assert.deepEqual(bareCommands("P=$1; shift; \"$@\" & L=$!; while kill -0 \"$P\" 2>/dev/null; do /bin/sleep 1; done; kill $L"), []);
  assert.deepEqual(bareCommands("/usr/bin/tty; exec /bin/sleep 60"), []);
  assert.deepEqual(bareCommands("tty; exec sleep 60"), ["tty", "sleep"]);
  assert.deepEqual(bareCommands("while true; do sleep 1; done"), ["sleep"]);
  assert.ok(bareCommands("x=$(whoami)").some((w) => w.startsWith("whoami")));
  assert.deepEqual(shellScripts(`spawn("bash", ["-c", "tty"])`).map((s) => s.script), ["tty"]);
  assert.deepEqual(shellScripts(`spawn("/bin/sh", ["-c", 'sleep 1'])`).map((s) => s.script), ["sleep 1"]);
  assert.deepEqual(shellScripts(`execSync("sh -c 'git status'")`).map((s) => bareCommands(s.script!)).flat(), ["git"]);
  assert.deepEqual(launcherProblems(`link=$(readlink "$self")\nfor v in $(ls "$d" | sort); do :; done\nn=$(command -v node)\n`), ["bin/relay:1: runs readlink by a bare name", "bin/relay:2: runs ls by a bare name", "bin/relay:2: runs sort by a bare name"]);
  assert.deepEqual(launcherProblems(`link=$(/usr/bin/readlink "$self")\n# readlink in a comment\n`), []);
  const lint = (src: string) => lintFile("x.ts", src, new Set(), { calls: 0 });
  assert.equal(lint(`import * as cp from "node:child_process";\ncp.spawn("git", []);\n`).length, 1, "a namespace call");
  assert.equal(lint(`import cp from "child_process";\ncp.execSync(cmd);\n`).length, 1, "a default import's call");
  assert.equal(lint(`import { spawn as run } from "node:child_process";\n`).length, 1, "an aliased import");
  assert.equal(lint(`spawn("/bin/ls", [], { shell: true });\n`).length, 1, "a shell option");
  assert.deepEqual(lint(`spawn("/bin/ls", [], { shell: false });\nconst s = "from its shell: every";\n`), []);
});

test("executables: a bare name is found on the PATH given, by its absolute name there (a link's own name, on purpose), relative entries skipped; a missing one is an error, never a lookup at start", () => {
  const sh = findExecutable("sh", "/usr/bin:/bin");
  assert.equal(sh, fs.existsSync("/usr/bin/sh") ? "/usr/bin/sh" : "/bin/sh");
  assert.equal(findExecutable("sh", "relative:/bin"), "/bin/sh", "relative PATH entries are skipped");
  assert.equal(findExecutable("/bin/sh"), "/bin/sh");
  assert.equal(findExecutable("no-such-program-relay", "/usr/bin:/bin"), null);
  assert.throws(() => executable("no-such-program-relay", "/usr/bin:/bin"), new RegExp(notFound("no-such-program-relay").replace(/[`]/g, ".")));
  const r = spawnFound("no-such-program-relay", [], { encoding: "utf8" }, "/usr/bin:/bin");
  assert.equal((r.error as NodeJS.ErrnoException).code, "ENOENT");
  assert.equal(r.error!.message, notFound("no-such-program-relay"));
  // A path is spawned as given: nothing is looked up, and a missing one fails with the spawn's own error.
  assert.equal(executable("/nonexistent/relay-missing", "/usr/bin:/bin"), "/nonexistent/relay-missing");
  assert.equal((spawnFound("/nonexistent/relay-missing", [], { encoding: "utf8" }).error as NodeJS.ErrnoException).code, "ENOENT");
  assert.equal(((() => { try { executable("no-such-program-relay", "/usr/bin:/bin"); } catch (err) { return err; } })() as NodeJS.ErrnoException).code, "ENOENT");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-link-name-"));
  try {
    fs.symlinkSync("/bin/sh", path.join(dir, "linked"));
    assert.equal(findExecutable("linked", dir), path.join(dir, "linked"), "the link's own name, not where it leads");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("executables: a test's stand-in for a macOS tool is taken only inside relay's own test suite, from this user's directory under the temp directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tools-"));
  const saved = { tools: process.env.RELAY_TEST_SYSTEM_TOOLS, ctx: process.env.NODE_TEST_CONTEXT };
  try {
    fs.writeFileSync(path.join(dir, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.RELAY_TEST_SYSTEM_TOOLS = dir;
    assert.equal(systemTool("/usr/bin/pgrep"), path.join(fs.realpathSync(dir), "pgrep"), "inside the test suite");
    delete process.env.NODE_TEST_CONTEXT;
    assert.equal(systemTool("/usr/bin/pgrep"), "/usr/bin/pgrep", "outside it, the fixed path");
    process.env.NODE_TEST_CONTEXT = saved.ctx ?? "child-v8";
    process.env.RELAY_TEST_SYSTEM_TOOLS = "/usr/local/bin";
    assert.equal(systemTool("/usr/bin/pgrep"), "/usr/bin/pgrep", "never a directory outside the temp directory");
  } finally {
    if (saved.tools === undefined) delete process.env.RELAY_TEST_SYSTEM_TOOLS; else process.env.RELAY_TEST_SYSTEM_TOOLS = saved.tools;
    if (saved.ctx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = saved.ctx;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("executables: relay's git is the one found when the process first ran git; a git put earlier on PATH afterwards is never run", { skip: !findExecutable("git") && "no git on PATH" }, () => {
  const first = gitExecutable();
  assert.ok(first && path.isAbsolute(first));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-planted-git-"));
  const marker = path.join(dir, "ran");
  fs.writeFileSync(path.join(dir, "git"), `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try {
    assert.equal(gitExecutable(), first);
    const r = git(dir, ["--version"]);
    assert.ok(r.ok, r.err);
    assert.match(r.out, /^git version/);
    assert.equal(fs.existsSync(marker), false, "the planted git never ran");
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
