// The stub's Codex CLI: `codex app-server` (JSON-RPC, with approval requests sent to the client),
// `codex exec --json` (no approval channel: the action is simply denied), and `codex mcp list`.
import { emit, loadSession, record, runSteps, SEEN_ENV, stubborn } from "../stub-agent.mjs";
import fs from "node:fs";
import path from "node:path";

const archiveFile = (id) => path.join(process.env.STUB_DIR, "sessions", `codex-${id}.archived`);
const sessionFile = (id) => path.join(process.env.STUB_DIR, "sessions", `codex-${id}.json`);
/** The model a thread is started on when it names none: Codex's default at the time (STUB_CODEX_NEW_THREAD_MODEL), else the stub's own. */
const newThreadModel = () => process.env.STUB_CODEX_NEW_THREAD_MODEL ?? "gpt-stub";

/**
 * Codex's fast_mode feature as this server has it, or undefined where nothing sets it (on, as in
 * Codex 0.163.0): a layer above relay's flags (STUB_CODEX_EFFECTIVE features) first, then relay's
 * -c features.fast_mode, then the person's own config (STUB_CODEX_FEATURES), which relay's flags
 * outrank. With it off, Codex 0.163.0 drops every service tier, "default" included.
 */
function fastMode(c) {
  const above = JSON.parse(process.env.STUB_CODEX_EFFECTIVE ?? "{}").features?.fast_mode;
  if (typeof above === "boolean") return above;
  if (Object.prototype.hasOwnProperty.call(c, "features.fast_mode")) return c["features.fast_mode"] === true;
  const own = JSON.parse(process.env.STUB_CODEX_FEATURES ?? "{}").fast_mode;
  return typeof own === "boolean" ? own : undefined;
}

/**
 * A -c value as Codex parses it (TOML; the raw text where it is not), for the TOML relay writes:
 * strings, booleans, numbers, arrays and inline tables whose keys are quoted.
 */
function tomlValue(raw) {
  let json = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      json += ch;
      if (ch === "\\") json += raw[++i];
      else if (ch === '"') inString = false;
    } else if (ch === '"') { inString = true; json += ch; }
    else json += ch === "=" ? ":" : ch;
  }
  try { return JSON.parse(json); } catch { return raw; }
}

/** The permission profile a server started with these -c values selects, as Codex 0.163.0 reads it, or null for a built-in one. */
function profileOf(cfg) {
  const id = cfg.default_permissions;
  if (typeof id !== "string" || id.startsWith(":")) return null;
  const at = `permissions.${id}.`;
  const profile = {};
  for (const [k, v] of Object.entries(cfg)) if (k.startsWith(at)) {
    const keys = k.slice(at.length).split(".");
    let o = profile;
    for (const key of keys.slice(0, -1)) o = o[key] ??= {};
    o[keys.at(-1)] = v;
  }
  return profile;
}

/** What a profile allows: read, write or danger (no sandbox), as the stub's steps use it. */
function accessOf(id, profile) {
  if (id === ":danger-full-access") return "danger";
  if (id === ":read-only") return "read";
  if (!profile) return "unknown";
  return profile.filesystem?.[":workspace_roots"]?.["."] === "write" ? "write" : "read";
}

/** The legacy description of a thread's sandbox (SandboxPolicy) the real server reports for a profile. */
function sandboxOf(id, profile, extraRoots = []) {
  const access = accessOf(id, profile);
  if (access === "danger") return { type: "dangerFullAccess" };
  const networkAccess = profile?.network?.enabled === true;
  if (access === "read") return { type: "readOnly", networkAccess };
  // Writable: the profile's own roots and every workspace root of the thread but its directory (`:workspace_roots` "." = write).
  return { type: "workspaceWrite", writableRoots: [...new Set([...Object.keys(profile?.workspace_roots ?? {}), ...extraRoots])], networkAccess, excludeTmpdirEnvVar: profile?.filesystem?.[":tmpdir"] !== "write", excludeSlashTmp: profile?.filesystem?.[":slash_tmp"] !== "write" };
}

/** A profile as config/read reports it: every key Codex knows and nothing set to it null. */
function reportedProfile(profile) {
  if (!profile) return null;
  const { glob_scan_max_depth = null, ...entries } = profile.filesystem ?? {};
  return {
    description: profile.description ?? null, extends: profile.extends ?? null, workspace_roots: profile.workspace_roots ?? null,
    filesystem: profile.filesystem ? { glob_scan_max_depth, ...entries } : null,
    network: profile.network ? { enabled: null, proxy_url: null, mode: null, domains: null, ...profile.network } : null,
  };
}

