# Codex CLI 0.170.0: stage 2 qualification

Run on 2026-11-18 by hand on the maintainer's Mac (macOS 27.2.1, an Aqua session under tmux, Node v24.22.3), with relay at a private commit: `node scripts/codex-qualify/codex-stage2.mjs <checkout> <scratch> 0.170.0 <codex> --old-bin <codex 0.163.0>`. With `--source <codex-rs at rust-v0.170.0>`, `RELAY_TEST_PUBLIC_NET=1` and `RELAY_TEST_ESCALATION_LONG=1`, in a scratch HOME and TMPDIR. Summary and decisions: [codex-0.170.0.md](codex-0.170.0.md).

## Stage 2 qualification

`scripts/codex-qualify/codex-stage2.mjs` (template and items: [codex-stage2-template.md](codex-stage2-template.md)): a fake Responses API on loopback, scratch Codex and relay homes, this run's own listeners; each item's `codex` part against this release under relay's stage-2 profile and flags, its `control` where the same calls must escape, its `relay` part through relay's own stage-2 path. Overall: **passed**; relay's stage-2 path: present.

| Item | What | Result |
|---|---|---|
| 1 | commands, apply_patch and code mode's nested tools confined to the roots, and a denied port unreachable; control without the environment (W1, W5, B0) | Passed. |
| 2 | a restricted Codex profile in the environment fails closed: exit 71 (B3) | Passed. |
| 3 | a local stdio MCP server starts outside the executor; under relay's stage-2 settings only authenticated relay_tools runs (W2) | Passed. |
| 4 | an exec-policy allow rule and an approved require_escalated command stay confined (W3) | Passed. |
| 5 | an unreachable executor: no fallback to local (W4) | Passed. |
| 6 | the executor token is memory-only: in no argv, environment or file (X7, W7) | Passed. |
| 7 | cross-turn authentication: no token, a wrong token and a guessed one are refused (X7, W6, W7) | Passed. |
| 8 | survivors: background, nohup, setsid, a terminal session and a block-port listener are gone after teardown (C5, X3) | Passed. |
| 9 | executor death mid-turn: the app server is stopped first, the turn fails, a fresh listener on its port sees nothing | Passed. |
| 10 | the tool list under relay's version-specific stage-2 settings (prediction parent tools pinned off where supported) is within the allowlist for every catalog model; code mode's isolate has no Node, file or network bindings; explicit effort reaches the model on fresh and resumed turns (§2.5, §9.3) | Passed. |
| 11 | a subagent's command runs in the relay environment; under relay's settings (no local environment) a resumed thread has no environment until bound per turn (turn/start.environments), then keeps commands and subagents in the executor, and unbound runs nothing (control: with local, unbound runs locally); no turn starts by itself on a resume under relay's flags, an active goal's included (control: with goals on it does); with goals on and no local, the goal's own turn, steered into by a bound turn/start, runs nothing (control: with local it runs there); relay refuses a resume with a queued message | Passed. |
| 12 | plugins off and discovery prefetch off where supported: no curated sync or host-side discovery traffic, with an authenticated discovery positive control | Passed. |
| 13 | an older Codex (0.163): nothing escapes, and relay's admission refuses it (STAGE2_MIN_CODEX) | Passed. |
| 14 | HTTP without local: exact entry, listings, direct and code-mode calls, and a 75-second call | Passed. |
| 15 | credentials/front: missing variable, wrong token, foreign peer, broken checker, required startup and app-server-first mid-turn failure | Passed. |
| 16 | relay stdio coexists with relay_tools; person-defined relay_tools refuses admission | Passed. |
| 17 | NO_PROXY protects the bearer from a decoy proxy, with a leaking negative control | Passed. |
| 18 | authenticated reconnect after broker loss and app-server EOF within one second | Passed. |
| 19 | 404 replays; tombstone and cap JSON-RPC errors never replay or evict | Passed. |
| 20 | C6: no broker-token name or value in commands (plain, terminal, nested code mode) through the real executor | Passed. |
| 21 | C1: a self-started goal continuation cannot call the disarmed broker | Passed. |
| 22 | C8: v1/v2 broker session counts, churn and resume under canonical pins | Passed. |
| 23 | out-of-profile hosted/open-page and extension screening, distinguishing exact model websocket upgrades | Passed. |
| 24 | restart receipt, first call, replay, cancellation and handoff loss | Passed. |
| 25 | authenticated authority adversaries and consume isolation | Passed. |
| 26 | finite deadline, worker-death/reap and monotonic floor races | Passed. |
| 27 | overlay decoy profiles, exact listen, outside roots and raw-host refusal | Passed. |
| 28 | mediated DNS, aliases, teardown, bypass and credentials | Passed. |
| 29 | local refusal, interlock and Claude/ACP never proxies | Passed. |
| 30 | MCP result delivered exactly once beyond the former 3600-second timeout (opt-in hour-long probe) | Passed. |
| 31 | standing network: stage2 routing, never hosts, proxy variables, refusal and resume | Passed. |
| 32 | IPv4 localhost connect: disclosed LAN/tailnet scope, never and other-port denial | Passed. |
| 33 | the keychain under the never floor: a decoy keychain item is refused to floored native Codex turns, and its control without the file deny matches doctor's documented keychain IPC | Passed. |

