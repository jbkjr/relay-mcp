import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonical, configPath, consultHome, DEFAULT_CONFIG, expandHome, harnessHome, relayCodexHome, relayCodexPinStore, relayHome, worktreesHome, type RelayConfig,
} from "./core/config.js";
import { installBackupsPath, installRecordPath, localConfigPath, mcpFile } from "./core/protected-config.js";
import { defaultKeyDir } from "./core/api-keys.js";
import { nativeTempAlias, nativeTempRoot, privateStateRoot } from "./confine/private-root.js";
import { db, registryBackup, registryVersion, SCHEMA_VERSION } from "./core/db.js";
import { codexHomeProblem, codexHomeStatus, codexLoginCommand, prepareCodexHome, shippedPinPackageRoot } from "./backends/codex-pin.js";
import { readShippedPin } from "./core/shipped-pin.js";
import { desktopEntryUnderOldName } from "./hosts/claude-desktop.js";
import { DESKTOP_ENTRY, DESKTOP_OLD_ENTRY } from "./hosts/desktop-shared.js";
import { hostDef, HOST_IDS, HOSTS, isHost, type HostId } from "./hosts/index.js";
import {
  config, installKind, isRelayLauncher, LAUNCHER, linkPath, loadRecord, note, onPath, recordFile, reinstallCommand, requireRecord, saveRecord, say, sh, Stop, unusedName, usageError, errText, type Plan, type Run,
} from "./install/common.js";

// install and uninstall (doctor is in install/doctor.ts). What they share is in install/common.ts,
// and each host's own part (its registration, its plugin kit, its doctor lines) in src/hosts/.

export { usageError };

type Link = { state: "absent" | "identical" } | { state: "own"; target: string } | { state: "foreign"; note: string };

/**
 * ~/.local/bin/relay is relay's if it is a symlink to the launcher of a relay checkout, or to the
 * target relay's own record says it linked. A target that merely ends in bin/relay is not enough:
 * uv and pipx link a tool of that name the same way. A file there is someone's program and is
 * never deleted.
 */
function linkState(run: Run): Link {
  const link = linkPath();
  let st: fs.Stats | undefined;
  let target = "";
  try {
    st = fs.lstatSync(link, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) target = fs.readlinkSync(link);
  } catch (err) {
    throw new Stop(`${link} cannot be examined (${errText(err)}).`);
  }
  if (!st) return { state: "absent" };
  if (!st.isSymbolicLink()) return { state: "foreign", note: st.isDirectory() ? "a directory" : "a file, not a symbolic link" };
  if (target === LAUNCHER) return { state: "identical" };
  const own = target === run.record.link?.target || isRelayLauncher(path.resolve(path.dirname(link), target));
  return own ? { state: "own", target } : { state: "foreign", note: `a symbolic link to ${target}` };
}

