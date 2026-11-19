# relay's MCP server for stage-2 Codex turns, over authenticated HTTP (the broker): design

Status: **revision 2**, after cross-family plan review r_b52db760 (discussion d_6136aed5, Claude plus Codex Daybreak: fail, revise before building). The maintainer approved J1-J7 as recommended, subject to the review's items (§11). The disposition of every item is in §13. Written 2026-10-28, before the broker was built, on top of the C1+X2 fix (stage-2 app servers run with `CODEX_EXEC_SERVER_URL=none`). The broker shipped with stage 2 in relay 1.1.0 (`src/confine/broker-http.ts`, `src/confine/broker-core.ts`). This is the design as approved; where the code differs, the code and [pinned-codex.md](pinned-codex.md) describe what ships.

Inputs:
- [codex-confinement-design.md](codex-confinement-design.md) §2.2, §2.5, §5, §8, §10 (D1-D10), §13;
- review r_0c11d860 item C1+X2 and its fix (`STAGE2_APP_SERVER_ENV`, `stage2LocalProblem`, `stage2Readback`);
- review r_b52db760 (this revision);
- The maintainer's decision: stage 2 does not ship without relay's MCP tools;
- relay: `src/confine/broker.ts` and `peer.ts` (the ACP broker), `src/mcp/server.ts`, `src/core/context.ts`, `src/core/session.ts`, `src/core/session-token.ts`, `src/backends/types.ts` `relayServerCommand`, `src/backends/codex*.ts`, `src/confine/ports.ts`, `src/confine/seatbelt.ts`, `src/core/secrets.ts`;
- Codex 0.164.0 source at `/tmp/rcn-src/codex/codex-rs` (paths below are relative to it) and the installed `/opt/homebrew/bin/codex` 0.164.0.

Evidence labels:
- **verified (how)**: run on the maintainer's Mac (macOS 27.0.1, 26A434, arm64; Node 24.22.1), model-free, scratch `HOME`/`CODEX_HOME` under `/tmp/s2bk`, my own listeners on random high ports outside relay's range, a fake Responses server where a turn was needed. Scripts and logs: a research note (not published). Cases B1-B4 are revision 1's; B5-B7 and the `c-*` B1 cases are revision 2's (appendix).
- **from source (file:line)**: read, not run.
- **assumption**: neither.

The probes give the app server relay's own stage-2 flags (`codexFlags` with `stage2Plan`, from this checkout's `dist`) and `CODEX_EXEC_SERVER_URL=none`, with the HTTP entry this design proposes. The broker is a stand-in built on the MCP SDK relay already ships (1.32.1, `StreamableHTTPServerTransport`); its tools are an echo and a long sleep, not relay's.
- Revision 1's stand-in: standin-broker.mjs (not published).
- Revision 2's: standin-broker2.mjs (not published). It adds the pre-authentication front, the bounded peer checks with their positive control, tombstones, arming and the wildcard holders.

## 0. Decision in brief

1. **Transport: streamable HTTP.** Codex starts an HTTP MCP server with no `local` environment: "local HTTP is the one current exception" (`codex-mcp/src/runtime.rs:977-998`). Verified on 0.164.0 with relay's stage-2 flags (B1):
   - threadless and per-thread listings;
   - `mcpServer/tool/call`;
   - model-driven calls in direct and code mode;
   - a 75 s call.

   Codex cannot take a Unix socket for MCP (§2.3).
2. **Host: the relay worker running the turn.** This is what relay already does for confined ACP turns (`openBroker`, `src/confine/broker.ts`). It uses the same `relayServer(newInstance(ctx, cwd))`, with the context from the worker's own record. There is one instance per MCP session (§3).
3. **Placement: `127.0.0.1:M`.** `M` is a sixth port of the turn's lease in relay's reserved range, never `E` or in `B`. Every stage-2 profile refuses connecting to `M` (EPERM at 32 spellings) and binding it (B2).
   - **New (C2+X3):** for the turn's life relay also holds `0.0.0.0:M` and dual-stack `[::]:M`, and destroys every connection that arrives on them. Verified: no outside process can then bind any address that would catch Codex's connections to `127.0.0.1:M` (B6).
4. **Name: `relay_tools`, not `relay`.** relay's own Codex host registration makes `relay` unusable for an HTTP entry (B1 `user-relay`).
   - **New (C7+X4):** the name is exempt from relay-only's switch-off loop and from `configProblem`'s other-servers check. A `relay_tools` entry in the person's own config refuses the turn, because Codex merges TOML tables recursively and inherited fields would survive.
5. **Authentication, in a fixed order (new, C5+X1).** A raw `net.Server` holds each connection paused. The connections waiting for checks are bounded (16) and get a deadline (2 s) and a head cap (8 KiB).
   - **First,** the `Host`, `Origin` and bearer-token checks, which cost no process.
   - **Only for a token holder:** the kernel-side peer check (`lsof`). It runs through a bounded semaphore (2) and has a positive control: relay's own end of the connection must be listed.
   - **Only then** does the socket go to the HTTP server.

   Verified (B6): 300 slowloris connections and 300 wrong-token requests spawned no process; 40 right-token requests from another process ran at most 16 lookups, 2 at a time, and all were refused.

   The token still reaches the app server only through its environment (`bearer_token_env_var`). It is never in argv or a file, and never in a command's environment (B1, B7).
6. **Checker failure is fatal (new, X2).** An `lsof` error, timeout or missing own end is an operational failure. It fails the turn by the app-server-first path. A valid foreign-peer result gets 403 and is not fatal (verified, B6).
   - **`required = true`** on the entry, with connection readiness, read back. Verified: with it, Codex itself refuses to create the thread when the broker refuses at startup; without it, the thread and turn ran with the tools dead (B1 `c-req-wrong`, `c-noreq-wrong`, `c-req-lsofbad`).
7. **Armed only for relay's own turn (new, C1).** The broker refuses `tools/call` until `codex-app.ts` arms it, after relay's own `turn/start` has been answered, bound and read back. It disarms at relay's `turn/completed`. `initialize` and `tools/list` stay open for the readback. Verified with the stand-in (B1 `c-base2`).
8. **Sessions: tombstones, no 404, a cap that refuses (new, C4, C8).**
   - Every session id issued for the turn is tombstoned when it closes. A request on it gets a JSON-RPC error with HTTP 200, never 404, because 404 is what makes Codex replay a call.
   - The cap refuses and never evicts.
   - Measured (B5): 2 sessions per turn, plus one per subagent that uses relay's tools. v1's `close_agent` and v2's concurrency limit retire those, so the live count is at most 1 + Codex's subagent limit: 4 for v2 and 7 for v1 by default. relay pins those limits, and the cap is 8.
9. **Proxies:** `NO_PROXY`/`no_proxy` += `127.0.0.1` for the stage-2 app server. Without it Codex sent the bearer to an `HTTP_PROXY` (verified, B1).
10. **Lifetime.** The broker opens before the app server. It closes, wildcard holders included, only after the app server is dead. A broker lost mid-turn fails the turn like an executor exit.
11. **Fail closed.** No broker, no turn. A readback mismatch refuses the turn, as does a broker that never served an authenticated session from the app server.
12. **Impersonation is not closed; it is narrowed** (§6).
    - Confined processes can neither bind `M` nor reach it.
    - Outside processes can no longer pre-position while the turn lives.
    - What remains is the moment after relay's listeners close while the app server still lives. Teardown order keeps this window out of normal operation. A crash of relay's worker leaves a window of milliseconds (the app server exits 4 ms after its stdin closes, B4).
