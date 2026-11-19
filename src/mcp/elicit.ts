// The approval dialog: how relay puts a launched agent's approval request to the user through the
// host (MCP elicitation), and how it reads the answer. Only an answer that is exactly one of the
// decisions the form offered decides anything; a host that keeps a withdrawn form on screen (Codex)
// gets no cancellation, and an answer it lets the person give after the request was decided
// elsewhere is recorded and reported, changing nothing.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { insideRelaySandbox, logElicitation, onceOnly, requestView, type RequestRow } from "../core/approvals.js";
import { personOnly } from "../core/extensions.js";
import type { ElicitAnswer } from "../core/caller.js";
import { runConfig } from "../core/db.js";
import { shown } from "../core/shown.js";
import { lateAnswer } from "../core/watch.js";
import type { HostProfile } from "./host.js";

/** The longest delay a Node timer takes (a longer one fires at once): about 24.8 days. */
const MAX_TIMER_MS = 2_147_483_647;

/** The key in a question's _meta that names the request it is about. */
const REQUEST_META = "relay/request";

/** The decisions an approval dialog offers. */
const DECISIONS: readonly string[] = ["allow", "allow for the rest of this job", "deny"];
/** The same, safe one first, for a form that preselects its first choice (HostProfile.safeFirst). */
const SAFE_FIRST: readonly string[] = ["deny", "allow", "allow for the rest of this job"];

/** How soon after a cancellation relay sent a "cancel" is taken for the host's acknowledgement of it. */
const CANCEL_ACK_MS = 500;

/**
 * Whether a host's answer is its acknowledgement of a cancellation relay sent (`cancelledAt`), not
 * a person's answer: a "cancel" arriving within CANCEL_ACK_MS after it. Codex answers a
 * cancellation of a form it keeps on screen with "cancel" at once.
 */
export function acknowledgesCancel(action: string, cancelledAt: number | undefined, at: number): boolean {
  return action === "cancel" && cancelledAt !== undefined && at >= cancelledAt && at - cancelledAt <= CANCEL_ACK_MS;
}

/**
 * The approval dialog of one relay server: for a host profile, the function that asks the user
 * about one request and says how it ended. The questions the server sent are tracked here, by the
 * transport's messages, for hosts that keep a withdrawn form.
 */