/** Puts `relay` on PATH by linking ~/.local/bin/relay to the launcher. */
function planLink(run: Run): Plan {
  const link = linkPath();
  const st = linkState(run);
  const problems = st.state === "foreign" && !run.force
    ? [`${link} exists and is not relay's link (it is ${st.note}), so relay will not replace it. Move it away, or run this again with --force (it is renamed, never deleted), or with --no-link to install without putting \`relay\` on PATH.`]
    : [];
  return {
    problems,
    apply() {
      // The host's own commands have run since the link was looked at. It is looked at again.
      const now = linkState(run);
      if (now.state !== st.state || (now.state === "own" && st.state === "own" && now.target !== st.target)) {
        throw new Stop(`${link} changed while relay was working, so it was left as it is. Run this again.`);
      }
      if (st.state === "identical") return void note(run, "link", { action: "kept", what: `${link} already pointed at ${LAUNCHER}`, backup: null, undo: `rm ${sh([link])}` });
      let backup: string | null = null;
      if (st.state === "foreign") {
        for (let n = 0; fs.lstatSync((backup = unusedName(`${link}.bak-relay`, n)), { throwIfNoEntry: false }); n++);
        say(`$ mv ${sh([link, backup])}`);
      }
      say(`$ ln -s${st.state === "own" ? "fn" : ""} ${sh([LAUNCHER, link])}`);
      if (run.write) {
        const tmp = `${link}.relay-${process.pid}.tmp`;
        let moved = false;
        try {
          fs.mkdirSync(path.dirname(link), { recursive: true });
          if (backup) {
            fs.renameSync(link, backup);
            moved = true;
          }
          if (st.state === "own") {
            // Relay's own link is replaced in one step.
            fs.rmSync(tmp, { force: true });
            fs.symlinkSync(LAUNCHER, tmp);
            fs.renameSync(tmp, link);
          } else {
            // Nothing should be there now. Made directly, the link fails instead of replacing anything that is.
            fs.symlinkSync(LAUNCHER, link);
          }
        } catch (err) {
          fs.rmSync(tmp, { force: true });
          let where = "it is as it was";
          if (moved && backup) {
            // Put back only into an empty place: whatever appeared there meanwhile is not relay's to replace.
            try {
              if (fs.lstatSync(link, { throwIfNoEntry: false })) throw new Error("occupied");
              fs.renameSync(backup, link);
            } catch {
              where = `what was there is now at ${backup}`;
            }
          }
          throw new Stop(`${link} could not be linked to ${LAUNCHER} (${errText(err)}); ${where}.`);
        }
      }
      note(run, "link", {
        action: st.state === "absent" ? "added" : "replaced",
        what: `linked ${link} to ${LAUNCHER}${st.state === "own" ? ` (it pointed at ${st.target})` : backup ? ` (what was there is now ${backup})` : ""}`,
        backup,
        undo: st.state === "own" ? `ln -sfn ${sh([st.target, link])}` : backup ? `rm ${sh([link])} && mv ${sh([backup, link])}` : `rm ${sh([link])}`,
      });
    },
  };
}

/** Whether relay is still registered with the other hosts, as far as can be told without changing anything. */
function registeredElsewhere(except: HostId): { host: HostId; state: "registered" | "none" | "unknown" }[] {
  return HOSTS.filter((h) => h.id !== except).map((h) => ({ host: h.id, state: h.registered() }));
}

/** Removes ~/.local/bin/relay when it is relay's link and either the user asked or no host uses relay any more. */
function planUnlink(run: Run, asked: boolean): Plan {
  return {
    problems: [],
    apply() {
      const link = linkPath();
      const st = linkState(run);
      if (st.state === "absent") return;
      if (st.state === "foreign") return void say(`# left alone: ${link} is not relay's link (it is ${st.note})`);
      if (!asked) {
        const rest = registeredElsewhere(run.host);
        const names = (state: string) => rest.filter((r) => r.state === state).map((r) => hostDef(r.host).name).join(" and ");
        const why = names("registered") ? `relay is still registered with ${names("registered")}` : names("unknown") ? `relay could not tell whether it is still registered with ${names("unknown")}` : "";
        if (why) return void say(`# kept ${link}: ${why}. To remove it as well, add --remove-link, or: rm ${sh([link])}`);
      }
      say(`$ rm ${sh([link])}`);
      if (run.write) {
        try {
          fs.unlinkSync(link);
        } catch (err) {
          throw new Stop(`${link} could not be removed (${errText(err)}).`);
        }
      }
      note(run, "link", { action: "removed", what: `removed the link ${link}`, backup: null, undo: `ln -s ${sh([st.state === "own" ? st.target : LAUNCHER, link])}` });
    },
  };
}

// The commands

function hostArgs(verb: "install" | "uninstall", args: string[], flags: string[]): { host: HostId; has: (flag: string) => boolean } | null {
  const hosts = args.filter((a) => !a.startsWith("-"));
  const unknown = args.filter((a) => a.startsWith("-") && !flags.includes(a));
  if (unknown.length || hosts.length !== 1 || !isHost(hosts[0])) {
    usageError(`${unknown.length ? `relay ${verb}: unknown option ${unknown.join(" ")}\n` : ""}usage: relay ${verb} <${HOST_IDS.join("|")}> ${flags.map((f) => `[${f}]`).join(" ")}`);
    return null;
  }
  return { host: hosts[0], has: (flag) => args.includes(flag) };
}

