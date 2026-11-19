# Codex CLI 0.164.0: stage 2 qualification

Run on 2026-10-28 by hand on the maintainer's Mac (macOS 27.0.1, a login session), with relay at a private commit: `node scripts/release-watch/codex-stage2.mjs <checkout> <scratch> 0.164.0 <codex> --old-bin <codex 0.163.0>`. Codex 0.164.0 from Homebrew (/opt/homebrew/bin/codex), 0.163.0 from its GitHub release (codex-aarch64-apple-darwin, signed by OpenAI, team 2DC432GLL2); the catalog from the rust-v0.164.0 source. Real git worktrees throughout; relay's stage-2 path through codexBackend.start, the job registered and consented as a person does.

## Stage 2 qualification

the maintainer's release watcher (not published) (template and items: [codex-stage2-template.md](codex-stage2-template.md)): a fake Responses API on loopback, scratch Codex and relay homes, this run's own listeners; each item's `codex` part against this release under relay's stage-2 profile and flags, its `control` where the same calls must escape, its `relay` part through relay's own stage-2 path. Overall: **passed**; relay's stage-2 path: present.

| Item | What | Result |
|---|---|---|
| 1 | commands, apply_patch and code mode's nested tools confined to the roots, and a denied port unreachable; control without the environment (W1, W5, B0) | Passed. |
| 2 | a restricted Codex profile in the environment fails closed: exit 71 (B3) | Passed. |
| 3 | a local stdio MCP server starts outside the executor, and under the stage-2 settings none but relay's runs (W2) | Passed. |
| 4 | an exec-policy allow rule and an approved require_escalated command stay confined (W3) | Passed. |
| 5 | an unreachable executor: no fallback to local (W4) | Passed. |
| 6 | the executor token is memory-only: in no argv, environment or file (X7, W7) | Passed. |
| 7 | cross-turn authentication: no token, a wrong token and a guessed one are refused (X7, W6, W7) | Passed. |
| 8 | survivors: background, nohup, setsid, a terminal session and a block-port listener are gone after teardown (C5, X3) | Passed. |
| 9 | executor death mid-turn: the app server is stopped first, the turn fails, a fresh listener on its port sees nothing | Passed. |
| 10 | the tool list under the stage-2 settings is within the allowlist for every catalog model, and code mode's isolate has no Node, file or network bindings (§2.5, §9.3) | Passed. |
| 11 | a subagent's command runs in the relay environment; a resumed thread bound per turn (turn/start.environments) keeps commands and subagents in the executor (control: without the binding a command runs locally); no turn starts by itself on a resume under relay's flags, an active goal's included (control: with goals on it does); relay refuses a resume with a queued message | Passed. |
| 12 | --disable plugins stops the curated plugin sync | Passed. |
| 13 | an older Codex (0.163): nothing escapes, and relay's admission refuses it (STAGE2_MIN_CODEX) | Passed. |

## Evidence by item

### Item 1

- **codex**: passed

  ```json
  {"markers":{"wt":"0","out":"1","readhome":"1","writehome":"1"},"nested":{"nestedout":"1","nestedin":"0","patch":"refused Exit code: 1"},"net":[{"kind":"deny","address":"127.0.0.1","outcome":"EPERM"},{"kind":"deny","address":"::1","outcome":"EPERM"},{"kind":"deny","address":"localhost","outcome":"EPERM"},{"kind":"deny","address":"0.0.0.0","outcome":"EPERM"},{"kind":"deny","address":"::","outcome":"EPERM"},{"kind":"deny","address":"::ffff:127.0.0.1","outcome":"EPERM"},{"kind":"deny","address":"::ffff:0.0.0.0","outcome":"EPERM"},{"kind":"deny","address":"0:0:0:0:0:ffff:0:0","outcome":"EPERM"},{"kind":"deny","address":"0:0:0:0:0:ffff:7f00:1","outcome":"EPERM"},{"kind":"deny","address":"fe80::1%lo0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:c286:1bfe%en1","outcome":"EPERM"},{"kind":"deny","address":"192.0.2.10","outcome":"EPERM"},{"kind":"deny","address":"::ffff:192.0.2.10","outcome":"EPERM"},{"kind":"deny","address":"fd00:db8::1","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:b69a:1692%awdl0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:b69a:1692%llw0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:6637:a477%utun0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:df7e:e3a6%utun1","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:4ea5:6981%utun2","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:3cec:47a2%utun3","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:b56:9f58%utun4","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:270:dc26%utun5","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:936d:442e%utun6","outcome":"EPERM"},{"kind":"deny","address":"100.64.0.1","outcome":"EPERM"},{"kind":"deny","address":"::ffff:100.64.0.1","outcome":"EPERM"},{"kind":"deny","address":"fd7a:115c:a1e0::1","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:1291:cc88%utun7","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:50ca:830d%utun8","outcome":"EPERM"},{"kind":"ok","address":"127.0.0.1","outcome":"CONNECTED"}],"model":"gpt-6-astra"}
  ```