## Evidence by item

### Item 1

- **codex**: passed

  ```json
  {"markers":{"wt":"0","out":"1","readhome":"1","writehome":"1"},"nested":{"nestedout":"1","nestedin":"0","patch":"refused Exit code: 1"},"net":[{"kind":"deny","address":"127.0.0.1","outcome":"EPERM"},{"kind":"deny","address":"::1","outcome":"EPERM"},{"kind":"deny","address":"localhost","outcome":"EPERM"},{"kind":"deny","address":"0.0.0.0","outcome":"EPERM"},{"kind":"deny","address":"::","outcome":"EPERM"},{"kind":"deny","address":"::ffff:127.0.0.1","outcome":"EPERM"},{"kind":"deny","address":"::ffff:0.0.0.0","outcome":"EPERM"},{"kind":"deny","address":"0:0:0:0:0:ffff:0:0","outcome":"EPERM"},{"kind":"deny","address":"0:0:0:0:0:ffff:7f00:1","outcome":"EPERM"},{"kind":"deny","address":"fe80::1%lo0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:5da:face%en1","outcome":"EPERM"},{"kind":"deny","address":"192.0.2.10","outcome":"EPERM"},{"kind":"deny","address":"::ffff:192.0.2.10","outcome":"EPERM"},{"kind":"deny","address":"fd00:db8::1","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:e302:13b7%awdl0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:e302:13b7%llw0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:ef28:5713%utun0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:ec5c:4640%utun1","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:cc04:4081%utun2","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:3cec:47a2%utun3","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:936d:442e%utun4","outcome":"EPERM"},{"kind":"deny","address":"100.64.0.1","outcome":"EPERM"},{"kind":"deny","address":"::ffff:100.64.0.1","outcome":"EPERM"},{"kind":"deny","address":"fd7a:115c:a1e0::1","outcome":"EPERM"},{"kind":"ok","address":"127.0.0.1","outcome":"CONNECTED"}],"model":"gpt-6.2-sol"}
  ```
- **control**: passed

  ```json
  {"markers":{"wt":"0","out":"0"},"nested":{"nestedout":"0","nestedin":"0","patch":"{}"},"net":[{"kind":"deny","address":"127.0.0.1","outcome":"CONNECTED"},{"kind":"deny","address":"::1","outcome":"CONNECTED"},{"kind":"deny","address":"localhost","outcome":"CONNECTED"},{"kind":"deny","address":"0.0.0.0","outcome":"CONNECTED"},{"kind":"deny","address":"::","outcome":"CONNECTED"},{"kind":"deny","address":"::ffff:127.0.0.1","outcome":"CONNECTED"},{"kind":"deny","address":"::ffff:0.0.0.0","outcome":"CONNECTED"},{"kind":"deny","address":"0:0:0:0:0:ffff:0:0","outcome":"CONNECTED"},{"kind":"deny","address":"0:0:0:0:0:ffff:7f00:1","outcome":"CONNECTED"},{"kind":"deny","address":"fe80::1%lo0","outcome":"CONNECTED"},{"kind":"deny","address":"fe80::db8:0:5da:face%en1","outcome":"CONNECTED"},{"kind":"deny","address":"192.0.2.10","outcome":"CONNECTED"},{"kind":"deny","address":"::ffff:192.0.2.10","outcome":"CONNECTED"},{"kind":"deny","address":"fd00:db8::1","outcome":"CONNECTED"},{"kind":"deny","address":"fe80::db8:0:e302:13b7%awdl0","outcome":"TIMEOUT"},{"kind":"deny","address":"fe80::db8:0:e302:13b7%llw0","outcome":"CONNECTED"},{"kind":"deny","address":"fe80::db8:0:ef28:5713%utun0","outcome":"TIMEOUT"},{"kind":"deny","address":"fe80::db8:0:ec5c:4640%utun1","outcome":"TIMEOUT"},{"kind":"deny","address":"fe80::db8:0:cc04:4081%utun2","outcome":"TIMEOUT"}]}
  ```
