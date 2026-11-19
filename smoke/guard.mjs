// What every smoke tool that starts relay checks first: that RELAY_HOME names a scratch state
// directory. Relay opens its registry there, and a build newer than the one in use migrates a
// registry it finds on first open (docs/UPGRADING.md, "The registry"). Run against the default
// state directory, a prerelease build would migrate the live registry before the cutover.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** RELAY_HOME, when it is set and is not relay's default state directory; otherwise exits with the reason. */
export function scratchHome() {
  const given = process.env.RELAY_HOME;
  // HOME may have been changed; the account's own home is checked as well.
  const defaults = [...new Set([os.homedir(), os.userInfo().homedir])].map((h) => path.join(h, ".local", "state", "relay"));
  const why = !given
    ? "RELAY_HOME is not set"
    : defaults.some((d) => real(d) === real(given))
      ? `RELAY_HOME is relay's default state directory (${given})`
      : null;
  if (!why) return given;
  console.error(
    `${why}. Smoke tools run only against a scratch state directory named in RELAY_HOME: relay opens its registry there, ` +
      "and a build newer than the one installed migrates the registry it finds. To launch real agents, choose a directory " +
      "outside temporary directories (relay refuses a control directory that agents' sandboxes can write to), for example " +
      "RELAY_HOME=~/relay-smoke. Relay then reads its config from $RELAY_HOME/config.json unless RELAY_CONFIG says otherwise.",
  );
  process.exit(2);
}
