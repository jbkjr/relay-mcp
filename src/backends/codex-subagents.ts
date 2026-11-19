/** Native subagents observed during one turn, keyed by thread rather than spawn/tool item id. */
export class CodexSubagents {
  private running = new Map<string, string>();

  /** Codex 0.163.0 ThreadItem/SubAgentActivityKind; both item notifications carry the kind.
   * item/completed with kind started completes the spawn action, not the subagent.
   * interacted (including a child's message to /root) says nothing about its liveness.
   */
  activity(item: unknown, root: string | undefined): void {
    const i = (item ?? {}) as { type?: unknown; kind?: unknown; agentThreadId?: unknown; agentPath?: unknown };
    if (i.type !== "subAgentActivity" || typeof i.agentThreadId !== "string" || !i.agentThreadId || i.agentThreadId === root) return;
    if (i.kind === "started") this.running.set(i.agentThreadId, typeof i.agentPath === "string" ? i.agentPath : i.agentThreadId);
    else if (i.kind === "completed") this.running.delete(i.agentThreadId);
  }

  /** The 0.163.0 binary's strings and type tables describe exec --json collab_tool_call,
   * not subAgentActivity; actual exec emission is unverified. See
   * docs/research/native-subagent-lifecycle.md. Its receiver_thread_ids
   * and agents_states expose thread ids and status, but no agentPath, so warnings name ids.
   * Completing the tool call alone does not complete a spawned agent; use its reported state.
   */
  collab(item: unknown, root: string | undefined): void {
    const i = (item ?? {}) as { type?: unknown; tool?: unknown; receiver_thread_ids?: unknown; agents_states?: unknown };
    if (i.type !== "collab_tool_call") return;
    if (i.tool === "spawn_agent" && Array.isArray(i.receiver_thread_ids)) {
      for (const id of i.receiver_thread_ids) {
        if (typeof id === "string" && id && id !== root) this.running.set(id, id);
      }
    }
    for (const [id, agent] of Object.entries(i.agents_states ?? {}) as [string, { status?: string }][]) {
      if (id === root) continue;
      if (agent?.status === "running" || agent?.status === "pending_init") this.running.set(id, id);
      else if (["completed", "interrupted", "errored", "shutdown", "not_found"].includes(agent?.status ?? "")) this.running.delete(id);
    }
  }

  warning(): string | undefined {
    if (!this.running.size) return undefined;
    return `Native subagents still running when the turn ended: ${[...this.running.values()].sort().join(", ")}. Relay stopped them when the turn ended; any changes they made are in the checkpoint but unfinished.`;
  }
}