- **control**: passed

  ```json
  {"markers":{"wt":"0","out":"0"},"nested":{"nestedout":"0","nestedin":"0","patch":"{}"},"net":[{"kind":"deny","address":"127.0.0.1","outcome":"CONNECTED"},{"kind":"deny","address":"::1","outcome":"CONNECTED"},{"kind":"deny","address":"localhost","outcome":"CONNECTED"},{"kind":"deny","address":"0.0.0.0","outcome":"CONNECTED"},{"kind":"deny","address":"::","outcome":"CONNECTED"},{"kind":"deny","address":"::ffff:127.0.0.1","outcome":"CONNECTED"},{"kind":"deny","address":"::ffff:0.0.0.0","outcome":"CONNECTED"},{"kind":"deny","address":"0:0:0:0:0:ffff:0:0","outcome":"CONNECTED"},{"kind":"deny","address":"0:0:0:0:0:ffff:7f00:1","outcome":"CONNECTED"},{"kind":"deny","address":"fe80::1%lo0","outcome":"CONNECTED"},{"kind":"deny","address":"fe80::db8:0:c286:1bfe%en1","outcome":"CONNECTED"},{"kind":"deny","address":"192.0.2.10","outcome":"CONNECTED"},{"kind":"deny","address":"::ffff:192.0.2.10","outcome":"CONNECTED"},{"kind":"deny","address":"fd00:db8::1","outcome":"CONNECTED"},{"kind":"deny","address":"fe80::db8:0:b69a:1692%awdl0","outcome":"TIMEOUT"},{"kind":"deny","address":"fe80::db8:0:b69a:1692%llw0","outcome":"CONNECTED"},{"kind":"deny","address":"fe80::db8:0:6637:a477%utun0","outcome":"TIMEOUT"},{"kind":"deny","address":"fe80::db8:0:df7e:e3a6%utun1","outcome":"TIMEOUT"},{"kind":"deny","address":"fe80::db8:0:4ea5:6981%utun2","outcome":"TIMEOUT"}]}
  ```
- **relay**: passed

  ```json
  {"markers":{"wt":"0","out":"1","readhome":"1","writehome":"1"},"nested":{"nestedout":"1","nestedin":"0","patch":"refused Exit code: 1"},"net":[{"kind":"deny","address":"127.0.0.1","outcome":"EPERM"},{"kind":"deny","address":"::1","outcome":"EPERM"},{"kind":"deny","address":"localhost","outcome":"EPERM"},{"kind":"deny","address":"0.0.0.0","outcome":"EPERM"},{"kind":"deny","address":"::","outcome":"EPERM"},{"kind":"deny","address":"::ffff:127.0.0.1","outcome":"EPERM"},{"kind":"deny","address":"::ffff:0.0.0.0","outcome":"EPERM"},{"kind":"deny","address":"0:0:0:0:0:ffff:0:0","outcome":"EPERM"},{"kind":"deny","address":"0:0:0:0:0:ffff:7f00:1","outcome":"EPERM"},{"kind":"deny","address":"fe80::1%lo0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:c286:1bfe%en1","outcome":"EPERM"},{"kind":"deny","address":"192.0.2.10","outcome":"EPERM"},{"kind":"deny","address":"::ffff:192.0.2.10","outcome":"EPERM"},{"kind":"deny","address":"fd00:db8::1","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:b69a:1692%awdl0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:b69a:1692%llw0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:6637:a477%utun0","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:df7e:e3a6%utun1","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:4ea5:6981%utun2","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:3cec:47a2%utun3","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:b56:9f58%utun4","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:270:dc26%utun5","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:936d:442e%utun6","outcome":"EPERM"},{"kind":"deny","address":"100.64.0.1","outcome":"EPERM"},{"kind":"deny","address":"::ffff:100.64.0.1","outcome":"EPERM"},{"kind":"deny","address":"fd7a:115c:a1e0::1","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:1291:cc88%utun7","outcome":"EPERM"},{"kind":"deny","address":"fe80::db8:0:50ca:830d%utun8","outcome":"EPERM"},{"kind":"ok","address":"127.0.0.1","outcome":"CONNECTED"}],"turn":{"status":"ok"}}
  ```

