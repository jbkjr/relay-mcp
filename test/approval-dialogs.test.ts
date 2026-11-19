import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hostProfile } from "../dist/mcp/host.js";
import { harness, INTERACTIVE_CLAUDE, task, until } from "./helpers.ts";

const codex = { name: "codex-mcp-client", version: "0.163.0" };

test("approval qualification: only surfaces qualified idle and busy get unsolicited dialogs", () => {
  for (const version of ["2.1.286", "2.1.302"]) {
    assert.equal(hostProfile(INTERACTIVE_CLAUDE.env, { name: "claude-code", version }, true).elicit, "dialog");
  }
  assert.equal(hostProfile({}, codex, true).elicit, "dialog");
  assert.equal(hostProfile({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_cli_rs" }, codex, true).elicit, "dialog");
  assert.equal(hostProfile({}, codex, true, [], null, { codexDesktop: true }).elicit, "no");
  for (const [env, client] of [
    [{}, { ...codex, version: "0.162.0-alpha.17.2" }],
    [{}, { ...codex, version: "0.162.1" }],
    [{ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, codex],
    [{ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "unqualified-wrapper" }, codex],
    [{}, { name: "unknown", version: "9.9.9" }],
  ] as const) assert.notEqual(hostProfile(env, client, true).elicit, "dialog", JSON.stringify({ env, client }));
});

for (const ask_user of ["auto", "always"] as const) {
  test(`approval qualification (${ask_user}): desktop and unknown hosts keep requests pending and deliver next-call events`, async () => {
    // A web search: a Claude command request is refused under the never floor before it is filed (core/approvals.ts).
    const h = await harness([{ match: task("GATED"), steps: [{ request: { web: "approval-dialog-gate" } }, { reply: "{{last}}" }] }], { ask_user });
    try {
      for (const surface of [
        { label: "app version", clientInfo: { ...codex, version: "0.162.0-alpha.17.2" }, reason: /Codex app.*busy.*not qualified/i },
        { label: "CLI idle only", clientInfo: { ...codex, version: "0.162.1" }, reason: /Codex CLI busy dialogs are not qualified before 0\.163\.0/ },
        { label: "desktop UI", clientInfo: codex, desktopUi: true, reason: /Codex app.*busy.*not qualified/i },
        { label: "desktop originator", clientInfo: codex, env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, reason: /Codex app.*busy.*not qualified/i },
        { label: "desktop metadata", clientInfo: codex, meta: { "x-codex-turn-metadata": { client_type: "desktop_app" } }, reason: /Codex app.*busy.*not qualified/i },
        { label: "unknown", clientInfo: { name: "unknown", version: "1.0.0" }, reason: /unrecognised host/i },
        { label: "custom originator", clientInfo: codex, env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "unqualified-wrapper" }, reason: /unrecognised host/i },
      ]) {
        let asked = 0;
        const host = await h.instance({ ...surface, host: null, elicit: () => (asked++, { action: "accept", content: { decision: "allow" } }) });
        if (surface.meta) assert.equal((await host.call("status")).approval_dialogs.offered, true, "metadata revokes an initially CLI-qualified connection");
        const job = await host.call("delegate", { target: "claude", task: "GATED", mode: "read" }, { meta: surface.meta });
        await until(() => h.sql("SELECT id FROM requests WHERE node_id = ? AND status = 'pending'", job.job_id).length === 1, 15000, `${surface.label}: pending request`);
        const request = h.sql("SELECT id FROM requests WHERE node_id = ?", job.job_id)[0].id;
        await until(() => {
          const log = path.join(h.home, "elicitation.log");
          return fs.existsSync(log) && fs.readFileSync(log, "utf8").includes(request);
        }, 15000, `${surface.label}: watcher processed request`);
        assert.equal(asked, 0, surface.label);
        // Observe through an unrelated call: the fallback must be events, without consuming them via status of this item.
        const next = await host.call("brief");
        assert.ok(next.events?.some((e: { kind: string; about: string }) => e.kind === "approval" && e.about === request), `${surface.label}: approval event`);
        const status = await host.call("status", { id: job.job_id });
        assert.deepEqual(status.approval_dialogs.offered, false);
        assert.match(status.approval_dialogs.reason, surface.reason);
        assert.match(status.approval_note, surface.reason);
        assert.equal(status.needs_approval[0].request_id, request);
        assert.equal(status.needs_approval[0].user_is_being_asked, undefined);
        assert.equal(h.sql("SELECT status FROM requests WHERE id = ?", request)[0].status, "pending");
        assert.equal((await host.tools()).includes("confirm"), false);
        await host.call("approve", { request_id: request, decision: "deny" });
        await host.close();
      }
    } finally { await h.close(); }
  });
}

test("approval qualification: qualified surfaces still show dialogs and status explains the offer", async () => {
  // Claude asks for a web search (its command requests are refused under the never floor before they are filed); Codex for a command.
  const h = await harness([
    { target: "claude", match: task("QUALIFIED"), steps: [{ request: { web: "qualified-dialog" } }, { reply: "{{last}}" }] },
    { target: "codex", match: task("QUALIFIED"), steps: [{ request: "qualified-dialog" }, { reply: "{{last}}" }] },
  ]);
  try {
    for (const surface of [INTERACTIVE_CLAUDE, { clientInfo: codex }]) {
      let asked = 0;
      const host = await h.instance({ ...surface, host: null, elicit: () => (asked++, { action: "cancel" }) });
      const initial = await host.call("status");
      assert.equal(initial.approval_dialogs.offered, true);
      assert.match(initial.approval_dialogs.reason, /idle and busy/i);
      const job = await host.call("delegate", { target: surface.clientInfo.name === "claude-code" ? "codex" : "claude", task: "QUALIFIED", mode: "read" });
      await until(() => asked === 1, 15000, "qualified dialog");
      const status = await host.call("status", { id: job.job_id, wait_s: 20 });
      assert.equal(status.needs_approval.length, 1);
      await host.call("approve", { request_id: status.needs_approval[0].request_id, decision: "deny" });
      await host.close();
    }
  } finally { await h.close(); }
});