const planHost = (run: Run) => hostDef(run.host).plan(run);

/**
 * Says why a run stopped, and what it had changed by then. Relay does not roll a half-finished
 * run back by itself: undoing through the same CLI that just failed could make things worse.
 * It gives the exact command that reverses each change it made, and keeps them in the record.
 */
function stopped(run: Run, err: unknown): void {
  // An error relay did not foresee still gets the account of what was changed before it.
  console.error(`\nrelay ${run.verb} ${run.host}: ${err instanceof Stop ? err.message : `unexpected error: ${err instanceof Error ? err.stack : String(err)}`}`);
  if (!run.write) console.error("\nNothing was changed (this was a dry run, and with --write it would have stopped here too).");
  else if (!run.made.length) console.error("\nNothing was changed.");
  else {
    console.error("\nBefore that, this run had already:");
    run.made.forEach((c, i) => {
      console.error(`  ${i + 1}. ${c.what}`);
      if (c.backup) console.error(`     what was there before is saved at ${c.backup} (to consult; do not copy it back over a file that has changed since)`);
      if (c.undo) console.error(`     to undo: ${c.undo}`);
    });
    console.error(`\nRelay has not undone these. Either fix the problem and run the same command again (steps already done are skipped), or undo them with the commands above${run.verb === "install" ? `, or remove the host registration with: ${reinstallCommand("uninstall", run.host)} (this does not undo a registry migration)` : ""}.`);
    console.error(run.recorded ? `The same list is kept in ${recordFile()}.` : `Keep this list: relay's installation record (${recordFile()}) does not have all of it.`);
  }
  process.exitCode = 1;
}

/**
 * A registry left by an earlier relay is backed up next to itself and then migrated, before any
 * host is changed, so that going back to that relay is a matter of restoring the backup
 * (docs/UPGRADING.md). Opening it does both (db()); a dry run only says so. One written by a newer
 * relay stops the install.
 */
function upgradeRegistry(run: Run): void {
  let found: ReturnType<typeof registryVersion>;
  try {
    found = registryVersion();
  } catch (err) {
    throw new Stop(`relay's registry in ${relayHome()} cannot be read (${errText(err)}).`);
  }
  if (!found || found.version === SCHEMA_VERSION) return;
  if (found.version > SCHEMA_VERSION) throw new Stop(`relay's registry ${found.file} was written by a newer relay (schema version ${found.version}; this ${installKind()} knows up to ${SCHEMA_VERSION}). Install that relay instead, or restore the registry backup it made; see docs/UPGRADING.md.`);
  if (!run.write) return void say(`# relay's registry ${found.file} is from an earlier relay (schema version ${found.version}); with --write it is backed up next to itself and then migrated`);
  try {
    db();
  } catch (err) {
    throw new Stop(errText(err));
  }
  const backup = registryBackup();
  note(run, "registry", {
    action: "replaced",
    what: `migrated the registry ${found.file} from schema ${found.version} to ${SCHEMA_VERSION}`,
    file: found.file,
    backup,
    undo: `stop every relay process, then follow docs/UPGRADING.md (Rollback) to archive the migrated registry and its WAL/SHM files, restore ${backup ? sh([backup]) : "the pre-migration backup made by the other relay process"} as ${sh([found.file])}, and verify PRAGMA user_version is ${found.version}; uninstall does not restore the registry`,
  });
  say(`# relay's registry ${found.file} was from an earlier relay: backed up to ${registryBackup() ?? "(nothing: another relay process migrated it at the same moment and made the backup)"} and migrated. To go back to the earlier relay, restore that backup (docs/UPGRADING.md).`);
}