### Item 2

- **codex**: passed

  ```json
  {"exitCodes":[],"output":"Chunk ID: 4bd739\nWall time: 0.0000 seconds\nProcess exited with code 71\nOriginal token count: 14\nOutput:\nsandbox-exec: sandbox_apply: Operation not permitted\n"}
  ```

### Item 3

- **outside**: passed
- **settings**: passed

  ```json
  {"started":["relay"],"listed":["person","relay"]}
  ```
- **relay**: passed

  ```json
  {"turn":{"status":"ok"}}
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
  {"captured":2,"tmpDir":"<run>/home/.rn/DN9JQL","turn":{"status":"ok"}}
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
  {"pids":{"bg":72037,"hup":72040,"setsid":72043,"listen":72044,"pty":72064},"port":47200,"nohup":"refused to start: nohup: can't detach from console: No such process","turn":{"status":"ok","warnings":["relay found 2 process(es) of this turn's commands outside the executor's process tree (pids 72043, 72101), still in the turn's sandbox, and stopped them."]}}
  ```

### Item 9

- **relay**: passed

  ```json
  {"killed":{"pid":72160,"port":47204,"appAliveAtEnd":false},"accepts":0,"turn":{"status":"failed","error":"relay's sandboxed executor for this Codex turn's commands exited during the turn (SIGKILL), so relay stopped the agent and failed the turn. WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"<run>/home/.rn/eGBgtq\" (codex_home: AbsolutePathBuf(\"<run>/home/.rn/eGBgtq/codex-exec-home\")) ws://127.0."}}
  ```

### Item 10

- **tools**: passed

  ```json
  {"allowed":["functions","clock","collaboration","exec","wait","request_user_input","request_user_input_async","sleep","curr_time","clock__curr_time","spawn_agent","wait_agent","send_message","followup_task","interrupt_agent","list_agents","send_input","resume_agent","close_agent","exec_command","write_stdin","apply_patch","view_image","web_search","update_plan","tool_search","list_mcp_resources","list_mcp_resource_templates","read_mcp_resource","web","run","web__run"],"models":{"gpt-6-astra":{"toolMode":"code_mode_only","visibility":"list","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-6.1-sol":{"toolMode":"code_mode_only","visibility":"list","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-6-sol":{"toolMode":"code_mode_only","visibility":"list","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-6-luna":{"toolMode":"code_mode_only","visibility":"list","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-5.6-sol":{"toolMode":"code_mode_only","visibility":"list","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","web__run","wait","request_user_input","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-5.6-terra":{"toolMode":"code_mode_only","visibility":"list","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","web__run","wait","request_user_input","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-5.6-luna":{"toolMode":"code_mode_only","visibility":"list","tools":["functi
  ```
- **isolate**: passed

  ```json
  {"model":"gpt-6-astra","result":{"types":{"require":"undefined","process":"undefined","fetch":"undefined","WebSocket":"undefined","XMLHttpRequest":"undefined","EventSource":"undefined","Worker":"undefined","Deno":"undefined","Bun":"undefined","module":"undefined","exports":"undefined","Buffer":"undefined","console":"undefined","importScripts":"undefined","navigator":"undefined"},"imports":{"node:fs":"refused: unsupported import in exec","fs":"refused: unsupported import in exec","./x.js":"refused: unsupported import in exec","file:///etc/hosts":"refused: unsupported import in exec"},"globals":["ALL_TOOLS","AggregateError","Array","ArrayBuffer","AsyncDisposableStack","BigInt","BigInt64Array","BigUint64Array","Boolean","DataView","Date","DisposableStack","Error","EvalError","FinalizationRegistry","Float16Array","Float32Array","Float64Array","Function","Infinity","Int16Array","Int32Array","Int8Array","Intl","Iterator","JSON","Map","Math","NaN","Number","Object","Promise","Proxy","RangeError","ReferenceError","Reflect","RegExp","Set","String","SuppressedError","Symbol","SyntaxError","TypeError","URIError","Uint16Array","Uint32Array","Uint8Array","Uint8ClampedArray","WeakMap","WeakRef","WeakSet","as_settled","audio","clearTimeout","decodeURI","decodeURIComponent","encodeURI","encodeURIComponent","escape","eval","exit","generatedImage","globalThis","image","isFinite","isNaN","load","notify","parseFloat","parseInt","setTimeout","store","stream_settled","text","tools","undefined","unescape","yield_control"]}}
  ```
