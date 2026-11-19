// Root-owned selection. Diagnostic text contains names and fixed reasons only.
import os from "node:os";
import path from "node:path";
import { relayCodexHome, type RelayConfig, type Target } from "./config.js";
import { TARGETS, targetDef, targetLabel } from "../targets/index.js";
import { recognizedSecretShape } from "./secrets.js";

export type ChildEnvPolicy = "allowlist" | "legacy";
export interface ChildEnvSettings { policy?: ChildEnvPolicy; pass?: string[]; drop?: string[]; request?: string[] }
export interface EffectiveChildEnv { policy: ChildEnvPolicy; pass: string[]; drop: string[]; request: string[] }
export interface EnvironmentDiagnostic { name: string; included: boolean; reason: string }
export const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Changes after startup confer no launch authority. Workers receive a root-selected environment. */
export const capturedRootEnvironment: Readonly<NodeJS.ProcessEnv> = Object.freeze({ ...process.env });
// USER, LOGNAME and SHELL are who and how, not secrets. Claude Code 2.1.303 needs USER to find its
// keychain login (`claude auth status` reports loggedIn: false without it; checked live 2026-10-21).
export const RUNTIME_NAMES = ["PATH", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME", "TZ", "TERM", "COLORTERM", "NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE"] as const;
export const PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
const HOST_MARKERS = ["CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_AGENT_SDK_VERSION"];
export const BACKEND_OWNED_NAMES = ["HOME", "TMPDIR", "TMP", "TEMP", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "pnpm_config_package_import_method", "NODE_OPTIONS", "LD_PRELOAD", "SEATBELT_PROFILE", "BUILD_SANDBOX"] as const;
export function backendOwnedEnvironmentName(name: string): boolean {
  return name.startsWith("RELAY_") || name.startsWith("DYLD_") || name.startsWith("LD_") || name.startsWith("XDG_") || name === "NODE_USE_ENV_PROXY" || (BACKEND_OWNED_NAMES as readonly string[]).includes(name);
}
/** Machine-readable backend guards, reused by config and the selection path. */
export const BACKEND_ENVIRONMENT_SCRUBS: Record<Target, RegExp> = {
  claude: /^(?:CLAUDECODE|CLAUDE_AUTO_BACKGROUND_TASKS|CLAUDE_AGENT_SDK_VERSION)$|^CLAUDE_CODE_(?!(?:USE_|OAUTH_TOKEN|SKIP_))/,
  codex: /(?!)/,
  copilot: /^(?:COPILOT_(?!GITHUB_TOKEN$)|GITHUB_COPILOT_)/,
  gemini: /^(GEMINI_|OTEL_|CLOUDSDK_|OAUTH_CALLBACK_|GOOGLE_CLOUD_|GOOGLE_GENAI_USE_)|^(GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|CLOUD_SHELL|SANDBOX|SEATBELT_PROFILE|BUILD_SANDBOX|DEBUG|DEBUG_MODE|NO_BROWSER)$/,
  grok: /^(GROK_|XAI_|OTEL_)|^SENTRY_DSN$/,
};
export function effectiveChildEnv(config: Pick<RelayConfig, "child_env" | "targets">, target: Target): EffectiveChildEnv {
  const root = config.child_env ?? {};
  const own = config.targets[target]?.child_env ?? {};
  const union = (key: "pass" | "drop" | "request") => [...new Set([...(root[key] ?? []), ...(own[key] ?? [])])];
  return { policy: own.policy ?? root.policy ?? "allowlist", pass: union("pass"), drop: union("drop"), request: union("request") };
}
export function mandatoryEnvironmentReason(target: Target, config: Pick<RelayConfig, "child_auth" | "targets">, name: string, rootEnv: NodeJS.ProcessEnv = {}): string | null {
  if (backendOwnedEnvironmentName(name)) return "backend-owned control";
  if (HOST_MARKERS.includes(name) || name === "CODEX_INTERNAL_ORIGINATOR_OVERRIDE" || name === "CLAUDE_CODE_MESSAGING_SOCKET" || name === "CLAUDE_CODE_MESSAGING_TOKEN") return "host-session identity";
  const def = targetDef(target);
  const auth = config.targets[target]?.child_auth ?? config.child_auth;
  for (const other of TARGETS) {
    if (!other.credentialEnv.test(name)) continue;
    if (auth === "login" || other.id !== target && (other.vendor === null || def.vendor === null || other.vendor !== def.vendor)) return "mandatory vendor authentication guard";
  }
  if (auth === "login" && def.loginEnv?.test(name)) return "mandatory login authentication guard";
  if (HOST_MARKERS.some((m) => Boolean(rootEnv[m])) && (config.targets.claude?.child_auth ?? config.child_auth) === "login" && targetDef("claude").endpointEnv.test(name)) return "host-session endpoint";
  if (target !== "claude" && (name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_"))) return "foreign harness session control";
  if (BACKEND_ENVIRONMENT_SCRUBS[target].test(name)) return "mandatory backend guard";
  return null;
}
export function validatedProxy(name: string, value: string): boolean {
  if (/^no_proxy$/i.test(name)) {
    if (!value.trim()) return true;
    return value.split(",").every((entry) => {
      const host = entry.trim();
      const match = /^(?:\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?$/.exec(host);
      return host === "*" || Boolean(match && (match[1] === undefined || Number(match[1]) > 0 && Number(match[1]) <= 65535));
    });
  }
  try {
    const u = new URL(value);
    return ["http:", "https:", "socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"].includes(u.protocol) && Boolean(u.hostname) && !u.username && !u.password && !u.search && !u.hash && (!u.pathname || u.pathname === "/") && (!u.port || Number(u.port) > 0 && Number(u.port) <= 65535);
  } catch { return false; }
}
export function requestEnvironmentProblem(target: Target, config: RelayConfig, rootEnv: NodeJS.ProcessEnv, names: readonly string[]): string | null {
  const policy = effectiveChildEnv(config, target);
  for (const name of names) {
    if (!ENVIRONMENT_NAME.test(name)) return "grant.env requires exact environment variable names";
    if (!policy.request.includes(name)) return `grant.env ${name} is not in targets.${target}.child_env.request or child_env.request; ask the person to configure it`;
    const mandatory = mandatoryEnvironmentReason(target, config, name, rootEnv);
    if (mandatory) return `grant.env ${name} is forbidden (${mandatory})`;
    if (policy.drop.includes(name)) return `grant.env ${name} is dropped by child_env.drop`;
    if (rootEnv[name] === undefined) return `grant.env ${name} is absent from the root's captured environment; restart the root after setting it`;
  }
  return null;
}
export function selectEnvironment(target: Target, config: RelayConfig, rootEnv: NodeJS.ProcessEnv, requestedNames: readonly string[] = []): { env: NodeJS.ProcessEnv; diagnostics: EnvironmentDiagnostic[]; policy: EffectiveChildEnv; releasedNames: string[] } {
  // Preserve the person's endpoint intent before any allowlist, drop or backend scrub. Only
  // a desktop/SDK host's own endpoint under login is removed instead of refusing the launch.
  const def = targetDef(target);
  const endpoints = Object.keys(rootEnv).filter((name) => rootEnv[name] !== undefined && def.endpointEnv.test(name)
    && mandatoryEnvironmentReason(target, config, name, rootEnv) !== "host-session endpoint").sort();
  if (endpoints.length) throw new Error(
    `the environment relay runs in sets ${endpoints.join(", ")}, which sends ${def.product} to another endpoint than its vendor's, where relay cannot tell which family of model answers. ` +
    `Relay reaches other families only, so it does not launch ${targetLabel(def)} this way. ` +
    ((config.targets[target]?.child_auth ?? config.child_auth) === "any"
      ? 'With "child_auth": "any", filtering out that endpoint could send a credential meant for it to the vendor instead. ' : "") +
    (endpoints.every((name) => mandatoryEnvironmentReason(target,
      { ...config, targets: { ...config.targets, claude: { ...config.targets.claude, child_auth: "login" } } }, name, rootEnv) === "host-session endpoint")
      ? 'Under this desktop/SDK host, setting targets.claude to "child_auth": "login" lets relay remove the host-session endpoint and credentials and verify the account login. ' : "") +
    "Unset those variables in the root environment and restart relay.",
  );
  const problem = requestEnvironmentProblem(target, config, rootEnv, requestedNames);
  if (problem) throw new Error(problem);
  const policy = effectiveChildEnv(config, target);
  const env: NodeJS.ProcessEnv = {};
  const diagnostics: EnvironmentDiagnostic[] = [];
  const releasedNames: string[] = [];
  for (const name of Object.keys(rootEnv).sort()) {
    const value = rootEnv[name];
    if (value === undefined) continue;
    const explicit = policy.pass.includes(name) || requestedNames.includes(name);
    let reason = mandatoryEnvironmentReason(target, config, name, rootEnv);
    let included = false;
    if (!reason) {
      if (policy.drop.includes(name)) reason = "configured drop";
      else if (explicit) { included = true; reason = requestedNames.includes(name) ? "person-approved turn request" : "standing pass"; }
      else if (policy.policy === "legacy") { included = true; reason = "legacy inheritance"; }
      else if ((RUNTIME_NAMES as readonly string[]).includes(name)) {
        included = !recognizedSecretShape(value); reason = included ? "runtime baseline" : "recognized secret shape requires explicit selection";
      } else if ((PROXY_NAMES as readonly string[]).includes(name)) {
        included = validatedProxy(name, value) && !recognizedSecretShape(value); reason = included ? "validated proxy" : "proxy requires explicit selection";
      } else reason = "outside allowlist";
    }
    if (included) { env[name] = value; if (explicit) releasedNames.push(name); }
    diagnostics.push({ name, included, reason });
  }
  Object.assign(env, backendEnvironmentRoots(target, rootEnv));
  if (target === "codex") env.CODEX_HOME = relayCodexHome(config);
  return { env, diagnostics, policy, releasedNames };
}
/** No standing passes or one-turn disclosures in worker/bridge environments. */
export function runtimeEnvironment(rootEnv: NodeJS.ProcessEnv = capturedRootEnvironment): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of RUNTIME_NAMES) if (rootEnv[name] !== undefined && !recognizedSecretShape(rootEnv[name]!)) env[name] = rootEnv[name];
  for (const name of ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME", "GROK_HOME", "GROK_AUTH_PATH", "RELAY_HOME", "RELAY_WORKTREES", "RELAY_CONFIG", "RELAY_ENV_SOCKET", "RELAY_DEV_MODEL_STUB"]) if (rootEnv[name] !== undefined) env[name] = rootEnv[name];
  // Only the extension consent tests opt in. Preserve their bounded decoy catalog through
  // trusted workers and child relay registrations; never admit an ordinary environment flag.
  if (rootEnv.RELAY_TEST_NEVER_ADAPTERS === "1" && rootEnv.NODE_TEST_CONTEXT?.startsWith("child")) {
    env.RELAY_TEST_NEVER_ADAPTERS = "1";
    env.NODE_TEST_CONTEXT = rootEnv.NODE_TEST_CONTEXT;
  }
  return env;
}
export function backendEnvironmentRoots(target: Target, rootEnv: NodeJS.ProcessEnv = capturedRootEnvironment): NodeJS.ProcessEnv {
  const home = rootEnv.HOME || os.homedir();
  const env: NodeJS.ProcessEnv = { HOME: home };
  // A nested Claude turn needs the person's deny-rule location as well, but only the person's own
  // setting: Claude Code 2.1.303 keys its keychain login to CLAUDE_CONFIG_DIR being set at all, so
  // setting it even to the default ~/.claude makes `claude auth status` report loggedIn: false
  // (checked live, 2026-10-21). Unset, every reader here falls back to ~/.claude as Claude does.
  if (rootEnv.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = path.resolve(rootEnv.CLAUDE_CONFIG_DIR);
  if (target === "codex") env.CODEX_HOME = path.resolve(rootEnv.CODEX_HOME || path.join(home, ".codex"));
  return env;
}