- **relay**: passed

  ```json
  {"markers":{"wt":"0","out":"1","readhome":"1","writehome":"1"},"nested":{"nestedout":"1","nestedin":"0","patch":"refused Exit code: 1"},"net":[{"kind":"deny","address":"127.0.0.1","outcome":"EPERM"},{"kind":"deny","address":"::1","outcome":"EPERM"},{"kind":"deny","address":"localhost","outcome":"EPERM"},{"kind":"deny","address":"0.0.0.0","outcome":"EPERM"},{"kind":"deny","address":"::","outcome":"EPERM"},{"kind":"deny","address":"::ffff:127.0.0.1","outcome":"EPERM"},{"kind":"deny","address":"::ffff:0.0.0.0","outcome":"EPERM"},{"kind":"deny","address":"0:0:0:0:0:ffff:0:0","outcome":"EPERM"},{"kind":"deny","address":"0:0:0:0:0:ffff:7f00:1","outcome":"EPERM"},{"kind":"deny","address":"fe80::1%lo0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:5da:face%en1","outcome":"EPERM"},{"kind":"deny","address":"192.0.2.10","outcome":"EPERM"},{"kind":"deny","address":"::ffff:192.0.2.10","outcome":"EPERM"},{"kind":"deny","address":"fd00:db8::1","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:e302:13b7%awdl0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:e302:13b7%llw0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:ef28:5713%utun0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:ec5c:4640%utun1","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:cc04:4081%utun2","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:3cec:47a2%utun3","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:936d:442e%utun4","outcome":"EPERM"},{"kind":"deny","address":"100.64.0.1","outcome":"EPERM"},{"kind":"deny","address":"::ffff:100.64.0.1","outcome":"EPERM"},{"kind":"deny","address":"fd7a:115c:a1e0::1","outcome":"EPERM"},{"kind":"ok","address":"127.0.0.1","outcome":"CONNECTED"}],"turn":{"status":"ok"}}
  ```

### Item 2

- **codex**: passed

  ```json
  {"exitCodes":[],"output":"Chunk ID: ad8fe4\nWall time: 0.0000 seconds\nProcess exited with code 71\nOriginal token count: 14\nOutput:\nsandbox-exec: sandbox_apply: Operation not permitted\n"}
  ```

### Item 3

- **outside**: passed
- **settings**: passed

  ```json
  {"local":{"status":"unknown","error":"unknown environment id `local`"},"on":["relay_tools"],"started":["relay_tools"],"listed":["person","relay","relay_tools"],"relayKeyOn":{"ran":false,"toolsError":"MCP startup failed: local stdio MCP server `relay` requires a local environment"}}
  ```
- **relay**: passed

  ```json
  {"turn":{"status":"ok"},"appServerNone":true}
  ```

### Item 4

- **codex**: passed

  ```json
  {"approvals":[],"rule":"1","esc":"1"}
  ```
- **relay**: passed

  ```json
  {"approvals":[],"rule":"1","esc":"1","turn":{"status":"ok"}}
  ```

### Item 5

- **codex**: passed

  ```json
  {"output":"No usable execution environment is available. Wait for an environment to become available before using this tool."}
  ```

### Item 6

- **codex**: passed
- **relay**: passed

  ```json
  {"captured":2,"tmpDir":"/private/tmp/s2q170/full/home/.rn/PgIVvN","appServers":1,"turn":{"status":"ok"}}
  ```

### Item 7

- **codex**: passed

  ```json
  {"inside":{"none":"refused","wrong":"refused","guessed":"refused"},"status":0,"stderr":"","control":{"right":"answered"}}
  ```
- **relay**: passed

  ```json
  {"probe":{"inside":{"none":"refused","wrong":"refused","guessed":"refused"},"status":0,"stderr":"","outside":"HTTP/1.1 401 Unauthorized"},"turn":{"status":"ok"}}
  ```

### Item 8

- **relay**: passed

  ```json
  {"pids":{"bg":43176,"hup":43179,"setsid":43182,"listen":43183,"pty":43226},"port":47200,"nohup":"refused to start: nohup: can't detach from console: No such process","turn":{"status":"ok","warnings":["relay found 2 process(es) of this turn's commands outside the executor's process tree (pids 43182, 43281), still in the turn's sandbox, and stopped them."]}}
  ```

### Item 9