export async function install(args: string[]): Promise<void> {
  const a = hostArgs("install", args, ["--write", "--force", "--no-link"]);
  if (!a) return;
  const run: Run = { verb: "install", host: a.host, write: a.has("--write"), force: a.has("--force"), record: { version: 1, hosts: {} }, made: [] };
  try {
    run.record = loadRecord();
    const plans = [planHost(run), ...(a.has("--no-link") ? [] : [planLink(run)])];
    const problems = plans.flatMap((p) => p.problems);
    if (problems.length) throw new Stop(problems.join("\n\n"));
    const known = run.record.hosts[run.host];
    const rec = (run.record.hosts[run.host] = { launcher: LAUNCHER, complete: known?.complete ?? false, at: known?.at ?? new Date().toISOString(), resources: known?.resources ?? {} });
    if (run.write) requireRecord(true);
    upgradeRegistry(run);
    for (const p of plans) p.apply();
    const nothing = `\nNothing to do: relay is already installed for ${hostDef(run.host).name} from this ${installKind()}.`;
    if (!run.write) {
      say(run.made.length ? "\nNothing was changed. Re-run with --write to apply." : nothing);
      if (run.host === "codex") for (const l of [codexPinPlan(), codexHomePlan()]) if (l) say(l);
      return;
    }
    if (run.made.length || !known?.complete) rec.at = new Date().toISOString();
    rec.complete = true;
    saveRecord(run.record);
    say(run.made.length ? `\nrelay is installed for ${hostDef(run.host).name}. What was changed is recorded in ${recordFile()}.` : nothing);
    if (hostDef(run.host).afterChange && run.made.length) say(hostDef(run.host).afterChange!);
    // The desktop app's entry under its earlier name hides this registration in the app's Code tab, however recently either was installed.
    if (run.host === "claude" && desktopEntryUnderOldName()) {
      say(`\nNote: relay's entry in the Claude desktop app still has its earlier name, ${DESKTOP_OLD_ENTRY}, which in the app's Code tab sessions hides the relay registered here. Rename it to ${DESKTOP_ENTRY}: quit the app, then ${reinstallCommand("install", "claude-desktop")}`);
    }
    // Codex's registration is in place; relay's own Codex (its pin and home) is checked next, and a
    // failure there ends the install with an error, after the rest is said.
    const notReady = run.host === "codex" ? [await codexPinStep(), codexHomeStep()].filter((p): p is string => !!p) : [];
    const bin = path.dirname(linkPath());
    if (!a.has("--no-link") && !onPath(bin)) say(`\nNote: ${bin} is not on your PATH, so the \`relay\` command will not be found. Add it, for zsh with:\n  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc\nUntil then, ${LAUNCHER} is the same command.`);
    if (notReady.length) {
      console.error(`\nrelay install codex: registered, but Codex is not ready: ${notReady.join("; ")}. Fix that and run this again (the registration is kept).`);
      process.exitCode = 1;
    }
  } catch (err) {
    stopped(run, err);
  }
}

/** A LaunchAgent plist that runs relay's Codex qualifier (scripts/codex-qualify/install-codex-qualifier.mjs isQualifierAgent). */
const QUALIFIER_AGENT = /<string>[^<]*\/scripts\/(?:codex-qualify|release-watch)\/codex-qualifier\.mjs<\/string>\s*<string>[^<]*<\/string>\s*<string>--run<\/string>/;
function qualifierAgents(): string[] {
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".plist")).sort(); } catch { return []; }
  return names.map((n) => path.join(dir, n)).filter((file) => {
    try { return fs.lstatSync(file).isFile() && QUALIFIER_AGENT.test(fs.readFileSync(file, "utf8")); } catch { return false; }
  });
}

/**
 * What uninstall leaves alone, and how to remove it by hand. None of it is deleted automatically: it
 * can hold the user's work and logins. `rm -rf` is suggested only for a directory relay named itself
 * (its default location, or one it derived from RELAY_HOME). A directory the user named (RELAY_HOME,
 * RELAY_WORKTREES, RELAY_CONFIG's directory, targets.codex.*) could be their home or hold their own
 * files: for those, relay names its own files there instead.
 */