export function questionsThrough(server: McpServer): (profile: HostProfile) => (r: RequestRow, signal: AbortSignal) => Promise<ElicitAnswer> {
  /**
   * For hosts that keep a withdrawn form (HostProfile.withdraws false), the questions sent, by
   * their JSON-RPC id, and when a cancellation of one went out, by request id. Relay sends such a
   * host no cancellation: Codex answers one with "cancel" at once and stops listening for the
   * person's answer. Should one go out all the same, a "cancel" that follows it at once is its
   * acknowledgement, not an answer (acknowledgesCancel). Read from what the transport sends, by
   * the request id relay puts in the question's _meta.
   */
  const questionOf = new Map<string | number, string>();
  const cancelSentAt = new Map<string, number>();
  let tapped = false;
  const tapQuestions = () => {
    const t = server.server.transport;
    if (!t || tapped) return;
    tapped = true;
    const send = t.send.bind(t);
    t.send = (msg, opts) => {
      const m = msg as { method?: string; id?: string | number; params?: { _meta?: Record<string, unknown>; requestId?: string | number } };
      const request = m.method === "elicitation/create" ? m.params?._meta?.[REQUEST_META] : undefined;
      if (typeof request === "string" && m.id !== undefined) questionOf.set(m.id, request);
      const cancelled = m.method === "notifications/cancelled" && m.params?.requestId !== undefined ? questionOf.get(m.params.requestId) : undefined;
      if (cancelled) cancelSentAt.set(cancelled, Date.now());
      return send(msg, opts);
    };
  };

  /** Asks the user about one request through the host, and says how it ended. */
  const elicitThrough = (profile: HostProfile) => async (r: RequestRow, signal: AbortSignal): Promise<ElicitAnswer> => {
    const v = requestView(r);
    const asked = Date.now();
    const record = (action: string, reading: string) => logElicitation({ request: r.id, host: profile.why, action, ms: Date.now() - asked, reading });
    /**
     * How relay reads what the host answered, and how that goes in the log: a decision only if it
     * is exactly one the form offered.
     */
    const read = (res: { action: string; content?: Record<string, unknown> }): { answer: ElicitAnswer; logAs: [string, string] } => {
      // Only an answer that is exactly one of the offered decisions decides. Anything else (no
      // decision, one that was not offered, a note that is not text) is not what the dialog lets a
      // person give, so it leaves the request undecided rather than being read as either.
      const decision = res.action === "accept" ? res.content?.decision : undefined;
      const rawNote = res.action === "accept" ? res.content?.note : undefined;
      if (typeof decision === "string" && DECISIONS.includes(decision) && (!onceOnly(r) || decision !== "allow for the rest of this job") && (rawNote === undefined || typeof rawNote === "string")) {
        // A host relay does not know to show the question to a person (ask_user "always") may
        // answer it on its own: its allow of a request only the person may allow decides nothing.
        // Its deny still binds.
        if (decision !== "deny" && profile.elicit !== "dialog" && personOnly(r)) {
          return { answer: { reading: "unattributed", outcome: "accept (unattributed: only the person may allow it)" }, logAs: ["accept", "unattributed allow of a person-only request: left undecided"] };
        }
        const note = rawNote ? rawNote : undefined;
        return { answer: { reading: "decided", outcome: "accept", allow: decision !== "deny", forJob: decision === "allow for the rest of this job", note }, logAs: ["accept", decision] };
      }
      // An answer that is not one the form lets a person give is the host's, not theirs.
      if (res.action === "accept") return { answer: { reading: "unattributed", outcome: "accept (unqualified)" }, logAs: ["accept", "unqualified: left undecided"] };
      if (res.action === "decline" && profile.declineIsDenial) {
        return { answer: { reading: "decided", outcome: "decline", allow: false, note: "declined by the user" }, logAs: ["decline", "denied by the user"] };
      }
      // "cancel" carries no decision: the user closed the question (Esc), or the host could not
      // show it. Either way the request stays pending, for the calling agent or the terminal. It is
      // read as the person's closing only where the host is known to put it to a person and to
      // cancel only when they close it (interactive Claude Code); elsewhere, as a decline relay does
      // not take for a denial, it is the host's answer, which may not be anyone's.
      if (res.action === "cancel" && profile.elicit === "dialog" && profile.declineIsDenial) {
        return { answer: { reading: "dismissed", outcome: "cancel" }, logAs: ["cancel", "dismissed: left undecided"] };
      }
      return { answer: { reading: "unattributed", outcome: res.action }, logAs: [res.action, "unattributed: left undecided"] };
    };
    const answerOf = (res: { action: string; content?: Record<string, unknown> }): ElicitAnswer => {
      const { answer, logAs } = read(res);
      record(...logAs);
      return answer;
    };
    // A host that keeps a withdrawn form keeps the question open after it is decided elsewhere,
    // and the person can still answer it. Relay sends no cancellation then (Codex would answer it
    // with "cancel" and stop listening): it keeps the question open, and an answer that comes
    // later is recorded and reported. The agent's turn is held either way.
    const keeps = !profile.withdraws;
    if (keeps) tapQuestions();
    const question = server.server.elicitInput(
      {
        // Claude Code shows the first lines and folds the rest, so the essentials come first: who
        // asks and what allowing it does, what exactly, and where.
        message: [
          `relay: the ${v.agent} agent ${v.from} asks for approval${insideRelaySandbox(r) ? " to go ahead inside relay's sandbox" : ""}. Effect: ${v.effect}.`,
          `Wants: ${shown(r.summary)}`,
          `In: ${shown(String(v.in_directory))}`,
          ...(r.reason ? [`Its reason: ${shown(r.reason)}`] : []),
          ...(personOnly(r) ? ["Only you can allow this: the agent supervising the run can only deny it."] : []),
          ...(r.kind === "env" ? [`Environment disclosure (names and execution metadata only): ${shown(JSON.stringify(v.environment))}`] : []),
          // The task is agent-written text too (whichever agent delegated the job), so it is escaped like the rest.
          `Its task (depth ${v.depth}, ${v.session} session): ${shown(String(v.task))}`,
          ...(keeps ? ["If it is decided elsewhere first (by the agent or from a terminal), this form stays open until you answer it or press Esc; an answer then changes nothing, and relay tells the agent so."] : []),
        ].join("\n"),
        requestedSchema: {
          type: "object",
          properties: {
            // A form that preselects its first choice, where Enter submits it at once (Codex), gets
            // deny first, so that a stray Enter allows nothing.
            decision: { type: "string", enum: (profile.safeFirst ? [...SAFE_FIRST] : [...DECISIONS]).filter((d) => !onceOnly(r) || d !== "allow for the rest of this job"), title: "Decision" },
            // Codex's form could not be submitted with an optional text field left empty.
            ...(profile.formNote ? { note: { type: "string", title: "Note to the agent (optional)" } } : {}),
          },
          required: ["decision"],
        },
        ...(keeps ? { _meta: { [REQUEST_META]: r.id } } : {}),
      },
      // Open for as long as the request can be answered; withdrawn if it is decided elsewhere first.
      // A form the host keeps can be answered for as long as it is on screen, so the SDK keeps
      // listening as long as the connection lasts: the request's own deadline (requestApproval)
      // withdraws the question, and the connection closing ends the wait for an answer.
      { timeout: keeps ? MAX_TIMER_MS : runConfig(r.run_id).approval_timeout_s * 1000, ...(keeps ? {} : { signal }) },
    );
    const failed = (err: unknown): ElicitAnswer => {
      // An accepted answer that does not fit the form (the SDK checks it against the schema) is
      // not one a person could have given in the dialog: undecided, and not asked again.
      if (err instanceof McpError && err.code === ErrorCode.InvalidParams && /requested schema/.test(err.message)) {
        record("accept", "unqualified: left undecided");
        return { reading: "unattributed", outcome: "accept (unqualified)" };
      }
      const message = String((err as Error).message).slice(0, 120);
      record("error", message);
      return { reading: "error", outcome: message };
    };
    if (!keeps) {
      try {
        return answerOf(await question);
      } catch (err) {
        if (signal.aborted) {
          record("withdrawn", "decided elsewhere first");
          return { reading: "withdrawn", outcome: "withdrawn" };
        }
        return failed(err);
      }
    }
    // Whichever comes first: the answer, or the request being decided elsewhere.
    const withdrawn = new Promise<"withdrawn">((resolve) => {
      if (signal.aborted) resolve("withdrawn");
      else signal.addEventListener("abort", () => resolve("withdrawn"), { once: true });
    });
    const answered = question.then((res) => ({ res }), (err: unknown) => ({ err }));
    const first = await Promise.race([answered, withdrawn]);
    if (first !== "withdrawn") {
      return "err" in first ? failed(first.err) : answerOf(first.res);
    }
    record("withdrawn", "decided elsewhere first; the host keeps the form open");
    void answered.then((late) => {
      for (const [q, req] of questionOf) if (req === r.id) questionOf.delete(q);
      const cancelledAt = cancelSentAt.get(r.id);
      cancelSentAt.delete(r.id);
      if ("err" in late) return record("late", `the form ended without an answer (${String((late.err as Error)?.message).slice(0, 80)})`);
      if (acknowledgesCancel(late.res.action, cancelledAt, Date.now())) return record("late", "cancel acknowledging a cancellation relay sent: not an answer");
      // Nothing is decided by it either way, so a decline is reported too: it may well be the
      // person's, and they may expect it to have stopped something. Whose it is goes with it: a
      // decline relay does not take for a denial is the host's answer, which may not be anyone's.
      const { answer, logAs } = read(late.res);
      const said = late.res.action === "decline" ? "decline" : answer.reading === "decided" ? logAs[1] : null;
      if (!said) return record("late", `${logAs[1]} after it was decided elsewhere: nothing to report`);
      const by = answer.reading === "decided" ? "user" : "host";
      record("late", `${said}${by === "host" ? " (unattributed)" : ""} after it was decided elsewhere: changed nothing`);
      try {
        lateAnswer(r.id, said, by);
      } catch {
        // The registry is busy or gone; the answer is in the log.
      }
    });
    return { reading: "withdrawn", outcome: "withdrawn" };
  };

  return elicitThrough;
}