- **relay**: passed

  ```json
  {"killed":{"pid":43457,"port":47204,"appAliveAtEnd":false},"accepts":0,"turn":{"status":"failed","error":"relay's sandboxed executor for this Codex turn's commands exited during the turn (SIGKILL), so relay stopped the agent and failed the turn. WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"/private/tmp/s2q170/full/home/.rn/9xplIG\" (codex_home: AbsolutePathBuf(\"/private/tmp/s2q170/full/home/.rn/9xplIG/codex-exec-home\")) ws://"}}
  ```

### Item 10

- **tools**: passed

  ```json
  {"allowed":["functions","clock","collaboration","exec","wait","request_user_input","request_user_input_async","sleep","curr_time","clock__curr_time","spawn_agent","wait_agent","send_message","followup_task","interrupt_agent","list_agents","send_input","resume_agent","close_agent","exec_command","write_stdin","apply_patch","view_image","web_search","update_plan","tool_search","list_mcp_resources","list_mcp_resource_templates","read_mcp_resource","web","run","web__run","send_message_to_user_async","mcp__relay_tools","escalate","delegate","status","result","resume","cancel","merge","ask","brief","discuss","review","mcp__relay_tools__escalate","mcp__relay_tools__delegate","mcp__relay_tools__status","mcp__relay_tools__result","mcp__relay_tools__resume","mcp__relay_tools__cancel","mcp__relay_tools__merge","mcp__relay_tools__ask","mcp__relay_tools__brief","mcp__relay_tools__discuss","mcp__relay_tools__review"],"models":{"gpt-6.2-sol":{"toolMode":"code_mode_only","visibility":"list","featuresOff":["image_generation","apps","plugins","remote_plugin","plugin_sharing","enable_mcp_apps","browser_use","computer_use","tool_suggest","hooks","plugin_hooks","skill_mcp_dependency_install","network_proxy","request_permissions_tool","exec_permission_approvals","js_repl","code_mode","memories","external_agent_memory_import","chronicle","standalone_web_search","goals","respect_system_proxy","deferred_tool_world_state","plugin_discovery_prefetch","prediction_preserve_parent_tools","incremental_tools_legacy_gcp","code_mode_host_grpc","code_mode_host_output_truncation","guardian_include_additional_context","incremental_tools_legacy","retain_client_tool_outputs","unified_image_budget","untrusted_as_tool_output"],"readback":null,"tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","send_message_to_user_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent","mcp__relay_tools","delegate","status","brief","result","ask","cancel","resume","merge","review","discuss"]},"gpt-6.2-astra":{"toolMode":"code_mode_only","visibility":"list","featuresOff":["image_generation","apps","plugins","remote_plugin","plugin_sharing","enable_mcp_apps","browser_use","computer_use","tool_suggest","hooks","plugin_hooks","skill_mcp_dependency_install","network_proxy","request_permissions_tool","exec_permission_approvals","js_repl","code_mode","memories","external_agent_memory_import","chronicle","standalone_web_search","goals","respect_system_proxy","deferred_tool_world_state","plugin_discovery_prefetch","prediction_preserve_parent_tools","incremental_tools_legacy_gcp","code_mode_host_grpc","code_mode_host_output_truncation","guardian_include_additional_context","incremental_tools_legacy","retain_client_tool_outputs","unified_image_budget","untr
  ```
- **isolate**: passed

  ```json
  {"model":"gpt-6.2-sol","result":{"types":{"require":"undefined","process":"undefined","fetch":"undefined","WebSocket":"undefined","XMLHttpRequest":"undefined","EventSource":"undefined","Worker":"undefined","Deno":"undefined","Bun":"undefined","module":"undefined","exports":"undefined","Buffer":"undefined","console":"undefined","importScripts":"undefined","navigator":"undefined"},"imports":{"node:fs":"refused: unsupported import in exec","fs":"refused: unsupported import in exec","./x.js":"refused: unsupported import in exec","file:///etc/hosts":"refused: unsupported import in exec"},"globals":["ALL_TOOLS","AggregateError","Array","ArrayBuffer","AsyncDisposableStack","BigInt","BigInt64Array","BigUint64Array","Boolean","DataView","Date","DisposableStack","Error","EvalError","FinalizationRegistry","Float16Array","Float32Array","Float64Array","Function","Infinity","Int16Array","Int32Array","Int8Array","Intl","Iterator","JSON","Map","Math","NaN","Number","Object","Promise","Proxy","RangeError","ReferenceError","Reflect","RegExp","Set","String","SuppressedError","Symbol","SyntaxError","TypeError","URIError","Uint16Array","Uint32Array","Uint8Array","Uint8ClampedArray","WeakMap","WeakRef","WeakSet","as_settled","audio","clearTimeout","content","decodeURI","decodeURIComponent","encodeURI","encodeURIComponent","escape","eval","exit","generatedImage","globalThis","image","isFinite","isNaN","load","notify","parseFloat","parseInt","setTimeout","store","stream_settled","text","tools","undefined","unescape","yield_control"]}}
  ```
