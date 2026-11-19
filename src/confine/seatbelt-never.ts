import { neverIdentityProblem, neverProfileInputs, type NeverPolicy } from "../core/never-policy.js";
import { within } from "./paths.js";

/** Final operation-specific floor, shared by every overlay profile. No path/port interpolation. */
export function neverSeatbeltRules(policy: NeverPolicy, param: (name: string, value: string) => string, diag: string,
  own: { worktree: string; tmpDir: string; execPort?: number; bindPorts?: number[]; mediatedPort?: number }): string[] {
  const problem = neverIdentityProblem(policy); if (problem) throw new Error(problem);
  const p = neverProfileInputs(policy), rules: string[] = [];
  const writes = "file-write* file-write-data file-write-create file-write-unlink file-write-mode file-link";
  const paths = (paths: string[], ops: string, prefix: string, managed = false) => paths.forEach((root, i) => {
    const value = param(`${prefix}_${i}`, root);
    const exceptions = managed ? [own.worktree, own.tmpDir].filter(x => within(x, root)).map((x, j) => `(require-not (subpath ${param(`${prefix}_${i}_OWN_${j}`, x)}))`) : [];
    const filter = exceptions.length ? `(require-all (subpath ${value}) ${exceptions.join(" ")})` : `(subpath ${value})`;
    rules.push(`(deny ${ops} ${filter} ${diag})`);
  });
  paths(p.denyAll, `file-read* file-read-data file-read-metadata file-test-existence ${writes}`, "NEVER_ALL");
  paths(p.denyWrite, writes, "NEVER_WRITE");
  paths(p.authorityRoots, `file-read* file-read-data file-read-metadata file-test-existence ${writes}`, "NEVER_AUTHORITY", true);
  if (p.denyKeychain) rules.push(`(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.trustd") ${diag})`);
  p.ports.forEach((r, i) => {
    const port = param(`NEVER_PORT_${i}`, String(r.port));
    for (const transport of r.transport === "both" ? ["tcp", "udp"] : [r.transport]) {
      const host = r.destinations === "any" ? "*" : "localhost";
      rules.push(`(deny network-outbound (require-all (remote ${transport} (string-append "${host}:" ${port}))) ${diag})`);
      // Explicit families retain mapped-IPv6 service-port overblocking. Final inbound deny beats broad TCP inbound.
      rules.push(`(deny network-outbound (require-all (remote ip6 (string-append "*:" ${port})) (remote ${transport} (string-append "*:" ${port}))) ${diag})`);
      rules.push(`(deny network-bind network-inbound (local ${transport} (string-append "*:" ${port})) ${diag})`);
    }
  });
  p.authorityPorts.forEach((port, i) => {
    const value = param(`NEVER_CONTROL_${i}`, String(port));
    if (!own.bindPorts?.includes(port) && port !== own.mediatedPort) rules.push(`(deny network-outbound (remote ip4 (string-append "localhost:" ${value})) (remote ip6 (string-append "*:" ${value})) ${diag})`);
    if (port === own.mediatedPort) rules.push(`(deny network-outbound (remote ip6 (string-append "*:" ${value})) ${diag})`);
    if (port !== own.execPort && !own.bindPorts?.includes(port)) rules.push(`(deny network-bind network-inbound (local ip4 (string-append "*:" ${value})) (local ip6 (string-append "*:" ${value})) ${diag})`);
  });
  return rules;
}