function leftBehind(): string {
  const home = os.homedir();
  const there = (p: string) => (fs.existsSync(p) || isLink(p) ? "" : " (not present)");
  const same = (a: string, b: string) => canonical(a) === canonical(b);
  let cfg: RelayConfig = DEFAULT_CONFIG;
  let cfgNote = "";
  try { cfg = config(); } catch (err) { cfgNote = ` (relay's config does not load, ${errText(err)}, so these are the default locations)`; }

  type Item = { path: string; what: string; credential?: string; remove: string[] };
  const items: Item[] = [];
  const dir = (p: string, what: string, relayNamed: boolean, namedBy: string, credential?: string) => items.push({
    path: p, what, credential,
    remove: relayNamed ? [`rm -rf ${sh([p])}`] : [`# ${p} is a directory you named (${namedBy}): relay does not suggest deleting it whole. Delete what relay keeps there, or the directory if you made it only for relay.`],
  });

  const state = relayHome();
  dir(state, "relay's state: the registry of runs, logs, the prompts sent and the transcripts", same(state, path.join(home, ".local", "state", "relay")), "RELAY_HOME");
  const trees = worktreesHome();
  dir(trees, "the worktrees of write jobs", !process.env.RELAY_WORKTREES || same(trees, path.join(home, ".local", "share", "relay", "worktrees")), "RELAY_WORKTREES");
  const consults = consultHome();
  dir(consults, "the directories questions without a project were asked in", true, "");
  const harness = harnessHome();
  dir(harness, "the state of the harnesses relay confines itself (each item's Copilot, Grok or Gemini home)", true, "");

  // The config's directory: relay's own by default; otherwise only relay's files in it.
  const cfgDir = path.dirname(configPath());
  const local = localConfigPath();
  if (same(cfgDir, path.join(home, ".config", "relay"))) {
    items.push({ path: cfgDir, what: "your relay configuration, its local settings (local.json), the installation record and what install saved", remove: [`rm -rf ${sh([cfgDir])}`] });
  } else {
    const files = [configPath(), installRecordPath(), mcpFile()];
    const backups = installBackupsPath();
    items.push({
      path: [...files, backups].join(", "), what: `your relay configuration, the installation record and what install saved, in ${cfgDir}, a directory you named (${process.env.RELAY_CONFIG ? "RELAY_CONFIG" : "RELAY_HOME"}); only these files are relay's`,
      remove: [`rm -f ${sh(files)}`, `rm -rf ${sh([backups])}`],
    });
    items.push({ path: local, what: "relay's local settings (which API key file each key-only target reads)", remove: [`rm -f ${sh([local])}`] });
  }

  // Relay's Codex: its own home (with the login relay's jobs use) and the pin store's read-only trees.
  const codexHome = relayCodexHome(cfg);
  const codexHomeOwn = same(codexHome, expandHome("~/.local/share/relay-codex-home")) || (fs.existsSync(codexHome) && !codexHomeProblem(cfg));
  dir(codexHome, "relay's Codex home: the Codex login relay's jobs run on, and their Codex sessions", codexHomeOwn, "targets.codex.home", "holds a login (auth.json)");
  const store = relayCodexPinStore(cfg);
  const storeOwn = same(store, expandHome("~/.local/share/relay-codex-pins"));
  items.push({
    path: store, what: "relay's pinned Codex releases (sealed read-only, so they are made writable first) and the qualifier's results",
    remove: storeOwn ? [`chmod -R u+w ${sh([store])} && rm -rf ${sh([store])}`] : [`# ${store} is a directory you named (targets.codex.pin_store): relay does not suggest deleting it whole. Make relay's trees there writable (chmod -R u+w) and delete them, or the directory if you made it only for relay.`],
  });
  const keys = defaultKeyDir();
  items.push({ path: keys, what: "the API key files relay hands a key-only target (Gemini); local.json can name a key file elsewhere, which is yours to delete", credential: "holds API keys", remove: [`rm -rf ${sh([keys])}`] });

  // Relay's private sockets and short temp links, and the Codex qualifier's scratch runs.
  const privateRoot = privateStateRoot(), tempRoot = nativeTempRoot(), alias = nativeTempAlias();
  items.push({ path: privateRoot, what: "relay's private sockets and per-turn state", remove: [`rm -rf ${sh([privateRoot])}`] });
  items.push({ path: tempRoot, what: "the short temp directories relay gives Claude's turns", remove: [`rm -rf ${sh([tempRoot])}`] });
  // Named by user id, not home: listed only when it is there and this home's.
  let aliasTarget: string | null = null;
  try { aliasTarget = fs.readlinkSync(alias); } catch { /* absent, or not a link */ }
  if (aliasTarget === tempRoot) items.push({ path: alias, what: `a link to ${tempRoot}, made for a long home directory`, remove: [`rm -f ${sh([alias])}`] });
  const scratch = path.join(home, ".rsm", "q");
  items.push({ path: scratch, what: "the Codex qualifier's scratch runs", remove: [`chmod -R u+w ${sh([scratch])} && rm -rf ${sh([scratch])}`] });

  const agents = qualifierAgents();
  const agentLogs = path.join(home, "Library", "Logs", "relay-codex-qualifier");
  const unload = agents.length
    ? agents.flatMap((plist) => [`launchctl bootout gui/$(id -u)/${path.basename(plist, ".plist")}`, `rm -f ${sh([plist])}`]).concat(`rm -rf ${sh([agentLogs])}`)
    : [`# none found in ~/Library/LaunchAgents; if you installed one under another name: launchctl bootout gui/$(id -u)/<label>, then delete its plist and ${agentLogs}`];

  const out = [
    "",
    `Not removed, because it can hold your work or your logins${cfgNote}:`,
    ...items.flatMap((i) => [`  ${i.path}${i.path.includes(", ") ? "" : there(i.path)}${i.credential ? ` [${i.credential}]` : ""}`, `      ${i.what}`]),
    ...agents.map((plist) => `  ${plist}\n      the Codex qualifier's LaunchAgent (with its logs in ${agentLogs})`),
    "  in each repository relay ran a write job in: the line `.relay/` in .git/info/exclude, and any relay/* branches",
    "",
    "To remove them by hand, in this order:",
    `  1. ${sh([LAUNCHER, "clean"])}`,
    "     First, while the state directory is still there. It commits work left in finished jobs' worktrees to",
    "     their branches, removes those worktrees, and deletes relay/* branches that are already merged. It lists",
    "     the unmerged branches it kept, so no work is lost.",
    "  2. In each of those repositories: `git branch --list 'relay/*'` shows what is left. Merge what you want,",
    "     delete the rest with `git branch -D <branch>`, and delete the line `.relay/` from .git/info/exclude.",
    "  3. Stop the Codex qualifier's LaunchAgent, if you installed it:",
    ...unload.map((l) => `     ${l}`),
    "  4. Then the rest, after checking each: the ones marked above hold credentials.",
    ...items.flatMap((i) => i.remove.map((l) => `     ${l}`)),
  ];
  return out.join("\n");
}
const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