function parseCodex(argv) {
  const cfg = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "-c") continue;
    const eq = argv[i + 1].indexOf("=");
    const key = argv[i + 1].slice(0, eq);
    const raw = argv[i + 1].slice(eq + 1);
    // Inline tables only where relay writes them for a profile; other keys as before (skills.config stays its text).
    let value = raw;
    if (key.startsWith("permissions.")) value = tomlValue(raw);
    else try { value = JSON.parse(raw); } catch {}
    cfg[key] = value;
  }
  const resumed = argv[1] === "resume";
  if (resumed && fs.existsSync(archiveFile(argv[argv.length - 2]))) throw new Error("cannot resume an archived thread");
  const env = {};
  for (const [k, v] of Object.entries(cfg)) if (k.startsWith("mcp_servers.relay.env.")) env[k.slice("mcp_servers.relay.env.".length)] = v;
  const relay = cfg["mcp_servers.relay.command"] && cfg["mcp_servers.relay.enabled"] !== false
    ? { command: cfg["mcp_servers.relay.command"], args: cfg["mcp_servers.relay.args"] ?? [], env, env_vars: cfg["mcp_servers.relay.env_vars"] ?? [] }
    : undefined;
  const profile = profileOf(cfg);
  return {
    sessionId: resumed ? argv[argv.length - 2] : undefined, resumed, relay, cfg, profile,
    access: accessOf(cfg.default_permissions, profile),
  };
}

