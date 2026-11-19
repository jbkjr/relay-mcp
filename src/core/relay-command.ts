// A conservative recognizer, not a shell evaluator. False positives ask the person; aliases,
// script files and names constructed at runtime still depend on the host's permission system.
import path from "node:path";
import { canonical, RELAY_CLI } from "./config.js";

const NEVER_RUN_ARGUMENTS = new Set(["cat", "cd", "echo", "file", "grep", "head", "ls", "printf", "pwd", "stat", "tail", "wc"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z_0-9]*=/;
// An interpreter named in command position reads a program relay cannot see — from stdin when a
// pipe feeds it, or from an inline-code flag — so such a command position fails closed.
// sed/awk/xargs are left out: they can run commands too, but flagging every `… | sed -n …` or
// `… | xargs wc -l` is noise, and the structural terminal check is the real boundary.
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|fish|rc|python[0-9.]*|perl|ruby|node|deno|bun|osascript|tclsh|lua|php)$/;
// Per-interpreter inline-code flags. Shells (sh/bash/zsh/dash/ksh/fish/rc) are deliberately absent:
// their `-c <string>` argument is shell that the word recursion below already parses, and Codex runs
// every command as `/bin/zsh -lc '<cmd>'`, so flagging a shell `-c` would make every Codex command
// person-only. Each entry is single-dash letters that carry code and exact long flags.
const CODE_FLAGS: { match: (name: string) => boolean; letters: string; long?: string[] }[] = [
  { match: (n) => /^python[0-9.]*$/.test(n), letters: "c" },
  { match: (n) => n === "perl", letters: "eE" },
  { match: (n) => n === "ruby", letters: "e" },
  { match: (n) => n === "node", letters: "ep", long: ["--eval", "--print"] },
  { match: (n) => n === "osascript", letters: "e" },
  { match: (n) => n === "php", letters: "r" },
  { match: (n) => n === "lua", letters: "e" },
  { match: (n) => n === "bun", letters: "e", long: ["--eval"] },
];
/**
 * Whether words give the named interpreter code to run inline (so relay cannot see the program).
 * A single-dash word counts when one of the interpreter's code letters is in its leading letter
 * cluster, whatever follows (`-c`, `-ec`, and code attached to its flag such as `-cprint(1)` or
 * `-eprint 1`); a long flag counts as itself or with `=value` (`--eval=…`).
 */