export function uninstall(args: string[]): void {
  const a = hostArgs("uninstall", args, ["--write", "--force", "--remove-link"]);
  if (!a) return;
  const run: Run = { verb: "uninstall", host: a.host, write: a.has("--write"), force: a.has("--force"), record: { version: 1, hosts: {} }, made: [] };
  try {
    run.record = loadRecord();
    // Where install left a record, it says what relay put in place and what it saved. What is
    // removed is still decided by looking: an entry is taken out only if it is relay's now.
    const rec = run.record.hosts[run.host];
    if (rec) {
      say(`# installed ${rec.at.slice(0, 10)} from ${rec.launcher}${rec.complete ? "" : " (that install did not finish)"}, according to ${recordFile()}`);
      for (const c of Object.values(rec.resources)) if (c.backup) say(`#   saved at install, for you to consult: ${c.backup}`);
    } else say(`# no installation record for ${hostDef(run.host).name}; going by what is installed`);
    const plans = [planHost(run), planUnlink(run, a.has("--remove-link"))];
    const problems = plans.flatMap((p) => p.problems);
    if (problems.length) throw new Stop(problems.join("\n\n"));
    if (run.write) requireRecord(false);
    for (const p of plans) p.apply();
    if (run.write) {
      delete run.record.hosts[run.host];
      saveRecord(run.record);
    }
    say(!run.made.length ? `\nNothing to do: nothing of relay's was found in ${hostDef(run.host).name}.` : run.write ? `\nrelay's entries are removed from ${hostDef(run.host).name}.` : "\nNothing was changed. Re-run with --write to apply.");
    if (hostDef(run.host).afterChange && run.made.length) say(hostDef(run.host).afterChange!);
    say(leftBehind());
  } catch (err) {
    stopped(run, err);
  }
}