13. **No TLS on loopback** (§6).

Size: about 1,200-1,600 lines with tests, 5-6.5 working days sequential; about 2.5 days of wall-clock time in four packages (§12).

## 1. Why this is needed

On a resumed thread Codex can start a turn by itself before relay's `turn/start`, and relay's `turn/start` then steers into it (r_0c11d860 C1+X2). The agreed prevention removes `local` from stage-2 app servers (`CODEX_EXEC_SERVER_URL=none`, `STAGE2_APP_SERVER_ENV`).

Its cost: a stdio MCP server needs a local environment ("local stdio MCP server … requires a local environment", `codex-mcp/src/runtime.rs:995`). relay's own server is one, injected into every Codex child as `relay mcp --context <file>` (`src/backends/types.ts:494-508`). So stage-2 turns now run with relay's entry switched off (`src/backends/codex.ts:344`), and raw-network jobs are told they have no relay tools (`src/core/raw-network.ts`, the grant description in `src/mcp/server.ts`). This design restores the tools over a transport the job cannot reach.

## 2. Transport

### 2.1 What Codex 0.164 runs without `local`

- From source:
  - An MCP server's `environment_id` defaults to `local` (`config/src/mcp_types.rs:24, 552-553`).
  - `resolve_server_environment` refuses a stdio server without one, but returns `Ok(None)` for a streamable-HTTP one. That server then uses the app server's own HTTP client (`codex-mcp/src/runtime.rs:972-1000`, `resolve_http_client` and `http_client_for_server` 1008-1028).
