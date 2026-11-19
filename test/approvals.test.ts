import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.ts";
import { deciderForAgent } from "../dist/core/approvals.js";
import { decidedBy } from "../dist/core/events.js";

// Who decided an approval request is kept as free text (requests.decided_by) and put into words in
// three places: for the agent that asked (deciderForAgent), and for the root agent in events and late
// answers (events.ts byPerson, through decidedBy). This pins every wording for every value relay
// writes, so that classifying the value once (consolidation design R13) changes none of them.

/** Every decided_by value relay writes (ops approve and confirm, the terminal, the approval dialog), and one it does not. */
const VALUES = [
  "user",
  "user, through the host's permission prompt (confirm)",
  "terminal",
  "root session",
  "root session, stating that the user confirmed",
  "someone else entirely",
  null,
] as const;

test("approvals: who decided a request is worded the same for the agent that asked, for every value relay records", () => {
  assert.deepEqual(VALUES.map((v) => deciderForAgent(v)), [
    "by the user in relay's approval dialog",
    "by the user, in the root session's permission prompt",
    "from a terminal (relay approve or relay deny)",
    "by the root session supervising this run, not by the user",
    "by the root session supervising this run, which says the user confirmed it",
    undefined,
    undefined,
  ]);
  // Given the decision, a terminal's is named by the command that made it: relay approve takes no
  // person-only request, so a consent refused from a terminal was refused with relay deny.
  assert.equal(deciderForAgent("terminal", true), "from a terminal (relay approve)");
  assert.equal(deciderForAgent("terminal", false), "from a terminal (relay deny)");
  assert.equal(deciderForAgent("user", false), "by the user in relay's approval dialog");
});

test("approvals: who decided a request is worded the same for the root agent, allowed or denied, and for an expired one", () => {
  for (const status of ["allowed", "denied"]) {
    assert.deepEqual(VALUES.map((v) => decidedBy({ status, decided_by: v })), [
      `${status} by the user in relay's approval dialog`,
      `${status} by the user in your host's permission prompt (confirm)`,
      `${status} from a terminal (relay approve or relay deny)`,
      `${status} by you (the root session)`,
      `${status} by you (the root session, stating that the user confirmed)`,
      `${status} by someone else entirely`,
      `${status} by someone else`,
    ], status);
  }
  // Expired has three causes, none recorded: the turn ended, the asking agent stopped waiting (its
  // call or connection went away while its turn goes on: disconnect.test.ts), or the deadline passed.
  for (const v of VALUES) assert.equal(decidedBy({ status: "expired", decided_by: v }), "closed without an answer (its turn ended, the asking agent stopped waiting, or nobody answered in time)");
});