/**
 * After `install codex --write`: put this release's shipped Codex pin in place, so that Codex works
 * without a local qualification (decision 18). Never over a pin qualified on this Mac; a git
 * checkout ships no pin and is told to run `relay qualify-codex`. Not part of the install record:
 * the pin store is relay's state, which uninstall leaves alone.
 */
async function codexPinStep(): Promise<string | null> {
  const { placeShippedPin, qualifyCodexDefaults, relayVerdict } = await import("./install/qualify-codex.js");
  const deps = qualifyCodexDefaults();
  say("\nCodex pin:");
  // No launched-agent check here (that one opens relay's registry, which install must not create):
  // the pin store is write-denied to every agent relay launches, so a launched install fails to write it.
  const placed = await placeShippedPin(deps, { replaceLocal: false });
  let cfg;
  try { cfg = deps.config(); } catch (err) { return `relay's config does not load (${errText(err)})`; }
  const pinned = relayVerdict(cfg, say);
  if (placed === "busy" || placed === "failed") return "this release's shipped Codex pin was not put in place (see Codex pin above)";
  // Expected, and said above: a checkout ships no pin (relay qualify-codex makes one), and pinned: false runs no pin.
  if (!pinned && placed !== "none" && cfg.targets.codex.pinned !== false) return "relay finds no qualified Codex pin it would run (see Codex pin above)";
  return null;
}

/**
 * After `install codex --write`: make relay's Codex home if it is not there yet, as a Codex turn
 * would (prepareCodexHome: a private directory holding the config.toml relay writes each turn), so
 * that the one-time `codex login` there has a home to sign into. Codex refuses a CODEX_HOME that does
 * not exist, and a login made before relay's config.toml is in place could go to another credential
 * store than the file relay's turns read. Relay's state, like the pin store: not in the install record.
 */
function codexHomeStep(): string | null {
  let cfg;
  try { cfg = config(); } catch (err) { say(`\nCodex home: not made (relay's config does not load: ${errText(err)})`); return `relay's config does not load (${errText(err)})`; }
  const before = codexHomeStatus(cfg);
  try { prepareCodexHome(cfg); } catch (err) { say(`\nCodex home: relay could not make ${before.home}: ${errText(err)}`); return `relay's Codex home is not usable (see Codex home above)`; }
  say(`\nCodex home: ${before.home} (${before.present ? "already there" : "made"}; relay runs Codex with this home, not ~/.codex).`);
  // Not a failure: only the person can sign in, and this says how.
  if (codexHomeStatus(cfg).login !== "present") say(`Sign Codex in there once:\n  ${codexLoginCommand(cfg)}`);
  return null;
}

/** What a dry run of `install codex` would do about relay's Codex home. */
function codexHomePlan(): string {
  let cfg;
  try { cfg = config(); } catch { return ""; }
  const state = codexHomeStatus(cfg);
  if (state.problem) return `# with --write, relay would not make or change its Codex home, and install would end with an error: ${state.problem}`;
  return state.present ? "" : `# with --write, it would also make relay's Codex home, ${state.home}, for the one-time codex login there`;
}

/** What a dry run of `install codex` would do about the pin. */
function codexPinPlan(): string {
  let shipped;
  try { shipped = readShippedPin(shippedPinPackageRoot()); } catch (err) { return `# this relay's shipped Codex pin is not valid (${errText(err)})`; }
  return shipped
    ? `# with --write, it would also put this release's shipped Codex pin in place (Codex ${shipped.codex.version}, downloaded from npm and verified), unless a pin you qualified on this Mac is current`
    : "# this relay ships no Codex pin: after installing, run relay qualify-codex once";
}