- **relay**: passed

  ```json
  {"models":{"gpt-6.2-sol":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","send_message_to_user_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent","mcp__relay_tools","delegate","status","brief","result","ask","cancel","resume","merge","review","discuss"]},"gpt-6.2-astra":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","send_message_to_user_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent","mcp__relay_tools","delegate","status","brief","result","ask","cancel","resume","merge","review","discuss"]},"gpt-6-astra":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent","mcp__relay_tools","delegate","status","brief","result","ask","cancel","resume","merge","review","discuss"]},"gpt-6.1-sol":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent","mcp__relay_tools","delegate","status","brief","result","ask","cancel","resume","merge","review","discuss"]},"gpt-6.1-terra":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent","mcp__relay_tools","delegate","status","brief","result","ask","cancel","resume","merge","review","discuss"]},"gpt-6-sol":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent","mcp__relay_tools","delegate","status"
  ```
- **effort**: passed

  ```json
  {"model":"gpt-6.2-sol","turns":[{"selected":"high","resumed":false,"requests":[{"request":"high","updates":["high"],"effective":"high"}],"turn":{"status":"ok"}},{"selected":"medium","resumed":true,"requests":[{"request":"medium","updates":["high","medium"],"effective":"medium"}],"turn":{"status":"ok"}}]}
  ```

### Item 11

- **subagent**: passed

  ```json
  {"sub":{"subwt":"0","subout":"1"},"model":"gpt-6.2-sol"}
  ```
- **resume**: passed

  ```json
  {"started":[{"environmentId":"relay","cwd":"/private/tmp/s2q170/full/i11/wt","runtimeWorkspaceRoots":["/private/tmp/s2q170/full/i11/wt"]}],"resumed":[],"local":{"status":"unknown","error":"unknown environment id `local`"},"sub2":{"sub2wt":"0","sub2out":"1"},"spawned2":"{\"task_name\":\"/root/qualify_resumed\"}","readbackOfResumeReply":null}
  ```
- **unbound**: passed

  ```json
  {"environments":[],"markers":{},"output":"No usable execution environment is available. Wait for an environment to become available before using this tool."}
  ```
- **control**: passed

  ```json
  {"bareResumed":[{"environmentId":"local","cwd":"/private/tmp/s2q170/full/i11/wt","runtimeWorkspaceRoots":["/private/tmp/s2q170/full/i11/wt"]},{"environmentId":"relay","cwd":"/private/tmp/s2q170/full/i11/wt","runtimeWorkspaceRoots":["/private/tmp/s2q170/full/i11/wt"]}],"bareEscaped":true}
  ```
- **selfStart**: passed

  ```json
  {"goalSet":"active","goal":{"selfStarted":0,"goalAsked":0,"resumed":{"rgwt":"0","rgout":"1"}},"queued":"queued","queue":{"selfStarted":1,"queuedAsked":2,"output":"No usable execution environment is available. Wait for an environment to become available before using this tool.","queuedEscaped":false}}
  ```
- **noLocal**: passed

  ```json
  {"goal":{"set":"active","localStatus":{"status":"unknown","error":"unknown environment id `local`"},"selfStarted":1,"steeredInto":"01a1ef23-bfdf-7b51-8146-d325f78b8847","goalAsked":3,"output":"No usable execution environment is available. Wait for an environment to become available before using this tool.","escaped":false},"queue":{"selfStarted":1,"queuedAsked":2,"output":"No usable execution environment is available. Wait for an environment to become available before using this tool.","queuedEscaped":false}}
  ```
- **goalControl**: passed

  ```json
  {"selfStarted":1,"goalAsked":2,"goalEscaped":true}
  ```
- **relay**: passed

  ```json
  {"first":{"status":"ok"},"resumed":{"status":"ok"},"goal":{"set":"active","turn":{"status":"ok"}},"queue":{"queued":"queued","turn":{"status":"failed","error":"relay will not resume this Codex session under stage 2, because a message is queued for the session in Codex (put there by another Codex client), and Codex would start it by itself on resume, before relay can bind that turn to its sandboxed executor; send or remove it from that client, then resume again."}}}
  ```

### Item 12

