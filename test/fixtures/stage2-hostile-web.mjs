// Scripted model calls shared by the standing/resume and worker/overlay live harnesses.
// No call here talks to a real provider. The URL and model endpoint are owned decoys.
import assert from "node:assert/strict";
import { offeredTools } from "../../scripts/codex-qualify/codex-stage2.mjs";

export const codeCall = input => ({ type: "custom_tool_call", name: "exec", input });
export function modelStubRequestKind(req) {
  if (req.method === "POST" && req.url === "/v1/responses") return "response";
  if (req.method === "GET" && req.url === "/v1/responses"
    && typeof req.headers?.upgrade === "string" && req.headers.upgrade.trim().toLowerCase() === "websocket") return "websocket";
  return "unexpected";
}
export function hostileWebCalls(surface, url) {
  const attempts = [
    { name: "web_search", args: { query: url } },
    { namespace: "web", name: "run", args: { open: [{ ref_id: url }], open_page: [{ url }] } },
  ];
  return attempts.map(({ namespace, name, args }) => surface === "code"
    ? codeCall(`try { const r = await tools[${JSON.stringify(namespace ? `${namespace}__${name}` : name)}](${JSON.stringify(args)}); text("HOSTILE_RETURNED:" + JSON.stringify(r)); } catch (e) { text("HOSTILE_REFUSED:" + String(e)); }`)
    : { type: "function_call", ...(namespace ? { namespace } : {}), name, arguments: JSON.stringify(args) });
}
export function assertHostileWebEvidence(surface, bodies, outputs) {
  assert.ok(bodies.length > 0, "real Codex reached the scripted model");
  for (const body of bodies) {
    const names = offeredTools(body);
    assert.ok(names.length > 0, "Codex advertised its tools");
    assert.equal(names.some(n => ["web", "web_search", "web__run"].includes(n)), false, `hosted web offered: ${names}`);
  }
  assert.equal(outputs.length, 2, "both hostile calls returned to the model");
  for (const out of outputs) {
    if (surface === "code") assert.match(out, /HOSTILE_REFUSED:/, out);
    assert.match(out, /not found|unknown|unrecognized|unsupported|not available|disabled|not a function|undefined/i, out);
    assert.doesNotMatch(out, /HOSTILE_RETURNED:/);
  }
}
