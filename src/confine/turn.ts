// Shared construction for production relay-enforced turns and the red-team harness.
import fs from "node:fs";
import path from "node:path";
import type { TurnSpec } from "../backends/types.js";
import type { PreparedState } from "../backends/acp.js";
import type { ConfinementPolicy, NetworkPolicy, TokenStore } from "./index.js";
import type { TokenStoreGrant } from "../targets/types.js";
import { openProxy } from "./proxy.js";
import { registerTurnSecret } from "../core/secrets.js";
import { keyPathsToDeny } from "../core/api-keys.js";
import { ensurePrivateRoot, privateStateRoot } from "./private-root.js";
import { relayCodexProtected } from "../core/protected-config.js";
import type { RelayConfig } from "../core/config.js";
import { neverFloorApplies } from "../core/never-coverage.js";

export function privateTurnTemp(parent = ensurePrivateRoot(privateStateRoot()), prefix = "relay-tmp-"): string {
  // path.join drops the trailing slash of an empty prefix; preserve it so short native
  // names are children of the protected root rather than siblings of it.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(parent, prefix) + (prefix ? "" : path.sep)));
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** The production proxy owns its generated credentials redaction registration. */
export async function openTurnProxy(opts: Parameters<typeof openProxy>[0]) {
  const proxy = await openProxy(opts);
  try { registerTurnSecret(proxy.token, "proxy token"); }
  catch (error) { await proxy.close(); throw error; }
  return proxy;
}

/** Identity-bearing inputs and the login home are supplied by the caller; the key paths denied come from relay's key settings (core/api-keys.ts). */
export function turnPolicy(spec: Pick<TurnSpec, "cwd" | "access" | "grant" | "worktreePin" | "gitEnv" | "target" | "neverPolicy"> & { config?: RelayConfig },
  state: PreparedState, tmpDir: string, network: NetworkPolicy, home: string, name: string, bridgeSocket?: string, bridgeSecret?: string): ConfinementPolicy {
  // Write grants carry one identity pin each (caller.ts checkGrant). A grant without its pins is a legacy
  // grant from before relay pinned them: relay refuses the turn and the root must grant it again,
  // rather than run with an unpinned grant (review X2). Checked here as well as in the sandbox
  // layer, whose own check runs inside prepareLaunch, so it does not depend on which probe runs.
  const grantPaths = spec.access === "write" ? (spec.grant?.write_paths ?? []) : [];
  const grantPins = spec.access === "write" ? (spec.grant?.write_path_pins ?? []) : [];
  if (grantPaths.length && grantPins.length !== grantPaths.length) {
    throw new Error(`${name} was granted write paths without the per-directory pins relay records when it authorises a grant (a grant from an earlier version). The root session must grant those write paths again before relay will run this turn.`);
  }
  // The target's login store, in the person's real home whatever home the harness is given.
  const store = spec.target.tokenStore ? loginStore(spec.target.tokenStore, home) : undefined;
  const codex = relayCodexProtected(spec.config);
  return {
    // Where the floor binds this target (core/never-coverage.ts). It conflicts with released
    // credential/TRUST routes (Copilot, Grok): where it does not apply, retain their released outer
    // profile, not a profile whose final denies silently defeat its login allows. Grant/identity screens still run.
    ...(spec.neverPolicy && neverFloorApplies(spec.target.id, spec.config) ? { neverPolicy: spec.neverPolicy } : {}),
    worktree: spec.cwd,
    ...(spec.worktreePin ? { worktreePin: spec.worktreePin } : {}),
    // The worktree's git directories as the repository records them, not as its `.git` file says.
    ...(spec.gitEnv ? { gitEnv: spec.gitEnv } : {}),
    worktreeWritable: spec.access === "write",
    writable: grantPaths,
    writeDenied: codex.stores.map((p) => p.path),
    ...(grantPaths.length ? { writablePins: grantPins } : {}),
    stateDirs: state.stateDirs,
    // The profile's state whole (review E8): nothing of it is dropped on the way to the sandbox.
    state: {
      home: state.home ?? "temp",
      ...(state.homeVars ? { homeVars: state.homeVars } : {}),
      ...(state.links ? { links: state.links } : {}),
      ...(state.tokenFiles ? { tokenFiles: state.tokenFiles } : {}),
      ...(state.env ? { env: state.env } : {}),
      ...(state.persistent ? { persistent: state.persistent } : {}),
      ...(store ? { tokenStore: store } : {}),
    },
    ...(state.execPaths?.length ? { execPaths: state.execPaths } : {}),
    tmpDir,
    // The default API key directory and any key file the local config moves (core/api-keys.ts): no agent
    // relay confines, whatever its target, may read a key kept there, list the directory or test which names it holds.
    denied: [...keyPathsToDeny(), ...codex.homes.map((p) => p.path)],
    ...(bridgeSocket ? { bridgeSocket } : {}),
    ...(bridgeSecret ? { bridgeSecret } : {}),
    network,
    keychain: state.keychain,
    ...(state.certificateTrust ? { certificateTrust: true } : {}),
  };
}

/** A target's login-store grant, its directory resolved in `home`: a plain path below it, never the home folder itself or outside it. */
export function loginStore(grant: TokenStoreGrant, home: string): TokenStore {
  const parts = typeof grant.dir === "string" ? grant.dir.split("/") : [];
  if (!parts.length || parts.some((p) => !/^[A-Za-z0-9._-]+$/.test(p) || p === "." || p === "..")) {
    throw new Error(`${grant.name}: its directory must be a plain path relative to the home folder: ${JSON.stringify(grant.dir)}`);
  }
  return { name: grant.name, dir: path.join(home, ...parts), files: [...grant.files], locks: [...grant.locks], tempName: grant.tempName };
}
