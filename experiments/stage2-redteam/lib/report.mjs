// Tiny check/report helpers shared by the e2e runner and the probes.

/** One named oracle: pass is a boolean; detail is shown either way. */
export function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail };
}

/**
 * Print a scenario's checks and a short diagnostic tail. Returns true iff every check passed.
 * `bundle` is the runScenario result (for stderr / status on failure).
 */
export function report(title, checks, bundle) {
  if (bundle?.modelRequests) {
    const exercised = bundle.modelRequests.length > 0 && bundle.outputs?.length > 0 && !bundle.modelErrors?.length;
    checks = [
    check("scripted model reached and tool output returned (no setup-refusal pass)",
      exercised,
      { requests: bundle.modelRequests.length, outputs: bundle.outputs?.length, status: bundle.result?.status }),
    check("scripted probe hooks succeeded", !bundle.modelErrors?.length, bundle.modelErrors),
    ...checks.map(c => exercised ? c : { ...c, pass: false, detail: "probe did not execute successfully; no containment claim" }),
    ];
  }
  const ok = checks.every((c) => c.pass);
  console.log(`\n=== ${title}: ${ok ? "PASS" : "FAIL"} ===`);
  for (const c of checks) {
    console.log(`  [${c.pass ? "ok" : "XX"}] ${c.name}` + (c.pass ? "" : `  -> ${JSON.stringify(c.detail)}`));
  }
  if (!ok && bundle) {
    console.log(`  status: ${JSON.stringify(bundle.result)?.slice(0, 400)}`);
    const err = (bundle.stderr ?? []).join("");
    if (err) console.log(`  relay stderr (tail):\n${err.slice(-1600)}`);
  }
  if (bundle?.cleanup?.length) console.log(`  cleanup: ${bundle.cleanup.join(" ; ")}`);
  return ok;
}