- **control**: passed

  ```json
  {"tmp":["plugins.sync.lock"],"proxied":["CONNECT github.com:443","CONNECT api.github.com:443","CONNECT chatgpt.com:443"],"features":{"remote_plugin":true}}
  ```
- **codex**: passed

  ```json
  {"tmp":null,"proxied":[],"discovery":[{"method":"GET","path":"/backend-api/wham/accounts/check","query":"","authenticated":true},{"method":"GET","path":"/backend-api/wham/accounts/check","query":"","authenticated":true},{"method":"POST","path":"/backend-api/codex/analytics-events/events","query":"","authenticated":true},{"method":"GET","path":"/backend-api/wham/settings/user","query":"","authenticated":true},{"method":"POST","path":"/backend-api/codex/analytics-events/events","query":"","authenticated":true}],"discoveryBaseUrl":"http://127.0.0.1:52968/backend-api/","observationMs":9500,"features":{"plugins":false,"plugin_discovery_prefetch":false,"remote_plugin":false},"readback":null,"pluginsOnly":{"tmp":null,"proxied":[],"discovery":[{"method":"GET","path":"/backend-api/wham/accounts/check","query":"","authenticated":true},{"method":"GET","path":"/backend-api/wham/accounts/check","query":"","authenticated":true},{"method":"POST","path":"/backend-api/codex/analytics-events/events","query":"","authenticated":true},{"method":"GET","path":"/backend-api/wham/settings/user","query":"","authenticated":true},{"method":"POST","path":"/backend-api/codex/analytics-events/events","query":"","authenticated":true}],"discoveryBaseUrl":"http://127.0.0.1:52968/backend-api/","observationMs":9500,"features":{"plugins":false,"plugin_discovery_prefetch":true,"remote_plugin":false}}}
  ```
- **prefetch**: passed

  ```json
  {"tmp":null,"proxied":[],"discovery":[{"method":"GET","path":"/backend-api/ps/plugins/installed","query":"?limit=200&includeDownloadUrls=true","authenticated":true},{"method":"GET","path":"/backend-api/ps/plugins/installed","query":"?limit=200","authenticated":true},{"method":"GET","path":"/backend-api/wham/accounts/check","query":"","authenticated":true},{"method":"GET","path":"/backend-api/wham/accounts/check","query":"","authenticated":true},{"method":"GET","path":"/backend-api/ps/plugins/suggested/codex","query":"?scope=GLOBAL","authenticated":true},{"method":"POST","path":"/backend-api/ps/mcp","query":"","authenticated":false},{"method":"POST","path":"/backend-api/codex/analytics-events/events","query":"","authenticated":true},{"method":"POST","path":"/backend-api/ps/mcp","query":"","authenticated":false},{"method":"GET","path":"/backend-api/wham/settings/user","query":"","authenticated":true},{"method":"POST","path":"/backend-api/codex/analytics-events/events","query":"","authenticated":true}],"discoveryBaseUrl":"http://127.0.0.1:52968/backend-api/","observationMs":9500,"features":{"plugins":true,"plugin_discovery_prefetch":true,"remote_plugin":true}}
  ```

### Item 13

- **codex**: passed

  ```json
  {"version":"codex-cli 0.163.0","refused":null,"ran":true,"escaped":false}
  ```
- **relay**: passed

  ```json
  {"old":"relay cannot run this Codex job under stage 2: Codex is 0.163.0, and stage 2 needs 0.164.0 or later (its execution environments). It does not start the agent; there is no native strict or raw fallback.","current":null,"min":"0.164.0"}
  ```

### Item 14

- **direct**: passed

  ```json
  {"model":"gpt-5.5","sessions":4}
  ```
- **code_mode_only**: passed

  ```json
  {"model":"gpt-6.2-sol","sessions":4}
  ```
- **long**: passed

  ```json
  {"calls":1,"durationMs":75001.75074999989}
  ```
- **relay**: passed

  ```json
  {"turn":{"status":"ok"},"readbackWaitSawCall":true}
  ```

### Item 15

- **startup**: passed

  ```json
  {"missing":{"refused":true,"peers":0,"fatal":0,"refusals":[]},"wrong":{"refused":true,"peers":0,"fatal":0,"refusals":["HTTP 401"]},"foreign":{"refused":true,"peers":1,"fatal":0,"refusals":["HTTP 403"]},"error":{"refused":true,"peers":2,"fatal":1,"refusals":["HTTP 503","HTTP 503","HTTP 503"]}}
  ```
- **credentials**: passed

  ```json
  {"fileHits":[],"argvLeak":false,"stderrLeak":false,"foreignStatus":403}
  ```