function hasInlineCode(name: string, words: readonly string[]): boolean {
  if (name === "deno") return words.includes("eval"); // deno's `eval` subcommand
  const spec = CODE_FLAGS.find((s) => s.match(name));
  if (!spec) return false;
  return words.some((w) => {
    if (spec.long?.some((l) => w === l || w.startsWith(`${l}=`))) return true;
    const cluster = /^-([A-Za-z]+)/.exec(w)?.[1];
    return cluster !== undefined && [...spec.letters].some((l) => cluster.includes(l));
  });
}
// Commands that run another command they are given, after their own options: the real command name
// is the first word past them (and their option values). Resolved before the interpreter test so
// `… | env FOO=1 sh` and `… | nice -n 5 bash` are seen as sh and bash.
const WRAPPERS = new Set(["env", "command", "builtin", "exec", "nohup", "time", "timeout", "nice", "stdbuf", "setsid", "ionice", "caffeinate", "arch", "sudo"]);
// Option arity for the wrappers whose options take a value, so a value is not mistaken for the
// wrapped command (`env -u NAME sh` is sh, not NAME). An unrecognised option on one of these —
// including a `--name=value` / `-o=value` whose name is not one of its value options — fails closed
// rather than guess (defence in depth; the word recursion still catches an explicit relay).
const WRAPPER_ARITY: Record<string, { value: Set<string>; novalue: Set<string> }> = {
  env: { value: new Set(["-u", "-C", "-S", "-P", "--unset", "--chdir", "--split-string"]), novalue: new Set(["-i", "-0", "-v", "--ignore-environment", "--null", "--debug"]) },
  timeout: { value: new Set(["-s", "-k", "--signal", "--kill-after"]), novalue: new Set(["-v", "-f", "-p", "--verbose", "--foreground", "--preserve-status"]) },
  stdbuf: { value: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]), novalue: new Set() },
  nice: { value: new Set(["-n", "--adjustment"]), novalue: new Set() },
  sudo: { value: new Set(["-u", "-g", "-C", "-D", "-R", "-p", "-T", "-U"]), novalue: new Set(["-b", "-E", "-H", "-i", "-K", "-k", "-l", "-n", "-P", "-S", "-s", "-V", "-v", "-A", "-e", "-r"]) },
  exec: { value: new Set(["-a"]), novalue: new Set(["-c", "-l"]) },
};
// Glob metacharacters in command position: the name is a pattern the shell expands to whatever
// matches (a `rela?` could be `relay`), so relay cannot establish the command and fails closed.
const COMMAND_GLOB = /[*?[]/;

/**
 * The real command name a simple command runs: the first non-assignment word past any wrappers and
 * their options/values. `fail` means a wrapper option could not be classified, so command position
 * cannot be established and the caller fails closed. `name` is undefined when there is no command word.
 */
function commandName(words: readonly string[]): { name?: string; fail?: boolean } {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (ASSIGNMENT.test(w)) continue;
    const base = path.basename(w.replace(/^[+!|]+/, ""));
    if (WRAPPERS.has(base)) {
      const arity = WRAPPER_ARITY[base];
      // Consume this wrapper's options (and the values of value-taking ones) up to the wrapped command.
      while (i + 1 < words.length) {
        const opt = words[i + 1];
        if (ASSIGNMENT.test(opt)) { i++; continue; } // env VAR=val
        if (opt === "--") {
          // End of the wrapper's options: what follows is the command (after timeout's DURATION),
          // even a word that starts with "-".
          i++;
          const after = words[i + 1];
          if (after !== undefined && after.startsWith("-")) return { name: path.basename(after) };
          break;
        }
        if (!opt.startsWith("-") || opt === "-") break; // the wrapped command (or a positional like timeout's DURATION)
        if (!arity) { i++; continue; } // wrapper with no value-taking options: skip the flag
        if (opt.includes("=")) {
          // --name=value or -o=value, one token: only a known value option of this wrapper.
          if (arity.value.has(opt.slice(0, opt.indexOf("=")))) { i++; continue; }
          return { fail: true };
        }
        if (base === "nice" && /^-\d+$/.test(opt)) { i++; continue; } // legacy `nice -10 cmd`
        if (arity.value.has(opt)) { i += 2; continue; } // -u NAME
        if (!opt.startsWith("--") && opt.length > 2 && arity.value.has(opt.slice(0, 2))) { i++; continue; } // -uNAME attached
        if (arity.novalue.has(opt) || (!opt.startsWith("--") && opt.length > 2 && [...opt.slice(1)].every((c) => arity.novalue.has("-" + c)))) { i++; continue; } // -i / bundled -bES
        return { fail: true }; // unclassifiable option on a known wrapper: fail closed
      }
      continue;
    }
    if (w.startsWith("-") || /^\d+$/.test(w)) continue; // a wrapper's leftover option or numeric positional
    return { name: base };
  }
  return {};
}

/** One simple command: its words, and whether a pipe feeds it its standard input. */
interface SimpleCommand { words: string[]; piped: boolean }