- **relay**: passed

  ```json
  {"models":{"gpt-6-astra":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-6.1-sol":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-6-sol":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-6-luna":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","clock__curr_time","web__run","wait","request_user_input","request_user_input_async","clock","sleep","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-5.6-sol":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","web__run","wait","request_user_input","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-5.6-terra":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","web__run","wait","request_user_input","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-5.6-luna":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","web__run","wait","request_user_input"]},"gpt-daybreak-blue-latest":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","write_stdin","web__run","wait","request_user_input","collaboration","followup_task","interrupt_agent","list_agents","send_message","spawn_agent","wait_agent"]},"gpt-daybreak-red-latest":{"status":"ok","tools":["functions","exec","apply_patch","exec_command","list_mcp_resource_templates","list_mcp_resources","read_mcp_resource","view_image","wri
  ```

### Item 11

- **subagent**: passed

  ```json
  {"sub":{"subwt":"0","subout":"1"},"model":"gpt-6-astra"}
  ```
- **resume**: passed

  ```json
  {"started":[{"environmentId":"relay","cwd":"<run>/i11/wt","runtimeWorkspaceRoots":["<run>/i11/wt"]}],"resumed":[{"environmentId":"local","cwd":"<run>/i11/wt","runtimeWorkspaceRoots":["<run>/i11/wt"]},{"environmentId":"relay","cwd":"<run>/i11/wt","runtimeWorkspaceRoots":["<run>/i11/wt"]}],"sub2":{"sub2wt":"0","sub2out":"1"},"spawned2":"{\"task_name\":\"/root/qualify_resumed\"}","readbackOfResumeReply":null}
  ```
- **control**: passed

  ```json
  {"bareResumed":[{"environmentId":"local","cwd":"<run>/i11/wt","runtimeWorkspaceRoots":["<run>/i11/wt"]},{"environmentId":"relay","cwd":"<run>/i11/wt","runtimeWorkspaceRoots":["<run>/i11/wt"]}],"bareEscaped":true}
  ```
- **selfStart**: passed

  ```json
  {"goalSet":"active","goal":{"selfStarted":0,"goalAsked":0,"resumed":{"rgwt":"0","rgout":"1"}},"queued":"queued","queue":{"selfStarted":1,"queuedAsked":2,"queuedEscaped":true}}
  ```
- **goalControl**: passed

  ```json
  {"selfStarted":1,"goalAsked":2,"goalEscaped":true}
  ```
- **relay**: passed

  ```json
  {"first":{"status":"ok"},"resumed":{"status":"ok"},"goal":{"set":"active","turn":{"status":"ok"}},"queue":{"queued":"queued","turn":{"status":"failed","error":"relay will not resume this Codex session with raw network, because a message is queued for the session in Codex (put there by another Codex client), and Codex would start it by itself on resume, before relay can bind that turn to its sandboxed executor; send or remove it from that client, then resume again."}}}
  ```

### Item 12

- **control**: passed

  ```json
  {"tmp":["plugins.sync.lock"],"proxied":["CONNECT chatgpt.com:443","CONNECT github.com:443","CONNECT api.github.com:443","CONNECT chatgpt.com:443"]}
  ```
- **codex**: passed

  ```json
  {"tmp":null,"proxied":[]}
  ```

### Item 13

- **codex**: passed

  ```json
  {"version":"codex-cli 0.163.0","refused":null,"ran":true,"escaped":false}
  ```
- **relay**: passed

  ```json
  {"old":"relay cannot run this Codex job with raw network: Codex is 0.163.0, and raw network needs 0.164.0 or later (its execution environments). It does not start the agent; without grant.raw_network the job runs with strict network instead.","current":null,"min":"0.164.0"}
  ```