- Verified (B1 `base`, relay's stage-2 flags, `CODEX_EXEC_SERVER_URL=none`):
  - `environment/status local` answered `unknown`.
  - `config/read` showed the entry without the token.
  - Threadless `mcpServerStatus/list` listed the tools, with `authStatus: "bearerToken"` and `httpOrigin: "http://127.0.0.1:<M>"`. It used one MCP session, which it ended with DELETE.
  - The thread connected (`startupStatus` went `starting`, then `ready`; `runtimeStatus: "connected"`).
  - `mcpServer/tool/call` worked.
  - No approval reached relay (`default_tools_approval_mode = "approve"`).
- Verified, model-driven (B1 `call-direct`, `call-codemode`):
  - Codex 0.164 defers MCP tools behind `tool_search`.
  - The fake model's `tool_search_call` returned the namespace `mcp__relay_tools`.
  - Its `function_call {namespace: "mcp__relay_tools", name: "status"}` reached the broker, and the output reached the model.
- Verified (B1 `long`): a 75 s call returned as one call, without a retry.
- `environment_id` must stay `local`, and the readback requires it. A non-local id would route the server's HTTP through that environment's client, the executor's, inside relay's profile. It would also have the executor resolve the token variable from the job's environment (`codex-mcp/src/rmcp_client.rs:1381-1407`).

### 2.2 Authentication options and where each secret lives

| Option | Where the secret is | Verdict |
|---|---|---|
| `bearer_token` (inline) | — | Rejected by Codex for HTTP (`config/src/mcp_types.rs:525`) |
| `-c …http_headers.Authorization=…` | **argv**, readable by every local user (verified: `ps` shows other users' daemons' arguments) | Rejected |
| `http_headers` in a config file | the person's `~/.codex/config.toml`, or a project `.codex/config.toml` the job can write | Rejected |
| `bearer_token_env_var = "RELAY_BROKER_TOKEN"` | the **app server's environment**. Read at each connect (`codex-mcp/src/rmcp_client.rs:956-988`). A token also switches off Codex's OAuth lookup and its ChatGPT auth provider for the server (`rmcp-client/src/rmcp_client.rs:1151-1160`) | **Chosen (J1).** Verified: works threadless and per thread; a missing variable means no connection; a wrong token gets 401 and no tools |
| `env_http_headers` | the app server's environment (`rmcp-client/src/utils.rs:103-159`) | Works (B1 `env-header`); no advantage |
| `http_headers_helper` | an unsandboxed `sh -c` in the turn's cwd, the job's worktree (`rmcp-client/src/http_headers.rs:430-458`) | Rejected: a new unconfined spawn |
| OAuth | keyring or `CODEX_HOME/.credentials.json` | Rejected |
| `thread/start`/`thread/resume` `config` override | memory, over stdin (`app-server-protocol/src/protocol/v2/thread.rs:100, 410`) | Works per thread (B1 `thread-header`). But the threadless listing then has no credential: Codex probes 8 OAuth discovery URLs and gets 401s, and the tool readback must wait for the thread. Not chosen (J1) |

### 2.3 Unix sockets

Not available. Codex's streamable-HTTP client sends through reqwest to an `http(s)` URL (`codex-mcp/src/runtime.rs:1008-1028`, `rmcp-client/src/http_client_adapter.rs`). The `uds` and `stdio-to-uds` crates bridge stdio, which needs `local`.

### 2.4 Retries, and why the broker never answers 404

From source:
- `initialize` is retried twice (`rmcp-client/src/streamable_http_retry.rs:24, 36-41`).
- `tools/list` is retried on transient errors (`rmcp-client/src/rmcp_client.rs:1538-1552`).
- A tool call is retried only when its POST gets **HTTP 404**, which Codex reads as session expired. It then initializes again and **replays the call** (`rmcp-client/src/rmcp_client.rs:1440-1452`).

So the broker never sends 404 (C4):
- A request on a session it has closed gets HTTP 200 with a JSON-RPC error ("this relay session is closed", `-32001`). The closed session's id is tombstoned.
- A request on an id it never issued gets the same, as does an `initialize` beyond the cap.
- A turn that ended gets `TURN_ENDED`.

Verified with the stand-in (B6 §1b): cap 2, then a third `initialize` got 200 with an error; the first session still answered (no eviction); after DELETE, `tools/list` on its id got 200 with an error; a never-issued id got 200; a new `initialize` was then admitted. Verified (B4): after the broker closed, one tool call made one POST and no second.

## 3. Where the endpoint lives

### 3.1 Today

- **Stdio.** Each Codex child gets `relay mcp --context <turn file>`. `loadContext` (`src/core/context.ts:110-160`) requires that the environment, the worker-written context file in relay's control directory and the registry agree. Authentication is holding the pipe.
- **The ACP broker.** relay already serves its tools to confined harnesses from the worker, on a Unix socket, with:
  - a per-turn secret;
  - the kernel's `LOCAL_PEERPID`, checked against the pinned harness (core review C21);
  - every message gated on `turnRefusal`;
  - one `relayServer(newInstance(ctx, cwd))` per connection, with `ctx` from the worker's record (`turnContext`).

### 3.2 Options

| | A. The worker running the turn (chosen) | B. A dedicated child (`relay mcp --http`) | C. The root process |
|---|---|---|---|
| Context | the worker's own record (`turnContext`) | `loadContext` from env and file | the root's view |
| Lifetime | the worker already orders the turn's teardown | its own supervision | outlives turns |
| Crash containment | a broker fault can take the turn's worker down (accepted for ACP) | isolated | hits every conversation |
| New code | an HTTP front on the existing core | process, readiness, its own auth | cross-process turn binding |

### 3.3 Binding to one turn and one child identity

- **What relay already records.** `spec.relay` holds `{runId, nodeId, depth, turnId, mayDelegate, mayAsk}` (`src/core/session.ts:254-260`). The worker builds it for this turn alone, and only when the turn may delegate. Without it there is no broker, no entry and no tools.
- **The broker is built from that record** (`BrokerTurn`). Its context is `turnContext(turn)`, read from the registry.
- **Each connection** passes the front in order (§5.5): the `Host`, `Origin` and token checks, then the bounded peer check against the pinned app server.
- **Each request** passes the token, `Host` and `Origin` checks again, because a keep-alive connection carries later requests, and then `turnRefusal(turn)`.
- **Arming (C1).** A turn that Codex starts by itself (a goal's continuation, a queued message) runs before relay's `turn/start`. HTTP MCP needs no environment, and `turnRefusal` already passes once the registry marks relay's turn running. Without arming, such a turn could call relay's tools, `delegate` included, before `Stage2TurnGuard`'s kill lands. So:
  - The broker starts **disarmed**: `tools/call` gets the JSON-RPC error "relay's turn has not started" (`-32001`). `initialize` and `tools/list` are served, which the readback needs.
  - `codex-app.ts` calls `broker.arm()` only after three things: relay's own `turn/start` has been answered with a turn id, `stage2TurnReadback` has shown the thread bound to relay's executor alone, and the guard has seen no other turn.
  - It calls `disarm()` at relay's `turn/completed` and at teardown.
  - Subagents spawned in relay's turn call through the same broker while it is armed (B5).
  - Verified with the stand-in: `mcpServer/tool/call` before `arm()` got the error, and after it worked; the model-driven call after arming worked (B1 `c-base2`).
  - The confinement design's §2.2 says so too (updated in this revision).
- **One instance per MCP session.** Each `Mcp-Session-Id` gets its own `relayServer(newInstance(ctx, cwd))`, as each stdio process and each ACP connection had. Instances are keyed by session, not TCP connection: Codex spreads a session over several connections.
- **Sessions per turn (C8), measured** with the stand-in, model-free, multi-agent v2 (the fixture model) and v1 (the same model in direct mode), 3-6 subagents one after another, then a resume in a second app server (B5):

  | | v1 (`close_agent` after each) | v2, 3 subagents | v2, 6 subagents |
  |---|---|---|---|
  | Readback listing | 1, closed (DELETE) before the thread starts | same | same |
  | Thread | 1 | 1 | 1 |
  | Subagents | 1 each, opened when the subagent first uses relay's tools (none if it never does), closed by `close_agent` | 1 each, kept | 1 each; v2 closes earlier ones at its concurrency limit |
  | Peak live | 2 | 4 | 4 |
  | Resumed turn (app server B) | readback 1 (closed) + thread 1 + 1 for the new subagent | same | same |
  | On graceful exit | every live session DELETEd | same | same |

  So the live count is at most 1 (thread) + the live subagents that used relay's tools. Codex 0.164 has one canonical key, `agents.max_concurrent_threads_per_session` (legacy alias `agents.max_threads`), default 6 subagents. v2 derives that value + 1, counting the parent, unless `features.multi_agent_v2.max_concurrent_threads_per_session` overrides it. From source: `core/src/config/mod.rs:256-257, 1687-1700, 2840-2850`.

  So relay **pins only `agents.max_concurrent_threads_per_session = 6`** in the stage-2 flags and reads it back; it does not set the legacy alias or a v2 override. This permits at most 6 subagents and 7 broker sessions (the parent included). The cap is **8 live sessions**, allowing one more for the readback's overlap. Beyond it the broker refuses and never evicts. Over a turn, more sessions than the cap may open (8 in the v2 run with 6 subagents), because closed ones are tombstoned and no longer count.
- **Tool set and tokens, identical to stdio.**
  - Tools: those of `relayServer` with this turn's `mayDelegate` and `mayAsk`.
  - Codex's settings for the server: `default_tools_approval_mode = "approve"`, `tool_timeout_sec = codexToolTimeoutS(approval_timeout_s)`, `startup_timeout_sec = 30`, and new, `required = true`.
  - Each instance gets a fresh owner token (`newInstance`), as each stdio process did.
  - relay's conversation tokens (`rs1_…`) stay root-only.
  - Not applicable: the extension gateway (stage 2 refuses extension servers) and `registerSelf("server")`.

### 3.4 Lifetime

- **Opening.** After admission and the lease, before the executor and the app server.
- **During the turn.** Disarmed until relay's turn is bound, armed for it, disarmed at its end.
- **Closing.** In teardown, after the app server has been killed and reaped:
  1. refuse everything;
  2. destroy pending and live sockets;
  3. close the listener and both wildcard holders;
  4. release the lease.
- **No broker.** A stage-2 turn whose `spec.relay` is null opens none.

### 3.5 Nested delegation

- `delegate`, `ask`, `discuss` and `review` run in the worker, as from an ACP child: new nodes under the child, workers started detached with `workerEnvironment(runId)` (`src/core/dispatch.ts:46`).
- A launched agent's grants are refused or narrowed by `checkGrant`. `raw_network` is person-only, so a stage-2 child cannot pass raw network down.
- Cancel and turn end reach the broker through `turnRefusal`, and from teardown through `disarm`.
- Long waits are a POST answered on an SSE stream; the 75 s probe held.

## 4. Network placement

### 4.1 Where

- **Addresses.** `127.0.0.1:M` serves, bound with `exclusive: true`. `0.0.0.0:M` and dual-stack `[::]:M` are held for the turn's life and serve nothing: a connection there is destroyed on arrival (C2+X3).
- **The port.** `M` is a sixth port of the turn's lease (`leaseTurnPorts`, `src/confine/ports.ts`). It is not `exec`, not in `block`, and is free under the lease's `busy` test.
- **Not in any profile's allows.** Every stage-2 profile has `M` in its `relayRange` deny and never in `EXEC_PORT` or `BIND_PORT_m`.

### 4.2 Who can reach, bind or squat it

| Who | Reach `M` | Bind `M` | Evidence |
|---|---|---|---|
| This stage-2 job's commands (write or read turn) | EPERM at all 32 spellings (127.0.0.1, ::1, localhost, 0.0.0.0, ::, v4-mapped and v4-compatible forms, fe80::1%lo0, every interface address) | EPERM on 127.0.0.1, 0.0.0.0, ::1, :: | verified, B2, under `seatbeltProfile` from dist |
| Another stage-2 turn's job | the same rule | the same | verified by construction (same generator, `M` a range parameter) |
| Codex jobs: strict network, no network | no (Codex's proxy refuses loopback; no network) | no | from source and 1.0.5 |
| Codex local mode | could, through its proxy | — | refused while stage 2 is on, and interlocked |
| Claude jobs | no: relay's public-only proxy never dials loopback (`src/confine/proxy.ts:110-115`); `allowLocalBinding: false` | no | from source |
| Gemini, Copilot, Grok | no: `NETWORK_ON` denies `(remote ip4 "localhost:*")` and allows no IPv6; the proxy is public only when network is off | no | from source |
| Unconfined processes, any local user | yes, but the front refuses before any process spawns: 401 for the token, 421 for `Host`, 403 for `Origin`; for a token holder, 403 from the peer check | **no address that catches Codex's connections**: 127.0.0.1, 0.0.0.0 and `[::]` (dual-stack or v6-only) and `::ffff:127.0.0.1` all EADDRINUSE under every `SO_REUSEADDR`/`SO_REUSEPORT` combination; `::1` and the LAN address can be bound, but Codex connects only to `127.0.0.1` | verified, B6 |
| A browser page | can send, but cannot set `Authorization` without a preflight, which is never granted; `Origin` is refused | — | from the design; `Origin` refusal verified (B6) |

### 4.3 The snapshot and the range

- **The snapshot.** It denies every listener seen at turn start except reserved-range ports (`deniedTcpPorts`), which `relayRange` covers. It is taken after the lease and before the broker opens. A listener already on `M` refuses the turn, as for `exec` and `block`.
- **The range.** Six ports per turn: about 10 concurrent stage-2 turns in 64 ports (J3: keep 64).

## 5. Authentication

### 5.1 The credential

- **Making it.** 32 random bytes in hex, made in the worker's memory and registered at once (`registerTurnSecret(token, "broker token")`).
- **Where it goes.** It reaches the app server only, as `RELAY_BROKER_TOKEN` in `Stage2Session.env`, beside `CODEX_EXEC_SERVER_URL=none`, and is frozen with it.
- **Admission** refuses a `RELAY_BROKER_TOKEN` already in the person's environment.
- **Verified absences:**
  - not in argv;
  - not in any file under the scratch `CODEX_HOME` (sqlite and WAL, state, rollouts), TMPDIR or stderr, at `RUST_LOG=warn` and at `trace`, with a working and a refused token (B1);
  - **not in a stage-2 command's environment (C6, verified, B7).** The app server had `RELAY_BROKER_TOKEN` and a canary, and the executor had its own canary. `env`, run three ways (`exec_command`, `exec_command` with a terminal, `exec_command` nested in code mode's `exec`), showed neither the token's name nor its value nor the app server's canary, and did show the executor's canary.

  From source: for a remote executor, Codex sends only the variables of its request environment that differ from the app server's own policy environment (`core/src/unified_exec/process_manager.rs:176-195`). For unified exec it always builds that configuration (1480-1500). The full environment would go only on a path without it (`exec_server_env_for_request`, 213-215). So the property depends on Codex's code, and both the qualification (§7.2 item 20) and the release watch carry it.

### 5.2 Who can read the app server's environment

| Reader | Result | Evidence |
|---|---|---|
| An unconfined process of the same user | yes | verified (B1, B2 baseline) |
| A stage-2 job under relay's profile | no: `sysctl KERN_PROCARGS2` EPERM; `ps eww` nothing | verified (B2); `(deny process-info*)` and no `kern.procargs2` sysctl in relay's profile (`src/confine/seatbelt.ts:102-103, 116-141`) |
| A Codex job under Codex's own Seatbelt | no | from source (`sandboxing/src/seatbelt_base_policy.sbpl:16, 24-75`) |
| Claude Code's sandbox | unknown | assumption; it cannot reach `M` anyway |
| Another local user | no | verified indirectly (setuid `ps` showed other users' arguments, not their environments). Assumption that XNU limits `KERN_PROCARGS2` to the same uid |
| The app server's children (code-mode host, git for thread info) | yes, inherited | from source (`core/src/code_mode_host.rs:91-102`, `protocol/src/shell_environment.rs:14-21`); the same trust as the app server |
| A stage-2 command (executor) | no | verified (B7) |

The same-user unconfined reader is outside relay's boundary anyway. The peer check makes the token useless from any process but the app server.

### 5.3 A file-based token

Codex has no bearer-token file. The routes from a file are an unsandboxed header helper in the job's worktree, or a config file. Rejected (§2.2).

### 5.4 The in-memory alternative

This is `thread/start`/`thread/resume` config over stdin. Not chosen (J1); costs in §2.2.

### 5.5 The front, and the peer check (C5+X1, X2)

Revision 1 started `lsof` for every TCP connection before reading the token, a process-spawn surface any local user could flood. The front now runs in a fixed order. Each step is bounded, and the steps that cost nothing come first.

1. **Accept, held paused.** A raw `net.Server` on `127.0.0.1:M` (`pauseOnConnect`). At most 16 connections may wait for their checks. Beyond that, a new connection is destroyed at once, before anything is read. A connection whose local address is not `127.0.0.1` is destroyed.
2. **Read the request head** with a 2 s deadline and an 8 KiB cap, and nothing more. A connection that sends nothing is dropped at the deadline; a larger head gets 431.
3. **Check `Host`, `Origin` and `Authorization`,** with no process and in constant time for the token. `Host` must be exactly `127.0.0.1:M` (421), with no `Origin` (403) and the turn's bearer (401). A duplicated header refuses.
4. **Peer check, for token holders only,** through a semaphore of 2. The command is `/usr/sbin/lsof -nP -iTCP@127.0.0.1:<client port> -F pn`, with a fixed path, a scrubbed environment and a 2 s timeout per invocation. An operational failure gets one fresh lookup; both attempts share an absolute 4.5 s deadline, including callback/reap overhead. The semaphore is held across the retry. The result is one of three:
   - **ok:** lsof lists relay's own end (`127.0.0.1:M->127.0.0.1:<client port>`, owned by relay's pid) and the client end (`127.0.0.1:<client port>->127.0.0.1:M`) owned by the pinned app server.
   - **foreign:** relay's own end is listed, and the client end belongs to another pid or is not visible (another user's process). The connection gets 403, it is logged, and it is not fatal.
   - **operational failure:** lsof could not run, timed out or failed, or **relay's own end is missing**. That end is the positive control for a live connection. After the bounded retry fails, the connection gets 503 and the broker calls `onFatal`, which fails the turn the executor-exit way: kill the app server first, then fail (§7.1). The fatal diagnostic includes each attempt's exit code, signal and a redacted, bounded stderr excerpt. An empty exit 1 (no stdout, stderr, signal or timeout) when the socket is already destroyed or ended means the client went away: drop that connection without failing the turn. Partial stdout never qualifies for this exception.
5. **Hand over.** The bytes already read are put back (`unshift`), and the socket goes to the HTTP server (`emit("connection")`). That server checks token, `Host` and `Origin` again on every request.

The pinned app server is fixed by pid and start time after spawn and before `initialize` (`bindAppServer`, as `bindHarness`), and re-checked with `sameProcess` after each lookup.

Verified (B6, the stand-in with the app server's place taken by the probe process):

| Case | Result |
|---|---|
| 300 connections sending nothing, at once | **0 lsof**. 16 held to the 2 s deadline, 115 destroyed at once by the cap, all gone in 2.01 s. The rest were never accepted (assumption: the kernel's listen backlog; not recorded) |
| 300 wrong-token requests | 300 × 401, **0 lsof** |
| Right token with a wrong `Host`, or with `Origin` | 421, 403 (0 lsof) |
| Head over 8 KiB | 431 |
| 40 right-token requests from another process, at once | 16 lookups (the pending cap), **at most 2 at a time**, 16 × 403, 24 refused by the cap; 428 ms; 0 operational failures |
| Right token from the pinned peer | 200 (`initialize` served) |
| lsof that hangs (5 s) | 503 at the 2 s timeout, `onFatal` |
| lsof missing | 503, `onFatal` |

Verified with Codex through the revised front (B1 `c-base2`): every connection passed, at about 50 ms per lookup (4 lookups for the readback and the thread); the model-driven call worked. With a missing lsof, Codex could not connect, and `required` made it refuse the thread (`c-req-lsofbad`, below).

**Readiness (X2).**
- The entry carries `required = true` with `startup_readiness` "connection", Codex's default.
- The readback requires `required: true`, with `startup_readiness` either absent (the default) or "connection". With `catalog`, Codex could serve a cached tool list without a live connection.
- Verified: `config/read` shows `required: true`.
  - With the broker refusing at startup (wrong token, or a broken checker), `thread/start` failed: "error creating thread: Fatal error: Failed to initialize session: required MCP servers failed to initialize: relay_tools: …".
  - Without `required`, the thread started, the server read `failed`, and the turn completed with tools that could not be used (B1 `c-req-wrong`, `c-req-lsofbad`, `c-noreq-wrong`).
  - A resume worked with it (B5).
- `required` acts when a session is created. Mid-turn, relay's own fatal path (operational checker failure, lost listener) carries it. Assumption that `required` does nothing after startup; not probed.

### 5.6 Binding the credential to the turn

- One token per turn: each stage-2 turn has its own app server and broker.
- The broker refuses once `turnRefusal` is non-null or teardown has begun.
- `tools/call` is refused while disarmed.

### 5.7 Redaction

`registerTurnSecret` at creation. Codex's startup errors quote the broker's reply body, never the request headers. Refusal bodies and logs hold only a reason word.

### 5.8 Proxies

reqwest's default proxy handling applies `HTTP_PROXY`/`ALL_PROXY` to `http://127.0.0.1`. Verified (B1 `proxy`): the bearer went to a decoy proxy. The fix, `NO_PROXY`/`no_proxy` += `127.0.0.1`, was verified (`proxy-noproxy`). `features.respect_system_proxy` stays off and is read back. The review dropped C3: the system-proxy fallback is not on the MCP path. So the `scutil --proxy` admission check of revision 1 is dropped too.

## 6. Impersonation

Not closed; narrowed (C2+X3).

- **A confined process cannot stand up a fake broker.**
  - It cannot bind `M` on any family (EPERM, B2).
  - It cannot signal relay's worker: relay's profile allows `signal` only to the same sandbox (`src/confine/seatbelt.ts:96-99`).
  - It cannot be on the path, because the app server goes direct (§5.8).
- **An outside process cannot pre-position while the turn lives.** Revision 1 held only `127.0.0.1:M`. An outside process could bind `0.0.0.0:M` or `[::]:M` beside it, receive nothing while relay listened, and be first in line for Codex's reconnect after relay closed (B3). Relay now holds all three for the turn's life. Every bind that would catch a connection to `127.0.0.1:M` fails with EADDRINUSE under every `SO_REUSEADDR`/`SO_REUSEPORT` combination (B6). A connection arriving on a wildcard holder is destroyed.
- **What remains: the moment after relay's listeners close while the app server still lives.** Codex reconnects its event stream within 1 ms of the broker closing, and again at 2 s, carrying the token (B4).
  - In normal teardown the app server is killed and reaped first, so nothing reconnects.
  - If relay's worker crashes, its listeners close at once. The app server's stdin closes too, and it exits 4 ms later (B4).

  An outside process able to bind in those milliseconds would receive a dead turn's token and could answer one request of a dying app server. Stated as a residual (§9).
- **How the app server could tell.** It cannot: Codex authenticates no MCP server over plain HTTP. relay tells instead:
  - it holds the three binds for the turn's life;
  - the readback requires the broker's own record of the authenticated, peer-verified session behind the listing;
  - the broker logs every refusal.
- **TLS: no (J7).**
  - Sniffing lo0 needs root here (`/dev/bpf*` 0600 root).
  - A CA the app server would have to trust also covers its model traffic.
  - The attack it would stop is the window above, which TLS would close only if the app server checked a per-turn pin it has no way to receive.

## 7. Failure modes

### 7.1 Fail closed

| When | relay's response |
|---|---|
| No room for 6 ports in the lease | refuse the turn |
| `127.0.0.1:M`, `0.0.0.0:M` or `[::]:M` cannot be bound, or the snapshot sees a listener on `M` | refuse (or lease once more) before anything starts |
| `lsof` fails its self-check at open (a lookup of one of relay's own connections) | refuse |
| The person's environment has `RELAY_BROKER_TOKEN`; the person's config defines `relay_tools` (C7+X4) | refuse at admission |
| `config/read`: `relay_tools` is not exactly relay's entry | refuse. Required: `url`, `bearer_token_env_var = "RELAY_BROKER_TOKEN"`, `environment_id = "local"`, `enabled = true`, `required = true`, `startup_readiness` absent or "connection", `default_tools_approval_mode = "approve"`, relay's two timeouts, and no other auth or tool-filter keys. Also: `relay` off, every other server off, and `agents.max_concurrent_threads_per_session = 6` |
| Threadless `mcpServerStatus/list` (still last in the readback) is not exactly the broker | refuse. Besides servers shown off, only `relay_tools`, with no `pluginId`, the expected `httpOrigin`, `bearerToken`, no `toolsError`, and the tool names of `broker.listTools()` |
| The broker served no authenticated, peer-verified session for that listing | refuse |
| `thread/start` or `thread/resume` fails ("required MCP servers failed to initialize") | fail the turn (the app server is not used) |
| After the thread: the per-thread listing is not `connected` with the same tools, or the broker saw no thread session | kill the app server, fail the turn |
| **Peer checker operational failure** (X2) | kill the app server first, fail the turn |
| A foreign peer, bad token, `Host` or `Origin` | 401, 403 or 421; logged; not fatal |
| Pending connections full; head deadline | destroy; not fatal (§9: local DoS fails the turn closed at the next connection) |
| `tools/call` while disarmed | JSON-RPC error; logged |
| A closed or unknown session; the cap | HTTP 200 JSON-RPC error, never 404; the cap never evicts |
| The listener or a wildcard holder ends unasked | kill the app server first, fail the turn |
| Teardown | kill and reap the app server, disarm, refuse, destroy sockets, close the three listeners, release the lease |

### 7.2 Qualification additions (WP-F)

14. **HTTP without `local`.** The entry and its readback (`required` included); the threadless and per-thread listings; `mcpServer/tool/call`; model-driven calls in direct and code mode; a call of at least 75 s.
15. **Credentials and the front.**
    - Missing variable: no connection.
    - Wrong token: 401, no lsof.
    - Foreign peer: 403.
    - Broken checker: fatal.
    - With `required`, the thread refuses on each failure.
    - The token in no argv or file.
16. **Name.** The person's stdio `relay` beside `relay_tools`. The person's own `relay_tools` refuses at admission.
17. **Proxy.** With `NO_PROXY`, nothing reaches a decoy proxy; without it (negative control), the bearer does.
18. **Reconnect and EOF.** Codex reconnects with the token after the broker closes (recorded, so that a change is noticed). The app server exits on stdin EOF within 1 s.
19. **No 404.** Codex replays a tool call only on 404. Codex does not replay on the broker's 200 JSON-RPC errors (tombstone, cap).
20. **(C6)** A stage-2 command's environment, run through relay's real executor path, lacks `RELAY_BROKER_TOKEN` and its value. Run as `exec_command`, `exec_command` with a terminal, and nested in code mode (B7 shape).
21. **(C1)** A turn Codex starts by itself on resume (a goal's continuation with goals switched back on, as F item 11's control does) calls relay's tool. The call is refused while disarmed.
22. **(C8)** The session counts of §3.3 for v1 and v2, under relay's pins.

Items 3, 10 and 11 change to expect exactly `relay_tools`, and the tool allowlist (§8.6). Release-watch surfaces to add:
- `core/src/unified_exec/process_manager.rs` (C6: the environment overlay sent to the executor);
- `codex-mcp/src/runtime.rs` (already listed);
- `codex-mcp/src/rmcp_client.rs`;
- `rmcp-client/src/rmcp_client.rs` (auth precedence, the 404 replay);
- `rmcp-client/src/streamable_http_retry.rs`, `utils.rs`, `http_client_adapter.rs`;
- `http-client/src/outbound_proxy.rs` and `core/src/config/mod.rs` (`http_client_factory`, subagent limits);
- `codex-mcp/src/connection_manager/tool_catalog.rs` (`required`);
- `app-server-transport/src/transport/stdio.rs` (EOF);
- `config/src/merge.rs`;
- `core/src/code_mode_host.rs`.

### 7.3 Red-team additions

- **From a stage-2 job:**
  - scan the range, at every spelling, for `M`;
  - bind `M`;
  - read the token (`ps`, `sysctl`, `proc_pidinfo`, logs, TMPDIR, worktree, the job's own `env`);
  - signal the worker;
  - start a turn by itself (a goal, a queued message) and call `delegate` before relay's turn.
- **From another stage-2 turn's job:** the same.
- **From non-stage-2 jobs (all families):** reach `M`.
- **Unconfined, from a scratch process:**
  - flood the front (idle, wrong token, right token from elsewhere) and check that no unbounded process spawn follows and that the turn fails closed, not open;
  - pre-position on every address family;
  - kill the app server and squat after relay closes;
  - try a browser-shaped request.
- **Through the model:** relay's tools asked for authority the turn lacks.

## 8. The rest of stage 2 that this touches

### 8.1 D10

Unchanged. A job may bind `E` when the executor is not holding it (B2: the profile must allow the executor's own bind). That is why `M` is never `E` or a block port.

### 8.2 The snapshot denylist

Order: lease, snapshot (refuse if `M` is taken), broker.

### 8.3 The reserved range

Six ports per turn; J3 keeps 64. The wildcard holders use the same port number, so they cost no range ports.

### 8.4 Interfaces (who owns what: §12)

- **`src/confine/broker.ts`.** Split into a core (`BrokerTurn`, `turnRefusal`, `turnContext`, the per-session server factory) and two fronts: the existing Unix one, unchanged, and a new `src/confine/broker-http.ts`:
  ```ts
  export const BROKER_SERVER_NAME = "relay_tools";
  export const BROKER_TOKEN_ENV = "RELAY_BROKER_TOKEN";
  export const BROKER_SESSION_CAP = 8;          // parent + 6 subagents + readback overlap; canonical limit pinned (§3.3)
  export interface HttpBroker {
    url: string;                                   // http://127.0.0.1:<M>/mcp
    env: Readonly<Record<string, string>>;         // { RELAY_BROKER_TOKEN }, registered as a turn secret
    bindAppServer(p: Proc): void;                  // once, after spawn, before initialize
    arm(): void; disarm(): void;                   // tools/call only while armed (C1)
    sessionsServed(): number;                      // authenticated, peer-verified sessions so far (readback evidence)
    listTools(): Promise<Tool[]>;
    onFatal(fail: (why: string) => void): void;    // checker failure (X2), a listener or holder lost
    close(): Promise<void>;                        // teardown, after the app server is gone
  }
  export function openHttpBroker(turn: BrokerTurn, port: number, o?: { onRefusal?(why: string): void; peer?: TcpPeerCheck }): Promise<HttpBroker>;
  ```
- **`src/confine/peer.ts`.** `tcpPeerLookup(appProc, sock): Promise<"ok" | "foreign" | { error: string }>`, with relay's own end as the positive control, beside `socketPeer`.
- **`src/confine/ports.ts`.** `PortLease.broker`. `deniedTcpPorts` refuses a listener on it.
- **`src/backends/codex-env.ts`.**
  - `openStage2` opens the broker when `spec.relay` is set.
  - `Stage2Session.env` = `stage2AppServerEnv(checked)` + `broker.env` + the `NO_PROXY` merge.
  - New hooks: `bindAppServer`, `threadMcpProblem`, and `armTools`/`disarmTools`.
  - `watch` adds `broker.onFatal`; `teardown` closes the broker after the app server.
- **`src/backends/codex-stage2.ts`.**
  - `Stage2Plan.broker`.
  - The pin: `agents.max_concurrent_threads_per_session = 6`, read back under that canonical key; v2 derives 7 including the parent, with no separate override.
  - `stage2Readback(rpc, eff, cwd, broker?)`: the exact entry with `required`, the listing, and the broker evidence.
  - `mcpListProblem` admits only `relay_tools`.
  - Admission refuses `RELAY_BROKER_TOKEN` in the person's environment and a `relay_tools` in the person's config (C7+X4).
- **`src/backends/codex.ts`.**
  - `codexFlags` keeps `relay` off and sets `relay_tools` from `plan.broker`, `required` included.
  - **The relay-only loop skips `BROKER_SERVER_NAME` as well as `relay`** (C7+X4): today it would switch off a `relay_tools` that `codex mcp list` names.
  - `Expected.broker`.
- **`src/backends/codex-app.ts`.**
  - `configProblem` checks `expect.broker`. **Its relay-only check of other servers exempts `BROKER_SERVER_NAME`** (C7+X4).
  - After the spawn: `stage2.bindAppServer`.
  - After `thread/start` or `thread/resume`: `stage2.threadMcpProblem`.
  - After relay's `turn/start` reply and `stage2TurnReadback`: `stage2.armTools()`.
  - At `turn/completed`: `stage2.disarmTools()`.
- **`src/core/secrets.ts`.** The kind "broker token".

### 8.5 Texts this reverts

`RAW_NETWORK_TURN_NOTE`'s no-tools sentence, the `raw_network` grant description, and the preamble note in `src/core/prompts.ts`.

### 8.6 The tool allowlist

`STAGE2_TOOLS` admits `tool_search` (already listed) and the namespace `mcp__relay_tools` with exactly the broker's tool names.

### 8.7 Non-stage-2 turns

Unchanged. `test/stage2-skeleton.test.ts` asserts that with the switch off there is no lease, broker or variable.

## 9. Risks, residuals and known limits

1. **The same-user unconfined reader** sees the token in the app server's environment. It is useless off the app server.
2. **The squatter window** at a worker crash, a few milliseconds (§6).
3. **Local denial of service.** An outside process can keep the 16 pending slots full, or answer the app server's connections faster than lsof. The app server's connection is then refused. At startup `required` refuses the thread; mid-turn the tool call fails. Either way it fails closed and never open. It needs an unconfined local process (a confined job cannot connect).
4. **The app server's children** inherit the token (§5.2).
5. **Codex behaviour per release:**
   - the overlay of C6;
   - `required` at startup;
   - the reconnect;
   - the 404 replay;
   - the subagent session pattern.

   Items 14-22 cover them.
6. **A worker fault in the broker** fails that turn, as for ACP.
7. **Known limit (from the C1+X2 fix, recorded here as the review asked).** Codex's `skills/list` cannot see repository skills without `local`: it reads them through the default environment, which no longer exists. relay's own scan (`codexSkillFiles`) still switches off every repository skill it finds, but the readback (`skillsProblem`) no longer double-checks before the prompt. A repository skill in a place relay's scan misses would reach the model as instructions (its scripts still run only in the executor). This is policy only: no new authority, and the broker does not change it.

## 10. Open questions

1. Mid-turn, does `required` do anything after the session exists? Not probed; relay's own fatal path carries mid-turn failures.
2. Other local users and `KERN_PROCARGS2`: confirm directly on a Mac with a second, scratch account.
3. Is lsof's ~50 ms per connection acceptable under real models? It ran 4 times per probe turn, plus once per subagent that used relay's tools (B5). A compiled helper is the fallback (J5).
4. Codex's subagent limits, if a release changes their keys or meaning: the readback refuses on an unread pin, and items 22 and the release watch notice.

## 11. Decisions for the maintainer

The maintainer approved J1-J7 as recommended (2026-10-28), subject to the review's items. They are restated with what revision 2 changed in each:

| # | Decision | Revision 2 |
|---|---|---|
| J1 | The token in the app server's environment (`bearer_token_env_var`), with the peer check | The peer check runs only for token holders and is bounded (C5+X1); C6 verified that commands do not inherit the token |
| J2 | Name `relay_tools` | Exempt in relay-only and `configProblem`; a person's own `relay_tools` refuses (C7+X4) |
| J3 | Keep 64 ports | Unchanged (the wildcard holders reuse `M`) |
| J4 | `NO_PROXY += 127.0.0.1` | The system-proxy refusal is dropped (C3 dropped) |
| J5 | `lsof` now | Two pids per lookup, with relay's own end as the positive control; bounded concurrency |
| J6 | A broker lost mid-turn fails the turn | Extended to checker failures (X2) and to a lost wildcard holder |
| J7 | No TLS | Unchanged |

New, for the scope review rather than a new decision: the stage-2 flags pin only Codex's canonical `agents.max_concurrent_threads_per_session = 6` and read it back. The legacy `agents.max_threads` is an alias of the same key, not a second limit. v2 derives 7 including the parent unless `features.multi_agent_v2.max_concurrent_threads_per_session` is set; relay sets no v2 override. Stage-2 turns therefore allow at most 6 subagents and 7 broker sessions, within the cap of 8.

## 12. Estimate and work packages

About 1,200-1,600 lines with tests; 5-6.5 working days sequential; about 2.5 days of wall-clock time in four packages.

| Package | Scope | Owns | Size |
|---|---|---|---|
| **BA** HTTP broker | Core/front split of broker.ts. `broker-http.ts`: the pre-authentication front (pending cap, head deadline and cap, Host, Origin and token first), the bounded peer semaphore, the HTTP layer re-checking each request, sessions keyed by id, tombstones, the cap with no eviction, never 404, arming, the wildcard holders, `onFatal`. `tcpPeerLookup` with its positive control. The secret kind. Unit tests: flood counts (no spawn before the token), foreign versus error, tombstone, cap, armed and disarmed, holders | `src/confine/broker-http.ts`, `peer.ts`, broker.ts refactor, `test/broker-http.test.ts` | 1.5-2 days |
| **BB** Stage-2 wiring | Lease port and snapshot; `openStage2` order; `stage2AppServerEnv` with token and `NO_PROXY`; `bindAppServer`, `arm`/`disarm` call sites, `onFatal` in `watch`; `codexFlags` entry, pins and the relay-only exemption; `configProblem` with exemption | `codex-env.ts`, `ports.ts`, `codex.ts`, `codex-app.ts` call sites | 1-1.5 days |
| **BC** Admission and readback | Token-variable and person-`relay_tools` refusals; the exact entry (with `required`), the pins, the listing, the broker evidence and the per-thread check; `STAGE2_TOOLS`; reverting the no-tools texts | `codex-stage2.ts`, `raw-network.ts`, `prompts.ts`, `server.ts` description, `test/stage2-gates.test.ts` | 1 day |
| **BD** Qualification, red-team and live test | Items 14-22; items 3, 10 and 11 updated; release-watch surfaces; a live test in which a stage-2 job delegates through the real broker; the red-team additions | `scripts/codex-qualify/codex-stage2.mjs`, the release watcher's notes (not published), the red-team harness (not published) | 1.5-2 days |

Order:
1. BA and BC start against §8.4.
2. BB, once BA's `HttpBroker` exists.
3. BD, once BB and BC are in.
4. Then the cross-family review of the diff, and the red-team.

## 13. Review r_b52db760 disposition

| Item | Severity | Resolution | Section | Evidence |
|---|---|---|---|---|
| C5+X1: an lsof spawn on every unauthenticated connection | major, precondition | A paused raw front: bounded pending (16), a 2 s head deadline and an 8 KiB cap; `Host`, `Origin` and token checked first with no process; the peer check only for token holders, through a semaphore of 2; then `emit("connection")` | §5.5 | B6: 0 lsof for 300 idle and 300 wrong-token connections; ≤16 lookups, 2 at a time, for 40 right-token connections from elsewhere; Codex works through it (B1 `c-base2`) |
| X2: a persistent checker failure leaves dead tools | major | Operational failure (error, timeout, relay's own end missing) told apart from a valid foreign result, and fatal by the app-server-first path; `required = true` with connection readiness, read back | §5.5, §7.1 | B6: hang and missing lsof are fatal, foreign is not; B1: `required` makes `thread/start` refuse on a refused token or a broken checker, and without it the turn ran with dead tools |
| C1: turns Codex starts by itself could call relay's tools | minor | The broker is disarmed until relay's own turn is answered, bound and read back; `tools/call` is refused until then; the confinement design §2.2 is updated | §3.3; confinement design §2.2 | B1 `c-base2`: refused before arming, served after |
| C2+X3: pre-positioning on `0.0.0.0:M`/`[::]:M` | minor | Hold `127.0.0.1`, `0.0.0.0` and dual-stack `[::]` for the turn; destroy connections on the holders; no longer claim impersonation is closed | §4.1, §6 | B6: every bind that catches `127.0.0.1:M` is EADDRINUSE; a connection on a holder is destroyed |
| C4: 404 for a session closed mid-turn replays a call | minor | Every issued id is tombstoned; a non-404 JSON-RPC error for closed, unknown and over-cap; the cap refuses and never evicts | §2.4, §3.3 | B6 §1b |
| C6: command environment | minor | Qualification item 20; `process_manager.rs` added to the release watch | §5.1, §7.2 | B7: the token's name and value are absent from commands run three ways; the executor's own canary is present |
| C7+X4: name collisions | minor | Exempt `BROKER_SERVER_NAME` in codex.ts's relay-only loop and in `configProblem`; refuse a person's `relay_tools` at admission | §8.4, §7.1 | from source (`src/backends/codex.ts` relay-only loop; `src/backends/codex-app.ts` `configProblem`); recursive merge `config/src/merge.rs:81-100` |
| C8: session counts before fixing the cap | minor | Measured; the subagent limits pinned and read back; cap 8 | §3.3 | B5: v1 and v2, 3 and 6 sequential subagents, resume |
| C3 | — | dropped by the review: the system-proxy fallback is not on the MCP path; `respect_system_proxy = false` is read back. Revision 1's `scutil` admission check is dropped | §5.8 | — |
| C9, C10 | — | dropped by the review | — | — |
| Known limit: `skills/list` without `local` | note | Recorded | §9 item 7 | from the C1+X2 fix |

## Appendix: probe index

All model-free, under `/tmp/s2bk`, with scratch `HOME`/`CODEX_HOME` (the catalog from `test/fixtures/stage2-catalog.json`, `mock-model`; `mcp_oauth_credentials_store = "file"`), my own listeners on random high ports, and every process stopped and checked by pid.

Revision 1 (`run-b1.sh`; logs b1-summary.txt (not published), b2-write.txt (not published), b2-read.txt (not published), b2-baseline.txt (not published), b3-squat.txt (not published), b4-result.json (not published)):

| Id | What | Result |
|---|---|---|
| B1 base, call-direct, call-codemode, long | HTTP entry `relay_tools`, bearer from the environment, peer check | works without `local`; model-driven calls; a 75 s call; the token in no argv or file |
| B1 no-token, wrong-token, peer-foreign, env-header, thread-header, trace | negative controls and alternatives | §2.2 |
| B1 user-relay, user-relay-named | the person's stdio `relay` | `relay` fails ("url is not supported for stdio"); `relay_tools` coexists |
| B1 proxy, proxy-noproxy | `HTTP(S)_PROXY` | the bearer went to the proxy; `NO_PROXY=127.0.0.1` fixed it |
| B2 | relay's stage-2 profile, `M` a range port | EPERM at 32 spellings and for binds; `KERN_PROCARGS2` EPERM |
| B3 | outside squatters, `127.0.0.1` held alone | the specific bind refused; wildcard binds allowed, getting nothing until relay closes |
| B4 | the broker closed mid-thread; stdin EOF | reconnect with the token at 1 ms and 2 s; exit 4 ms after EOF |

Revision 2 (`run-rev.sh`; logs rev-b1-summary.txt (not published), b5-v1-result.json (not published), b5-v2-result.json (not published), b5-v2n6-result.json (not published), b6-front.txt (not published), b7-result.json (not published)):

| Id | Script | What | Result |
|---|---|---|---|
| B1 c-base2 | `BROKER=2 REQUIRED=1 DIRECT=1 CALL=1 b1-http.mjs` | Codex through the revised front, `required = true` | `required: true` read back; thread connected; a call before arming refused, after arming served; model-driven call served; 4 lookups, about 50 ms each |
| B1 c-req-wrong, c-noreq-wrong | `VARIANT=wrong-token`, with and without `REQUIRED=1` | startup refused by the token | with `required`: `thread/start` fails; without: the thread starts, the server `failed`, the turn completes with dead tools; 0 lookups |
| B1 c-req-lsofbad | `LSOF=/nonexistent/lsof REQUIRED=1` | broken checker | `onFatal` on each connection; `thread/start` fails |
| B5 | `b5-sessions.mjs` (`MA=v1|v2`, `N`) | sessions per turn, subagents using relay's tools, churn, resume | §3.3 table |
| B6 | `b6-front.mjs` | the front under load, checker failures, sessions, squatters with three holds | §5.5 table, §2.4, §4.2 |
| B7 | `b7-cmdenv.mjs` | a command's environment through a real executor | no token name or value, no app-server canary; the executor's canary present |

Cleanup list (scratch I made; delete when convenient): `/tmp/s2bk/` (`b1-*`, `c-*`, `b2-*`, `b4`, `b5-*`, `b6`, `b7` and `*.txt`/`*.out`). No process I started is left running (each probe checked by pid).

## 14. Confirmation d_63ad5c08 (2026-10-29): build revision 2 with one change

Codex Daybreak (the r_b52db760 reviewer) confirmed that revision 2 resolves every agreed item. One change before the build: **arm the broker immediately after `guard.replied(started.turn.id)` confirms the turn/start reply belongs to relay's requested turn, before awaiting `stage2TurnReadback`**. That readback can retry for up to 10 s while the model is already running, and arming after it would refuse the legitimate turn's first tool call. The binding travels in the same turn/start. The readback stays as defence in depth and still kills the app server first on a mismatch.

Build and qualification obligations:
1. A production-order probe with no manual `arm()`. The model's first relay tool call, made right after turn/start, is served. A turn Codex starts by itself before relay's turn/start is refused.
2. The peer lookup treats any non-null `execFile` error as operational, even if partial output names relay's end. Host qualification correction: retry once within §5.5's total deadline before failing the turn. The sole nonfatal exception is an empty exit 1 for an already destroyed/ended socket; partial output never rescues an error.
3. Tombstone tests after an abnormal close and after oversized input, not only after DELETE.
4. Use the canonical key `agents.max_concurrent_threads_per_session` in code and design.
5. A mid-turn checker failure is exercised end to end in qualification: the app server is killed first, then the turn fails.
6. Admission refuses a person-defined `relay_tools`, with a test.

### Host qualification lifecycle correction (2026-10-29)

Codex 0.164's `RmcpClient::shutdown` replaces its state with `Closed` and drops the previous running service (`rmcp-client/src/rmcp_client.rs:1075-1090`); its HTTP adapter implements session termination as DELETE (`http_client_adapter.rs:458-508`). Do not infer session termination from an ordinary completed POST or idle keep-alive TCP close: one MCP session spans multiple connections.

The SDK's GET/SSE cancellation removes its stream mapping without invoking `onsessionclosed` or transport `onclose`. The Node adapter can finish a streaming response before `close`, so checking only `!res.writableFinished` misses that teardown. The broker now also retires a session when its successful standalone GET/SSE response closes, including clean response completion and underlying connection loss. It captures the content type at `writeHead`, because headers supplied there need not appear in `getHeader`. Rejected GETs do not retire sessions. DELETE, abnormal input and stream teardown share the same idempotent retirement path: permanent tombstone, no id reuse, capacity released, no eviction and no 404.

Qualification item 22 now counts actual broker lifecycle events through the host-only `onSession` seam. Its previous wire counter removed ids only for DELETE, so it could report a leak even for sessions retired by stream closure. Memory-socket unit tests cover these paths; the host rerun must establish the actual v1/v2 teardown and peak counts through Codex.