- **midTurn**: passed

  ```json
  {"order":["fatal","app-kill","failure-callback-returned","app-reaped","broker-close","turn-result"],"turn":{"status":"failed","error":"relay could not check the TCP peer of its tools after 2 attempts: qualification mid-turn checker failure; qualification mid-turn checker failure; relay stopped the Codex app server and failed the turn."}}
  ```

### Item 16

- **coexist**: passed
- **admission**: passed

  ```json
  {"turn":{"status":"failed","error":"relay cannot run this Codex job under stage 2: the person's Codex config defines relay_tools; remove or rename it, because Codex's recursive merge would retain inherited fields in relay's broker entry. It does not start the agent; there is no native strict or raw fallback."},"configPath":"/private/tmp/s2q170/full/i16-person-entry/home/config.toml","fixtureWroteEntry":true,"refusedBeforeStart":true}
  ```

### Item 17

- **codex**: passed

  ```json
  {"proxyRequests":0,"bearerSeen":false}
  ```
- **control**: passed

  ```json
  {"proxyRequests":1,"bearerSeen":true}
  ```

### Item 18

- **reconnect**: passed

  ```json
  {"hits":[{"method":"GET","token":true},{"method":"DELETE","token":true}]}
  ```
- **eof**: passed

  ```json
  {"ms":12}
  ```

### Item 19

- **sessions**: passed
- **retry**: passed

  ```json
  {"200":1,"404":2}
  ```

### Item 20

- **relay**: passed

  ```json
  {"turn":{"status":"ok"},"commands":[{"ran":true,"tokenName":false},{"ran":true,"tokenName":false},{"ran":true,"tokenName":false}],"tokenValue":false}
  ```

### Item 21

- **disarmed**: passed

  ```json
  {"callsDispatched":0,"refused":true}
  ```

### Item 22

- **v1**: passed

  ```json
  {"model":"gpt-5.6-luna","first":{"opened":8,"peak":2,"calls":7,"resumed":false,"fatal":[],"actors":[{"actor":"parent","ok":true,"output":"Wall time: 0.0655 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"56e00fef54fed566e6ff0f0c\"\n  }\n}"},{"actor":"child 0","ok":true,"output":"Wall time: 0.0015 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"4f86d31f14cb1305bdc0e412\"\n  }\n}"},{"actor":"child 1","ok":true,"output":"Wall time: 0.0014 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"db3793cef911a39aa6eeb9c1\"\n  }\n}"},{"actor":"child 2","ok":true,"output":"Wall time: 0.0013 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"5c6774dafe3aa0acf4f4a157\"\n  }\n}"},{"actor":"child 3","ok":true,"output":"Wall time: 0.0015 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"6e3daad50f402a0288e244d1\"\n  }\n}"},{"actor":"child 4","ok":true,"output":"Wall time: 0.0013 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"d3b412922be766288feabee0\"\n  }\n}"},{"actor":"child 5","ok":true,"output":"Wall time: 0.0014 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"27419074a663ee2d6962e7b3\"\n  }\n}"}]},"resumed":{"opened":3,"peak":2,"calls":2,"resumed":true,"fatal":[],"actors":[{"actor":"parent","ok":true,"output":"Wall time: 0.0643 seconds\nOutput
  ```
- **v2**: passed

  ```json
  {"model":"gpt-6.2-sol","first":{"opened":8,"peak":7,"calls":7,"resumed":false,"fatal":[],"actors":[{"actor":"parent","ok":true,"output":"Wall time: 0.0647 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"9d12d13a243daf98350a4fb3\"\n  }\n}"},{"actor":"child 0","ok":true,"output":"Wall time: 0.0015 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"fc2a1473fba23a4a614d0adb\"\n  }\n}"},{"actor":"child 1","ok":true,"output":"Wall time: 0.0014 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"323e32e8ab9d2d8fc8085433\"\n  }\n}"},{"actor":"child 2","ok":true,"output":"Wall time: 0.0014 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"f55f9262d9b9328c955a190a\"\n  }\n}"},{"actor":"child 3","ok":true,"output":"Wall time: 0.0013 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"56f167a601765a18bf8b609b\"\n  }\n}"},{"actor":"child 4","ok":true,"output":"Wall time: 0.0013 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"a6f1a4c451d7ec02cdda3cc4\"\n  }\n}"},{"actor":"child 5","ok":true,"output":"Wall time: 0.0015 seconds\nOutput:{\n  \"fixture\": \"BROKER_OK\",\n  \"session\": {\n    \"scope\": \"child-run\",\n    \"source\": \"child-context\",\n    \"topology\": \"dedicated\",\n    \"reason\": \"Authority comes from the launched turn's run context; host metadata cannot widen it.\",\n    \"fingerprint\": \"e78e7dc2c313386f92808adb\"\n  }\n}"}]},"resumed":{"opened":3,"peak":2,"calls":2,"resumed":true,"fatal":[],"actors":[{"actor":"parent","ok":true,"output":"Wall time: 0.0734 seconds\nOutput:
  ```

