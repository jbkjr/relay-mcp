# Gemini CLI 0.65.0: qualification record for relay's tools

2026-10-22, on the maintainer's Mac (macOS 27.0.1, 26A434), against `31ba1c0`, the 1.0 line with relay's tools through Gemini's tool discovery and its review fixes. Built in a detached worktree. Gemini CLI 0.65.0 (npm, released 2026-10-20) was installed into a scratch prefix, `<scratch>/gemini-cli-065`. Everything else is as in the 0.64.0 record ([gemini-0.64.0.md](gemini-0.64.0.md)):
- the scratch `RELAY_HOME`, repository and key file;
- the driver (`<scratch>/gq-scripts/drive5.mjs`, the third run's driver pointed at this build);
- the paid, prepaid key;
- `gemini-3.8-flash`.

The key was counted, never printed (`grep -cF`): it occurs 0 times in the agent logs, the driver's output and everything under the scratch directories.

**Why this run.** 0.65.0 is the current stable release, and relay offers its tools only to the exact versions in `targets.gemini.toolDiscovery.versions`, then `0.64.0` alone. With relay's tools verified on 0.64.0 only, most people would get no relay tools. docs/gemini.md §8, item 17, says that adding a version takes checks 12-15 on it.

**`allow_untested` was on, for that reason only.** The scratch config set `"allow_untested": true` so that relay would offer its tools to 0.65.0, which was not yet listed. It changes nothing else here: 0.65.0 is newer than the minimum that relay's version gate runs (`tested`, 0.64.0). Every turn carried relay's warning that the tools were offered unverified, as it should.

**Verdict: 0.65.0 passes checks 1, 4 and 12-15 as 0.64.0 did.** On this record's evidence, a private branch adds `0.65.0` to `toolDiscovery.versions`. Gemini was then qualified for 1.0 (the maintainer, 2026-10-22), on this record and the 0.64.0 one, with the residuals listed there accepted; checks 7 and 11 stay open ([gemini-0.64.0.md](gemini-0.64.0.md), "Verdict").

## The source: 0.64.0 against 0.65.0

The diff is of the two tagged trees in the qualification scratchpad (`gemtrust/src-v0.64.0`, `gemtrust/src-v0.65.0`).

**These are unchanged, byte for byte:**
- the tool discovery and its calls: `packages/core/src/tools/tool-registry.ts` and `tool-names.ts` (`DISCOVERED_TOOL_PREFIX`);
- the MCP trust gate (`packages/core/src/tools/mcp-client-manager.ts`) and the folder trust (`packages/cli/src/config/trustedFolders.ts`);
- the ACP session manager (`packages/cli/src/acp/acpSessionManager.ts`) and the session cleanup relay turns off (`packages/cli/src/utils/sessionCleanup.ts`, `utils/sessionUtils.ts`);
- the environment its commands get (`packages/core/src/services/sandboxManager.ts`) and the policy engine (`packages/core/src/policy/policy-engine.ts`);
- `packages/cli/src/config/config.ts`.

**The `isTrusted` sites.** The research's list of them (`trustsites-a64.txt` against `trustsites-a65.txt`) differs only in two places:
- the a2a server, which relay does not run;
- the `gemini mcp add` and `remove` subcommands, which now refuse in an untrusted folder; relay does not run them.

**What else changed, among the non-test sources:**
- `core/config/config.ts` and `settingsSchema.ts`: telemetry `otlpHeaders` (relay turns telemetry off).
- `cli/config/settings.ts`: an untrusted workspace's settings are now read-only, with an error on writing them. That is stricter; relay never writes them.
- `cli/acp/acpSession.ts`: `@`-path handling of directories.
- The scheduler's parallelism moved to `tool-utils.ts`.
- `retry.ts`: validation retries are now bounded. Nothing changed in the quota or not-found fallback docs/gemini.md §3.4 describes.
- Chat recording on resume, file decoding, ignore files, the IDE client, the interactive UI and the a2a server.

None of it touches the route relay's tools take, or what relay's profile depends on.

## Checks

| Check | Item | Result |
|---|---|---|
| 12 | `j_56786983` | Passed. The session started with relay's discovery. The relay log reads `Gemini (experimental) "0.65.0" speaks ACP 1`. The agent listed exactly the ten `discovered_tool_` tools of relay's `tools.json`. The helper ran as `<node> --no-warnings …/dist/confine/gemini-tools-main.js <home>/relay-tools`, a child of the Gemini harness, and drew no sandbox denial. |
| 13 | `j_56786983` | Passed. `discovered_tool_status` completed with relay's run tree (`{"run_id": "run_f8ccdd5d", …`). No permission request, no `Stderr:` block, no helper `[stderr]` line. The only `[broker]` line is the boundary probe's, made before the harness is bound. |
| 14 | `j_0e38a785` (Codex `t_a2f31bd2`); `j_607bf992` (Codex `j_7f961a57`) | Passed. `discovered_tool_ask` returned `{"reply": "OK", "thread_id": "t_a2f31bd2", …}`. `discovered_tool_delegate`, `background: false`, waited out the 54 s Codex job and returned it; the final message was "DONE". |
| 15 | `j_f516b56e`, and all four | Passed. The model quoted both command strings, which hold paths only. During each turn the bridge secret was in none of `tools.json`, `bridge.json`, the shim or relay's settings; its file was mode 0600. After each turn `relay-tools` was gone, and the secret was in 0 of 500 files under relay's state, the Gemini homes and the worktrees. |
| 1 | `t_8d3c8345` (`auto`, one `read_file`); `t_cd5aa892` (pinned, `ls` and `read_file`) | Passed. `prompt response lists "gemini-3.8-flash", "auto"`, and `"gemini-3.8-flash"`, as on 0.64.0. |
| 4 | the run's 8 agent logs | Passed. The proxy admitted `generativelanguage.googleapis.com:443` 7 times and nothing else. The only denials were relay's read-only settings write (6), Gemini's `DNSConfiguration` lookup (6, all its own Node's) and the node-pty helper (1). No Gemini process's start-up environment held the key (6 processes, count 0). No relay bridge process ran under a Gemini harness. |