/** Emulates `codex app-server`: JSON-RPC over stdio, with approval requests sent to the client. */
async function appServer(argv) {
  const parsed = parseCodex(argv);
  const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const answers = new Map();
  let nextId = 1000;
  let session = null;
  let threadParams = null;
  /** Skill roots added to this server (skills/extraRoots/set). */
  let extraRoots = [];
  /** Whether the client turned on the experimental API (initialize), which thread/start's `permissions` needs. */
  let experimental = false;
  const rl = (await import("node:readline")).createInterface({ input: process.stdin });
  // STUB_CODEX_RPC_DELAY_MS: every request from relay is answered that much later (the benchmark's
  // diagnostic, scripts/bench: it exposes how many requests are on a turn's critical path). Off by default.
  const rpcDelay = Number(process.env.STUB_CODEX_RPC_DELAY_MS ?? 0);
  for await (const line of rl) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && m.method === undefined) { answers.get(m.id)?.(m.result ?? { error: m.error }); continue; }
    if (rpcDelay > 0 && m.id !== undefined) await new Promise((r) => setTimeout(r, rpcDelay));
    if (m.method === "initialize") { experimental = m.params?.capabilities?.experimentalApi === true; record({ event: "codex-initialize", capabilities: m.params?.capabilities ?? null }); out({ id: m.id, result: { userAgent: "stub" } }); continue; }
    // An administrator's requirements, as the real server reports them (ConfigRequirementsReadResponse): none, unless a test sets some.
    if (m.method === "configRequirements/read") {
      if (process.env.STUB_CODEX_REQUIREMENTS_ERROR) { out({ id: m.id, error: { code: -32000, message: process.env.STUB_CODEX_REQUIREMENTS_ERROR } }); continue; }
      out({ id: m.id, result: { supportsIndependentSpeedModes: true, requirements: JSON.parse(process.env.STUB_CODEX_REQUIREMENTS ?? "null") } });
      continue;
    }
    if (m.method === "config/read") {
      // What reached the server, for a test of the environment a preflight gets (STUB_RECORD_CONFIG_READ),
      // and a server that never answers, for a test of a preflight that hangs (STUB_CODEX_HANG_CONFIG).
      if (process.env.STUB_RECORD_CONFIG_READ) record({ event: "config-read", target: "codex", env: SEEN_ENV, node: process.env.RELAY_NODE_ID ?? null });
      if (process.env.STUB_CODEX_HANG_CONFIG) continue;
      // The effective configuration, built from the flags this server was started with. A test can
      // overlay values to stand in for a layer that outranks relay's flags.
      const c = parsed.cfg;
      const servers = {};
      for (const [k, v] of Object.entries(c)) {
        const mm = /^mcp_servers\.("?)(.+?)\1\.(enabled|command|args)$/.exec(k);
        if (mm) (servers[mm[2]] ??= {})[mm[3]] = v;
        const me = /^mcp_servers\.relay\.env\.(.+)$/.exec(k);
        if (me) ((servers.relay ??= {}).env ??= {})[me[1]] = v;
      }
      const has = (k) => Object.prototype.hasOwnProperty.call(c, k);
      // shell_environment_policy as Codex 0.163.0 reports it: as configured, every unset field null
      // (Codex's defaults). STUB_CODEX_SHELL_POLICY replaces it with a test's own (JSON), or leaves
      // it out ("omit"), as a server that does not report it.
      const shellPolicy = process.env.STUB_CODEX_SHELL_POLICY === undefined
        ? { inherit: null, ignore_default_excludes: null, exclude: null, set: null, include_only: null, filters: null, experimental_use_profile: null }
        : JSON.parse(process.env.STUB_CODEX_SHELL_POLICY);
      const config = {
        ...(shellPolicy === "omit" ? {} : { shell_environment_policy: shellPolicy }),
        ...(has("daybreak") ? { daybreak: c.daybreak } : {}),
        sandbox_mode: c.sandbox_mode ?? null, approvals_reviewer: c.approvals_reviewer, service_tier: c.service_tier ?? null, web_search: c.web_search ?? "indexed",
        default_permissions: c.default_permissions ?? null,
        permissions: parsed.profile ? { [c.default_permissions]: reportedProfile(parsed.profile) } : null,
        sandbox_workspace_write: null,
        mcp_servers: servers,
        // Every --disable and --enable the server was started with, as the real one reports features set.
        features: {
          plugins: true, hooks: true, ...Object.fromEntries(argv.flatMap((a, i) => (a === "--disable" || a === "--enable" ? [[argv[i + 1], a === "--enable"]] : []))),
          // Every -c features.<key> as given, as the real server echoes them, known or not.
          ...Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith("features.") && k !== "features.fast_mode").map(([k, v]) => [k.slice("features.".length), v])),
          ...(fastMode(c) === undefined ? {} : { fast_mode: fastMode(c) }),
        },
        ...(has("skills.config") ? { skills: { config: c["skills.config"] } } : {}),
        ...JSON.parse(process.env.STUB_CODEX_EFFECTIVE ?? "{}"),
      };
      out({ id: m.id, result: { config, origins: {} } });
      continue;
    }
    if (m.method === "initialized") continue;
    // The features this server runs with, as the real one lists them (ExperimentalFeatureListResponse,
    // Codex 0.164.0): only keys it knows, network_proxy and request_permissions_tool among them, on as
    // the -c flags set them. STUB_CODEX_FEATURE_LIST replaces the list (JSON), or makes the call fail ("error").
    if (m.method === "experimentalFeature/list") {
      record({ event: "feature-list", target: "codex" });
      if (process.env.STUB_CODEX_FEATURE_LIST === "error") { out({ id: m.id, error: { code: -32601, message: "method not found" } }); continue; }
      const on = (k) => parsed.cfg[`features.${k}`] === true;
      const data = JSON.parse(process.env.STUB_CODEX_FEATURE_LIST ?? "null") ?? [
        { name: "exec_permission_approvals", stage: "underDevelopment", enabled: on("exec_permission_approvals"), defaultEnabled: false },
        { name: "request_permissions_tool", stage: "underDevelopment", enabled: on("request_permissions_tool"), defaultEnabled: false },
        { name: "network_proxy", stage: "beta", enabled: on("network_proxy"), defaultEnabled: false },
      ];
      out({ id: m.id, result: { data, nextCursor: null } });
      continue;
    }
    // A command Codex runs in a sandbox of this server's profile (command/exec): relay's network check.
    // What the real server's sandbox would make of it (codex-network.ts CANARY_SCRIPT), from the
    // profile and the proxy feature; STUB_CODEX_CANARY replaces the output (JSON), or fails the call ("error").
    if (m.method === "command/exec") {
      record({ event: "command-exec", target: "codex", params: m.params, cwd: m.params?.cwd ?? null });
      if (process.env.STUB_CODEX_CANARY === "error") { out({ id: m.id, error: { code: -32000, message: "failed to start managed network proxy" } }); continue; }
      const net = parsed.profile?.network ?? {};
      const proxied = net.enabled === true && parsed.cfg["features.network_proxy"] === true;
      const local = net.allow_local_binding === true;
      // STUB_CODEX_CANARY_LATER: the output from the second command/exec of the job on (a file in STUB_DIR counts them).
      const counter = path.join(process.env.STUB_DIR, "codex-command-exec-count");
      const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
      fs.writeFileSync(counter, String(seen + 1));
      const later = seen >= 1 && process.env.STUB_CODEX_CANARY_LATER ? process.env.STUB_CODEX_CANARY_LATER : null;
      const result = later ? JSON.parse(later) : process.env.STUB_CODEX_CANARY ? JSON.parse(process.env.STUB_CODEX_CANARY)
        : !net.enabled ? { proxy: null, loop: "EPERM", unix: "EPERM", viaProxy: "no proxy" }
        : !proxied ? { proxy: null, loop: "connected", unix: "connected", viaProxy: "no proxy" }
        : { proxy: "http://127.0.0.1:61000", loop: local ? "connected" : "EPERM", unix: "EPERM", viaProxy: local ? "HTTP/1.1 200 OK" : "HTTP/1.1 403 Forbidden" };
      out({ id: m.id, result: { exitCode: 0, stdout: JSON.stringify(result) + "\n", stderr: "" } });
      continue;
    }
    // Skills as codex-cli 0.163.0 finds them (observed under a scratch CODEX_HOME and HOME): the
    // person's ($CODEX_HOME/skills without .system, ~/.agents/skills), the repository's (.agents/skills
    // and .codex/skills in the turn's directory and each one above it up to the repository's top),
    // every directory up to six levels below one of those that holds a file named exactly SKILL.md
    // (inside another skill's directory too, never in a dot-directory), Codex's own system skill,
    // extra roots set on this server (left out under STUB_CODEX_DROP_ROOTS, as if Codex did not take
    // them; a root whose parent holds .claude-plugin/plugin.json has its skills named
    // <plugin>:<name>, as 0.163.0 names them), and any a test adds (STUB_CODEX_SKILLS, or
    // STUB_CODEX_IN_ROOT under the first extra root), each switched off by a skills.config entry
    // naming its SKILL.md.
    if (m.method === "skills/extraRoots/set") { extraRoots = m.params.extraRoots ?? []; out({ id: m.id, result: {} }); continue; }
    if (m.method === "skills/list") {
      const cwd = m.params?.cwds?.[0] ?? process.cwd();
      const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME ?? "", ".codex");
      const off = new Set([...String(parsed.cfg["skills.config"] ?? "").matchAll(/path="((?:[^"\\]|\\.)*)",enabled=false/g)].map((x) => JSON.parse(`"${x[1]}"`)));
      const found = [];
      const scan = (dir, scope, depth = 0, prefix = "") => {
        if (!fs.existsSync(dir)) return;
        for (const n of fs.readdirSync(dir).sort()) {
          const sub = path.join(dir, n);
          if (n.startsWith(".") || !fs.statSync(sub).isDirectory()) continue;
          if (fs.readdirSync(sub).includes("SKILL.md")) found.push({ name: `${prefix}${n}`, path: path.join(sub, "SKILL.md"), scope });
          if (depth + 1 < 6) scan(sub, scope, depth + 1, prefix);
        }
      };
      const pluginOf = (root) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(path.dirname(root), ".claude-plugin", "plugin.json"), "utf8")).name;
        } catch {
          return null;
        }
      };
      scan(path.join(codexHome, "skills"), "user");
      scan(path.join(process.env.HOME ?? "", ".agents", "skills"), "user");
      for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
        scan(path.join(d, ".agents", "skills"), "repo");
        scan(path.join(d, ".codex", "skills"), "repo");
        if (fs.existsSync(path.join(d, ".git")) || path.dirname(d) === d) break;
      }
      if (!process.env.STUB_CODEX_DROP_ROOTS) for (const r of extraRoots) scan(r, "user", 0, pluginOf(r) ? `${pluginOf(r)}:` : "");
      found.push({ name: "openai-docs", path: path.join(codexHome, "skills", ".system", "openai-docs", "SKILL.md"), scope: "system" });
      found.push(...JSON.parse(process.env.STUB_CODEX_SKILLS ?? "[]"));
      if (extraRoots.length) found.push(...JSON.parse(process.env.STUB_CODEX_IN_ROOT ?? "[]").map((x) => ({ name: x.name, path: path.join(extraRoots[0], x.rel), scope: "user" })));
      const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
      const skills = found.map((f) => ({ name: f.name, description: "", path: f.path, scope: f.scope, enabled: !off.has(f.path) && !off.has(real(f.path)), pluginId: null }));
      const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
      const copies = Object.fromEntries(skills.filter((sk) => extraRoots.some((r) => sk.path.startsWith(r))).map((sk) => [sk.name, read(sk.path)]));
      record({ event: "skills-list", target: "codex", cwd, found: skills.map((sk) => sk.name), enabled: skills.filter((sk) => sk.enabled).map((sk) => sk.name), roots: extraRoots, plugins: extraRoots.map(pluginOf), copies });
      out({ id: m.id, result: { data: [{ cwd, skills, errors: [] }] } });
      continue;
    }
    if (m.method === "account/read") {
      const type = process.env.STUB_ACCOUNT ?? "chatgpt";
      out({ id: m.id, result: { account: process.env.STUB_ACCOUNT === "none" ? null : { type, ...(type === "chatgpt" ? { planType: process.env.STUB_CODEX_PLAN ?? "prolite" } : {}) }, requiresOpenaiAuth: true } });
      continue;
    }
    // The account's model catalog, as the real server lists it (ModelListResponse, Codex 0.163.0): each model's
    // service tiers by catalog id. By default one model, the stub's own, offering fast (priority) only; a test can replace it.
    // STUB_CODEX_MODEL_PAGES, a list of such lists, is the catalog in pages, as the real server pages it (cursor, nextCursor).
    if (m.method === "model/list") {
      record({ event: "model-list", target: "codex", params: m.params });
      // A server or account whose catalog cannot be read (STUB_CODEX_MODEL_LIST_ERROR, the error's message).
      if (process.env.STUB_CODEX_MODEL_LIST_ERROR) { out({ id: m.id, error: { code: -32000, message: process.env.STUB_CODEX_MODEL_LIST_ERROR } }); continue; }
      let cached = null;
      try {
        cached = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "models_cache.json"), "utf8")).models?.map((m) => ({
          id: m.slug, model: m.slug, availableAccessPrograms: { cyber: m.available_access_programs?.cyber?.map((p) => p === "daybreak_blue" ? "daybreakBlue" : p) ?? [] },
        }));
      } catch { /* Ordinary tests use the stub's default catalog. */ }
      const pages = JSON.parse(process.env.STUB_CODEX_MODEL_PAGES ?? "null") ?? [JSON.parse(process.env.STUB_CODEX_MODELS ?? "null") ?? cached ?? [
        { id: "gpt-stub", model: "gpt-stub", displayName: "GPT-Stub", hidden: false, isDefault: true, serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }], defaultServiceTier: null },
      ]];
      const page = m.params?.cursor ? Number(m.params.cursor) : 0;
      // A hidden model is listed only when asked for (includeHidden), as the real server does.
      const data = (pages[page] ?? []).filter((model) => m.params?.includeHidden === true || !model.hidden);
      out({ id: m.id, result: { data, nextCursor: page + 1 < pages.length ? String(page + 1) : null } });
      continue;
    }
    // A thread's stored metadata, as the real server reads it (ThreadReadParams, ThreadReadResponse; Codex 0.163.0): its model among them.
    if (m.method === "thread/read") {
      record({ event: "thread-read", target: "codex", params: m.params });
      const file = sessionFile(m.params.threadId);
      if (!fs.existsSync(file)) { out({ id: m.id, error: { code: -32600, message: `no rollout found for thread id ${m.params.threadId}` } }); continue; }
      const sess = JSON.parse(fs.readFileSync(file, "utf8"));
      out({ id: m.id, result: { thread: { id: m.params.threadId, model: sess.model ?? newThreadModel(), modelProvider: "openai" } } });
      continue;
    }
    if (m.method === "thread/archive" || m.method === "thread/unarchive") {
      const id = m.params.threadId;
      const archived = archiveFile(id);
      if (m.method === "thread/archive" && process.env.STUB_CODEX_ARCHIVE_ERROR) {
        const error = process.env.STUB_CODEX_ARCHIVE_ERROR;
        out({ id: m.id, error: { code: -32000, message: error === "ENOSPC" ? "disk full" : error } }); continue;
      }
      if (m.method === "thread/unarchive" && !fs.existsSync(archived)) {
        out({ id: m.id, error: { code: -32600, message: `no archived rollout found for thread id ${id}` } }); continue;
      }
      if (m.method === "thread/archive") fs.writeFileSync(archived, "");
      else fs.unlinkSync(archived);
      record({ event: m.method, target: "codex", sessionId: id });
      out({ id: m.id, result: {} }); continue;
    }
    if (m.method === "thread/start" || m.method === "thread/resume") {
      // As the real server checks them (0.163.0): a profile named on the thread needs the experimental API, and excludes `sandbox`.
      if (m.params.permissions !== undefined && !experimental) { out({ id: m.id, error: { code: -32600, message: `${m.method}.permissions requires experimentalApi capability` } }); continue; }
      if (m.params.permissions !== undefined && m.params.sandbox !== undefined) { out({ id: m.id, error: { code: -32600, message: "`permissions` cannot be combined with `sandbox`" } }); continue; }
      threadParams = m.params;
      const resumed = m.method === "thread/resume";
      if (resumed && fs.existsSync(archiveFile(m.params.threadId))) {
        out({ id: m.id, error: { code: -32600, message: `session ${m.params.threadId} is archived. Unarchive it first.` } }); continue;
      }
      session = loadSession("codex", { sessionId: resumed ? m.params.threadId : undefined, resumed });
      if (session.missing) { out({ id: m.id, error: { code: -32000, message: `no thread ${m.params.threadId}` } }); continue; }
      session.resumed = resumed;
      // A resumed thread's past turns, as the real server returns them (0.163.0 and 0.164.0 thread/resume excludeTurns):
      // in the reply, after a deprecation notice as for a thread whose history is paginated (the threads relay starts
      // are, under both versions), unless it is told to leave them out.
      const full = resumed && m.params.excludeTurns !== true;
      if (full) out({ method: "deprecationNotice", params: { summary: "Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`.", details: null } });
      const pastTurns = full ? Array.from({ length: session.sess.turns - 1 }, (_, i) => ({ id: `turn_${i + 1}`, items: [], status: "completed" })) : [];
      // As the real server reports it: the model the thread will use and its provider. A test can overlay them.
      // The service tier as the real server reports it (Codex 0.163.0): the one asked for, or null for one it does not know.
      // With its fast_mode feature off, none at all.
      const tier = fastMode(parsed.cfg) !== false && typeof m.params.serviceTier === "string" && ["default", "priority", "ultrafast"].includes(m.params.serviceTier) ? m.params.serviceTier : null;
      // The model: the one asked for, else, resumed, the thread's own (as Codex restores it), else the default.
      const model = m.params.model ?? (resumed ? session.sess.model : undefined) ?? newThreadModel();
      session.sess.model = model;
      // The thread's workspace roots, as the real server keeps them (0.163.0 thread/resume): the ones it is
      // told, else on resume the ones the thread stored, else its directory. A server that ignores the ones
      // it is told (STUB_CODEX_IGNORE_ROOTS, or a file codex-ignore-roots in STUB_DIR) restores the stored ones; a test can store others in the thread's file.
      const cwd = m.params.cwd ?? process.cwd();
      const ignore = process.env.STUB_CODEX_IGNORE_ROOTS || fs.existsSync(path.join(process.env.STUB_DIR, "codex-ignore-roots"));
      const told = ignore ? undefined : m.params.runtimeWorkspaceRoots;
      const roots = told ?? (resumed ? session.sess.roots : undefined) ?? [cwd];
      session.sess.roots = roots;
      fs.writeFileSync(sessionFile(session.sessionId), JSON.stringify(session.sess));
      // STUB_CODEX_THREAD_OMIT: keys the result leaves out, for a server that does not report them.
      // The profile the thread runs with: the one it names, else the one the server's config selects; and the legacy description of its sandbox.
      const active = m.params.permissions ?? parsed.cfg.default_permissions;
      const sandbox = sandboxOf(active, parsed.profile, roots.filter((r) => r !== cwd));
      // Recorded with the turn: the parameters, the access they come to and the directories the thread reports writable.
      threadParams = { ...m.params, access: accessOf(active, parsed.profile), sandboxWritable: sandbox.writableRoots ?? [] };
      const result = {
        thread: { id: session.sessionId, turns: pastTurns }, approvalPolicy: m.params.approvalPolicy, model, modelProvider: "openai", serviceTier: tier,
        ...(m.params.sandbox !== undefined ? { sandbox: { type: m.params.sandbox } } : { sandbox, runtimeWorkspaceRoots: roots, activePermissionProfile: typeof active === "string" ? { id: active, extends: null } : null }),
        ...JSON.parse(process.env.STUB_CODEX_THREAD ?? "{}"),
      };
      for (const k of JSON.parse(process.env.STUB_CODEX_THREAD_OMIT ?? "[]")) delete result[k];
      out({ id: m.id, result });
      continue;
    }
    if (m.method === "turn/interrupt" && stubborn.on) { record({ event: "interrupt", target: "codex", ignored: true }); out({ id: m.id, result: {} }); continue; }
    if (m.method === "turn/interrupt") { out({ id: m.id, result: {} }); out({ method: "turn/completed", params: { turn: { id: "turn_1", status: "interrupted" } } }); process.exit(0); }
    if (m.method === "turn/start") {
      out({ id: m.id, result: { turn: { id: "turn_1" } } });
      out({ method: "turn/started", params: { turn: { id: "turn_1" } } });
      const prompt = m.params.input[0].text;
      const access = threadParams.access;
      record({ event: "start", env: SEEN_ENV, target: "codex", via: "app-server", argv, prompt, sessionId: session.sessionId, resumed: session.resumed, turn: session.sess.turns, access, cwd: process.cwd(), hasRelay: Boolean(parsed.relay), thread: threadParams, sandboxPolicy: m.params.sandboxPolicy ?? null, effort: m.params.effort ?? null, model: m.params.model ?? null, serviceTier: m.params.serviceTier ?? null, cyberAccessProgram: m.params.cyberAccessProgram ?? null, turnKeys: Object.keys(m.params) });
      void (async () => {
        const ask = (command) => new Promise((resolve) => {
          // Told never to ask, the real server does not: the command simply fails inside the sandbox.
          if (threadParams.approvalPolicy === "never") return resolve({ decision: "deny", message: "blocked by the sandbox" });
          const id = nextId++;
          const identity = typeof command !== "string" && command.threadId ? { threadId: command.threadId, turnId: command.turnId ?? "child-turn" } : {};
          const patchId = command.itemId ?? (command.anonymous ? "patch_unknown" : "patch_1");
          answers.set(id, (res) => {
            record({ event: "approval-answer", target: "codex", ...identity, decision: res.decision });
            const allowed = res.decision === "accept" || res.decision === "acceptForSession";
            // A declined command or file change is reported as an item that ended declined.
            if (!allowed) {
              out({ method: "item/completed", params: { ...identity, item: typeof command !== "string" && command.edit
                ? { type: "fileChange", id: patchId, status: "declined", changes: command.anonymous ? [] : [{ path: command.edit, kind: "update" }] }
                : { type: "commandExecution", id: "exec_1", status: "declined", command: typeof command === "string" ? command : command.cmd ?? `curl ${command.web ?? command.fetch}` } } });
            }
            resolve(res.decision === "accept" ? { decision: "allow" } : res.decision === "acceptForSession" ? { decision: "allow", scope: "job" } : { decision: "deny" });
          });
          if (typeof command !== "string" && command.edit) {
            // Codex announces the change as an item first; the approval request refers to it by id.
            if (!command.anonymous) out({ method: "item/started", params: { ...identity, item: { type: "fileChange", id: patchId, changes: [{ path: command.edit, kind: "update" }] } } });
            out({ id, method: "item/fileChange/requestApproval", params: { threadId: session.sessionId, turnId: "turn_1", ...identity, itemId: patchId, startedAtMs: Date.now(), reason: "needs to write outside the sandbox" } });
          }
          else {
            // A request may carry what Codex's experimental API adds (additionalPermissions,
            // availableDecisions), its kind (writeStdin) or a blocked host (networkApprovalContext).
            // Generic approval-transport scenarios use input to an already running terminal:
            // allowing it adds no filesystem authority, so PC's immutable store survives. Tests
            // of command escalation must send an explicit object (kind:"command" or additions).
            // PC's stdio fixture separately verifies a real broad request is declined before asking.
            const generic = typeof command === "string" ||
              ((command.web || command.fetch) && !["kind", "additionalPermissions", "networkApprovalContext"].some((k) => k in command));
            const extra = generic ? { kind: "writeStdin" } : Object.fromEntries(["kind", "additionalPermissions", "availableDecisions", "networkApprovalContext"].filter((k) => k in command).map((k) => [k, command[k]]));
            out({ id, method: "item/commandExecution/requestApproval", params: { threadId: session.sessionId, turnId: "turn_1", itemId: "exec_1", startedAtMs: Date.now(), command: typeof command === "string" ? command : command.cmd ?? `curl ${command.web ?? command.fetch}`, reason: "blocked by the sandbox", cwd: (typeof command === "string" ? undefined : command.cwd) ?? process.cwd(), ...extra } });
            // withdraw: the request is resolved by Codex itself at once (its execution was cancelled,
            // say), announced with serverRequest/resolved as Codex 0.167 does; an answer relay
            // sends afterwards is recorded and has no effect.
            if (typeof command !== "string" && command.withdraw) {
              answers.set(id, (res) => record({ event: "approval-answer-after-withdraw", target: "codex", decision: res.decision }));
              out({ method: "serverRequest/resolved", params: { threadId: session.sessionId, requestId: id } });
              record({ event: "approval-withdrawn", target: "codex" });
              resolve({ decision: "deny", withdrawn: true });
            }
          }
        });
        const r = await runSteps(codex, parsed, prompt, session.sess, ask);
        record({ event: "end", target: "codex", sessionId: session.sessionId, ...r });
        if (r.failure) out({ method: "turn/completed", params: { turn: { id: "turn_1", status: "failed", error: { message: r.failure } } } });
        else {
          // The thread's running total, as the real server reports it after each model response.
          const n = session.sess.turns;
          out({ method: "thread/tokenUsage/updated", params: { threadId: session.sessionId, turnId: "turn_1", tokenUsage: { total: { totalTokens: 1500 * n, inputTokens: 1000 * n, cachedInputTokens: 600 * n, outputTokens: 500 * n, reasoningOutputTokens: 100 * n }, last: { totalTokens: 1500 }, modelContextWindow: 400000 } } });
          out({ method: "item/completed", params: { item: { type: "agentMessage", id: "msg_1", text: r.reply } } });
          out({ method: "turn/completed", params: { turn: { id: "turn_1", status: "completed" } } });
        }
      })();
      continue;
    }
    // A message added to the running turn, as the real server takes it (TurnSteerParams).
    if (m.method === "turn/steer") {
      record({ event: "steer", target: "codex", threadId: m.params.threadId, expectedTurnId: m.params.expectedTurnId, input: m.params.input });
      out({ id: m.id, result: { turnId: m.params.expectedTurnId } });
      continue;
    }
    if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: "unsupported" } });
  }
}