### Item 23

- **unit**: passed

  ```json
  {"counts":{"tests":16,"pass":16,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-23-unit.tap"}
  ```
- **surfaces**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-23-surfaces.tap"}
  ```
- **freshResume**: passed

  ```json
  {"counts":{"tests":2,"pass":2,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-23-freshResume.tap"}
  ```
- **overlay**: passed

  ```json
  {"counts":{"tests":2,"pass":2,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-23-overlay.tap"}
  ```

### Item 24

- **unit**: passed

  ```json
  {"counts":{"tests":53,"pass":53,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-24-unit.tap"}
  ```
- **worker**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-24-worker.tap"}
  ```
- **cancel**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-24-cancel.tap"}
  ```
- **http**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-24-http.tap"}
  ```
- **code**: passed

  ```json
  {"counts":{"tests":2,"pass":2,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-24-code.tap"}
  ```
- **mismatch**: passed

  ```json
  {"counts":{"tests":2,"pass":2,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-24-mismatch.tap"}
  ```

### Item 25

- **unit**: passed

  ```json
  {"counts":{"tests":88,"pass":88,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-25-unit.tap"}
  ```

### Item 26

- **unit**: passed

  ```json
  {"counts":{"tests":61,"pass":61,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-26-unit.tap"}
  ```
- **hostRoots**: passed

  ```json
  {"counts":{"tests":3,"pass":3,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-26-hostRoots.tap"}
  ```
- **crash**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-26-crash.tap"}
  ```

### Item 27

- **unit**: passed

  ```json
  {"counts":{"tests":42,"pass":42,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-27-unit.tap"}
  ```
- **planner**: passed

  ```json
  {"counts":{"tests":3,"pass":3,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-27-planner.tap"}
  ```
- **kernel**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-27-kernel.tap"}
  ```
- **profiles**: passed

  ```json
  {"counts":{"tests":4,"pass":4,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-27-profiles.tap"}
  ```

### Item 28

- **unit**: passed

  ```json
  {"counts":{"tests":28,"pass":28,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-28-unit.tap"}
  ```
- **addresses**: passed

  ```json
  {"counts":{"tests":3,"pass":3,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-28-addresses.tap"}
  ```
- **worker**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-28-worker.tap"}
  ```
- **public**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-28-public.tap"}
  ```
- **crossJobCrash**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-28-crossJobCrash.tap"}
  ```

### Item 29

- **unit**: passed

  ```json
  {"counts":{"tests":38,"pass":38,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-29-unit.tap"}
  ```
- **decisions**: passed

  ```json
  {"counts":{"tests":6,"pass":6,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-29-decisions.tap"}
  ```
- **local**: passed

  ```json
  {"counts":{"tests":3,"pass":3,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-29-local.tap"}
  ```
- **nativeProfiles**: passed

  ```json
  {"counts":{"tests":2,"pass":2,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-29-nativeProfiles.tap"}
  ```

### Item 30

- **long**: passed

  ```json
  {"toolTimeoutS":7500,"calls":1,"durationMs":3601001.778417}
  ```

### Item 31

- **unit**: passed

  ```json
  {"counts":{"tests":15,"pass":15,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-31-unit.tap"}
  ```
- **executor**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-31-executor.tap"}
  ```
- **live**: passed

  ```json
  {"counts":{"tests":4,"pass":4,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-31-live.tap"}
  ```

### Item 32

- **unit**: passed

  ```json
  {"counts":{"tests":13,"pass":13,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-32-unit.tap"}
  ```
- **accounting**: passed

  ```json
  {"counts":{"tests":2,"pass":2,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-32-accounting.tap"}
  ```
- **planner**: passed

  ```json
  {"counts":{"tests":2,"pass":2,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-32-planner.tap"}
  ```
- **kernel**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-32-kernel.tap"}
  ```
- **worker**: passed

  ```json
  {"counts":{"tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-32-worker.tap"}
  ```

### Item 33

- **codex**: passed

  ```json
  {"counts":{"tests":4,"pass":4,"fail":0,"cancelled":0,"skipped":0,"todo":0},"log":"/private/tmp/s2q170/full/escalation-33-codex.tap"}
  ```