/** Shell words, simple commands and substitutions. null means the syntax cannot be established. */
function splitShell(text: string): { commands: SimpleCommand[]; substitutions: string[] } | null {
  const commands: SimpleCommand[] = [], substitutions: string[] = [];
  let words: string[] = [], word = "", started = false, quote = "", piped = false;
  const endWord = () => { if (started) words.push(word); word = ""; started = false; };
  // `nextPiped` says whether the command that follows this separator reads a pipe (`|` or `|&`).
  const endCommand = (nextPiped = false) => { endWord(); if (words.length) commands.push({ words, piped }); words = []; piped = nextPiped; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") {
      if (++i >= text.length) return null;
      if (text[i] !== "\n") { word += text[i]; started = true; }
      continue;
    }
    if (quote === "'") { if (c === "'") quote = ""; else word += c; continue; }
    if (c === "`" || (c === "$" && text[i + 1] === "(")) {
      const backtick = c === "`";
      const start = i + (backtick ? 1 : 2);
      let depth = 1, innerQuote = "", j = start;
      for (; j < text.length; j++) {
        const t = text[j];
        if (t === "\\" && innerQuote !== "'") { j++; continue; }
        if (backtick && t === "`") break;
        if (innerQuote) { if (t === innerQuote) innerQuote = ""; continue; }
        if (t === "'" || t === '"' || t === "`") { innerQuote = t; continue; }
        if (!backtick && t === "(") depth++;
        if (!backtick && t === ")" && --depth === 0) break;
      }
      if (j === text.length) return null;
      substitutions.push(text.slice(start, j));
      i = j; started = true;
      continue;
    }
    if (quote === '"') { if (c === '"') quote = ""; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "#" && !started) { while (i < text.length && text[i] !== "\n") i++; endCommand(); continue; }
    if (c === "<" && text[i + 1] === "<") return null; // here-documents/strings: fail closed
    if (c === "|") {
      // `|` and `|&` pipe into the next command; `||` is logical OR, not a pipe.
      if (text[i + 1] === "|") { i++; endCommand(false); }
      else { if (text[i + 1] === "&") i++; endCommand(true); }
      continue;
    }
    if (c === "&") { if (text[i + 1] === "&") i++; endCommand(false); continue; } // `&&` and background `&`
    if (c === ";" || c === "(" || c === ")") { endCommand(false); continue; }
    if (c === "\n") {
      // A newline right after a pipe (possibly across blank space) continues the pipeline, so the
      // command after it still reads the pipe; otherwise it ends the command.
      if (piped && !started && !words.length) continue;
      endCommand(false);
      continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c; started = true;
  }
  if (quote) return null;
  endCommand();
  return { commands, substitutions };
}

/** Argument vectors are inspected as vectors, never joined and reparsed. */
export function runsRelayCommand(command: string | readonly string[], cwd = process.cwd(), depth = 0): boolean {
  if (depth > 16 || (typeof command === "string" && command.length > 100_000)) return true;
  const inspectWords = ({ words, piped }: SimpleCommand): boolean => {
    const first = words.find((w) => !ASSIGNMENT.test(w));
    // The command actually run, past any wrappers, for the interpreter tests.
    const { name, fail } = commandName(words);
    // Defence in depth (brief, 2026-10-27): a command position relay cannot pin down fails closed,
    // before the never-run exemption, so neither obfuscation gets through here.
    // - a wrapper option whose value could not be classified (so the command word is uncertain);
    if (fail) return true;
    // - a glob in the command name (literal first word or the resolved command);
    if ((first && COMMAND_GLOB.test(first)) || (name && COMMAND_GLOB.test(name))) return true;
    // - an interpreter fed by a pipe (reads its program from stdin), or given inline code we do not parse.
    if (name && INTERPRETER.test(name) && (piped || hasInlineCode(name, words))) return true;
    if (first && NEVER_RUN_ARGUMENTS.has(path.basename(first))) return false;
    return words.some((w) => {
      const value = /^(?:--[^=]+|[A-Za-z_][A-Za-z_0-9]*)=(.*)$/s.exec(w)?.[1];
      const candidate = (value ?? w).replace(/^[+!|]+/, "");
      if (path.basename(candidate) === "relay" || canonical(path.resolve(cwd, candidate)) === canonical(RELAY_CLI)) return true;
      return /[\s;&|()$`]/.test(candidate) && runsRelayCommand(candidate, cwd, depth + 1);
    });
  };
  if (typeof command !== "string") return inspectWords({ words: [...command], piped: false });
  const split = splitShell(command);
  return !split || split.substitutions.some((s) => runsRelayCommand(s, cwd, depth + 1)) || split.commands.some(inspectWords);
}

/**
 * Requests retain the target's command identity: ACP argv wins over its ambiguous summary, and a
 * Codex command whose summary also names the access it asks to add (codex-app.ts commandAsk) is
 * read from the command it gave alone.
 */
export function requestRunsRelayCommand(r: { kind: string; summary: string; detail_json: string | null }, cwd: string): boolean {
  if (r.kind !== "command") return false;
  let detail: Record<string, unknown>;
  try { detail = JSON.parse(r.detail_json ?? "{}"); } catch { return true; }
  if (!detail || typeof detail !== "object") return true;
  const command = Array.isArray(detail.argv) && detail.argv.length && detail.argv.every((v) => typeof v === "string") ? detail.argv as string[]
    : typeof detail.command === "string" ? detail.command : r.summary;
  return runsRelayCommand(command, typeof detail.cwd === "string" ? detail.cwd : cwd);
}