Every Gemini turn carried "Gemini CLI takes relay's tools through its own tool discovery, which relay has checked on 0.64.0 only; this is 0.65.0, so this agent's relay tools are offered unverified (allow_untested)." That is the expected warning before the listing. With `0.65.0` listed, the change's test shows the tools offered without `allow_untested` and with no warning.

## Addendum: the check at each launch, live (2026-10-22, `67904a7`)

**What changed.** Relay no longer limits Gemini's tools to an exact version list. It offers them on any version at or above its floor (0.64.0), and checks at each launch that Gemini ran its tool discovery:
- `relay gemini-tools --list` leaves a mark, `.relay-tools-listed`, in the turn's private temporary directory, at the path `bridge.json` names.
- Relay checks for the mark before the prompt.
- `toolDiscovery.versions` (0.64.0, 0.65.0) now names only the versions verified live. A turn on another version gets a note.

**How it was run.** A detached worktree at `67904a7` (branch: a private branch), built. The `tools` scenario, through the driver pointed at that build (`<scratch>/gq-scripts/drive6.mjs`). The driver also watched for the mark at the path `bridge.json` names. The configs had **no `allow_untested`**. Gemini CLI 0.66.0-preview.0 was installed into a new scratch prefix, `<scratch>/gemini-cli-066p`. Everything else was as above.

| Run | Item | Result |
|---|---|---|
| 0.66.0-preview.0 | `j_5322cbdd` | Passed. See below. |
| 0.65.0 | `j_633bbb45` | Passed. See below. |

**0.66.0-preview.0** (`j_5322cbdd`):
- The relay log reads `Gemini (experimental) "0.66.0-preview.0" speaks ACP 1`.
- `bridge.json` named the mark's path, `~/.relay-t/relay-tmp-…/.relay-tools-listed`. The mark appeared there during session setup, holding `listed`.
- Relay logged, before the prompt: `# relay: Gemini CLI 0.66.0-preview.0 is not a version relay's tools were verified live on (0.64.0, 0.65.0); its tool discovery ran at this launch, so its agent had relay's tools.` That note is the turn's one warning.
- The agent listed exactly the ten `discovered_tool_` tools.
- `discovered_tool_status` completed with relay's run tree (`{"run_id": "run_48b66a64", …`). There was no permission request and no `Stderr:` block.
- The prompt had no "Before you start" line.

**0.65.0** (`j_633bbb45`):
- The mark appeared and held `listed`.
- No note: the turn's warnings are empty, and the log has no relay line about discovery.
- The ten tools were listed, and `discovered_tool_status` returned relay's run tree with no `Stderr:` block.
- The prompt had no "Before you start" line.

**In both:**
- The bridge secret was in none of `tools.json`, `bridge.json`, the shim or relay's settings during the turn.
- After the turn `relay-tools` was gone, and the secret was in no file under relay's state, the Gemini homes and the worktrees.
- The only host was `generativelanguage.googleapis.com`.
- The only denials were the settings write and Gemini's own `DNSConfiguration` lookup.
- The key occurred 0 times in the start-up environments and the agent logs.

**A launch where discovery does not run could not be forced with a real binary.** 0.64.0, 0.65.0 and 0.66.0-preview.0 all run discovery while they set up a session (`config.initialize` in `newSession` and `loadSession`; docs/gemini.md §3.8), and no setting of Gemini's turns that off while relay's settings name a discovery command. Making it happen would mean changing Gemini, or relay's settings, which is not what the check is about.

The stub stands in: `STUB_GEMINI_SKIP_DISCOVERY`. Its three tests passed at `67904a7` with a short `TMPDIR`:
- where Gemini does not run discovery, the agent is told before its prompt that it has no relay tools, the turn says so, and it goes on;
- a resumed turn is checked as a new one is;
- an unverified version gets the tools and the note, while one below the floor is refused.