const codex = {
  id: "codex",
  version: "codex-cli 0.163.0 (stub)",

  intercept(argv) {
    if (!(argv.includes("mcp") && argv.includes("list"))) return false;
    process.stdout.write(process.env.STUB_CODEX_MCP_LIST ?? "[]");
    return true;
  },
  serve: (argv) => (argv[0] === "app-server" ? appServer(argv) : null),
  parse: parseCodex,
  // As Codex names itself to the MCP servers it starts: relay believes a root's --host codex only
  // while its clientInfo agrees (src/mcp/host.ts registrationAgrees).
  mcpClientName: "codex-mcp-client",
  // Codex passes MCP servers a filtered environment; emulate that so the tests prove that the
  // explicit env in the injected entry is enough.
  mcpEnv: (env, envVars = []) => Object.fromEntries(Object.entries(env).filter(([k]) => ["PATH", "HOME", "TMPDIR", ...envVars].includes(k) || k.startsWith("STUB_"))),

  start(argv, parsed, sessionId) {
    emit({ type: "thread.started", thread_id: sessionId });
    emit({ type: "turn.started" });
  },
  ask: () => async () => ({ decision: "deny", message: "no approval channel" }),
  fail: (failure) => emit({ type: "turn.failed", error: { message: failure } }),
  finish(reply) {
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: reply } });
    emit({ type: "turn.completed", usage: {} });
  },
};
export default codex;
