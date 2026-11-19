#!/usr/bin/env node
// Dry run by default. Writes a LaunchAgent only with --install; never loads/bootstraps it.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { atomicJson } from "./codex-pin-store.mjs";
import { validateConfig } from "./codex-qualifier.mjs";
import { isMain } from "./main-module.mjs";

const xml = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

/**
 * A launchd label: dot-separated words of letters, digits and hyphens, at least two of them. It
 * names the plist file too, so it can hold no slash, no `..` and nothing to escape.
 */
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** The default label, from this user's login name: local.<user>.relay-codex-qualifier. */
export function defaultLabel(user = os.userInfo().username) {
  const word = String(user).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "user";
  return `local.${word}.relay-codex-qualifier`;
}

export function validLabel(label) {
  if (typeof label !== "string" || label.length > 200 || !LABEL.test(label)) throw new Error("--label must be a launchd label: dot-separated words of letters, digits and hyphens, such as local.you.relay-codex-qualifier");
  return label;
}

export function renderPlist({ node, runner, config, repo, logs, label = defaultLabel() }, template = fs.readFileSync(path.join(import.meta.dirname, "relay-codex-qualifier.plist"), "utf8")) {
  template = template.replaceAll("__LABEL__", validLabel(label));
  const values = { NODE_ABSOLUTE_PATH: node, RUNNER_ABSOLUTE_PATH: runner, CONFIG_ABSOLUTE_PATH: config, REPO_ABSOLUTE_PATH: repo, LOG_DIRECTORY: logs, NODE_BIN_DIRECTORY: path.dirname(node) };
  for (const [name, value] of Object.entries(values)) {
    if (!path.isAbsolute(value ?? "") || /[\0\r\n]/.test(value)) throw new Error(`${name} must be an absolute single-line path`);
    if (name === "NODE_ABSOLUTE_PATH" && value.includes("fnm_multishells")) throw new Error("Node must use a stable installation path");
    template = template.replaceAll(`__${name}__`, xml(value));
  }
  if (/__[A-Z_]+__/.test(template)) throw new Error("unresolved plist placeholder");
  return template;
}

/**
 * Whether `text` is a qualifier LaunchAgent: its program runs a relay checkout's codex-qualifier.mjs
 * (scripts/codex-qualify, or scripts/release-watch before the move) with a config and --run.
 */
export function isQualifierAgent(text) {
  return /<string>[^<]*\/scripts\/(?:codex-qualify|release-watch)\/codex-qualifier\.mjs<\/string>\s*<string>[^<]*<\/string>\s*<string>--run<\/string>/.test(String(text));
}

export function installQualifier({ config, node = process.execPath, home = os.homedir(), logs, label = defaultLabel(), install = false }) {
  validLabel(label);
  if (!path.isAbsolute(config ?? "")) throw new Error("--config must be absolute");
  const cfg = validateConfig(JSON.parse(fs.readFileSync(config, "utf8")));
  if (!path.isAbsolute(node)) throw new Error("--node must be absolute");
  // Resolve a transient fnm shell link to the installed Node version. Homebrew's Cellar is stable
  // too, but after removing an old Node version, rerun this installer.
  node = fs.realpathSync(node);
  fs.accessSync(node, fs.constants.X_OK);
  const runner = path.join(cfg.repo, "scripts/codex-qualify/codex-qualifier.mjs");
  fs.accessSync(runner, fs.constants.R_OK);
  logs ??= path.join(home, "Library/Logs/relay-codex-qualifier");
  const content = renderPlist({ node, runner, config, repo: cfg.repo, logs, label });
  const plist = path.join(home, "Library/LaunchAgents", `${label}.plist`);
  // A label is the person's to choose, so it can name another agent's file: replace only a qualifier agent.
  let existing = null;
  try { existing = fs.lstatSync(plist); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (existing && (!existing.isFile() || !isQualifierAgent(fs.readFileSync(plist, "utf8")))) {
    throw new Error(`${plist} exists and is not a relay Codex qualifier agent; the installer will not replace it. Choose another --label.`);
  }
  if (install) {
    process.umask(0o077);
    for (const dir of [cfg.store, logs, path.dirname(plist)]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Rewrite only to persist validated defaults; this file must never contain credentials.
    atomicJson(config, cfg);
    const temp = `${plist}.${process.pid}.tmp`;
    try { fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 }); fs.renameSync(temp, plist); }
    finally { fs.rmSync(temp, { force: true }); }
  }
  return { plist, content, installed: install, node, label };
}

if (isMain(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--install") options.install = true;
      else if (["--config", "--node", "--logs", "--label"].includes(flag) && args[i + 1] && !args[i + 1].startsWith("--")) options[flag.slice(2)] = args[++i];
      else throw new Error("Usage: node install-codex-qualifier.mjs --config /absolute/qualifier.json [--node /stable/node] [--logs /absolute/logs] [--label local.you.relay-codex-qualifier] [--install]");
    }
    const result = installQualifier(options);
    console.log(result.content);
    console.log(`${result.installed ? "Installed" : "Dry run; would install"}: ${result.plist}`);
    const domain = `gui/${process.getuid?.() ?? "$(id -u)"}`;
    console.log(`Node: ${result.node}\nNot loaded. After reviewing the configuration, load it in your login session with:\n  launchctl bootstrap ${domain} ${JSON.stringify(result.plist)}\nand stop it with:\n  launchctl bootout ${domain}/${result.label}`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
