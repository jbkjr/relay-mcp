import { shellQuote } from "../core/shell.js";
import { z } from "zod";
import type { TargetDef } from "./types.js";

// Naming evidence, not endpoint authentication. Opaque Bedrock application-profile ARNs do not
// expose a model and stay unknown; an ARN carrying a Claude model id can be recognised locally.
const model = String.raw`claude-(?:(?:opus|sonnet|haiku)-\d+(?:[.-]\d+)*|v?\d+(?:[.:-]\d+)*(?:-(?:opus|sonnet|haiku)(?:-\d{8})?)?|instant-v?\d+(?:[.:]\d+)*)(?:-latest)?(?:-v\d+(?::\d+)*(?::\d+k)?)?(?:@\d{8})?(?:\[1m\])?`;
// Geographic profiles are not a closed list (AWS added jp. and au., for example).
// https://aws.amazon.com/blogs/machine-learning/introducing-amazon-bedrock-cross-region-inference-for-claude-sonnet-4-5-and-haiku-4-5-in-japan-and-australia/
const bedrock = String.raw`(?:[a-z]+(?:-[a-z]+)*\.)?anthropic\.${model}`;
const ownModels = new RegExp(String.raw`^(?:(?:opus|sonnet|haiku|opusplan)(?:\[1m\])?|${model}|${bedrock}|arn:aws(?:-us-gov|-cn)?:bedrock:[a-z0-9-]+:(?:\d{12})?:(?:foundation-model|inference-profile|application-inference-profile)/${bedrock})$`, "i");

// How a Claude turn is sent to its web tools. The prompt is rendered from the run's captured
// config, which cannot say whether this turn's settings deny them: the run's durable never floor
// can gain a host after capture (core/never-checkpoint.ts), and the person's own deny rules are
// copied in (backends/claude.ts userDenyRules); either denies them outright, without a prompt. So
// the wording never promises an approval prompt, and says what to do after a policy denial.
const WEB_TOOLS = "WebSearch or WebFetch, which, depending on permission policy, may already be allowed, may ask for approval, or may be denied outright";
const AFTER_POLICY_DENIAL = "If policy denies them, do not retry them or ask again: finish what you can and report what you needed.";

/** Claude Code, run headless (`claude -p`). */
export const claude: TargetDef = {
  id: "claude",
  vendor: "anthropic",
  ownModels,
  enabledByDefault: true,
  defaultBin: "claude",
  name: "Claude",
  product: "Claude Code",
  reviewPrefix: "C",
  clientNames: /claude/i,
  tested: [2, 1, 302],
  credentialEnv: /^(ANTHROPIC_(API_KEY|AUTH_TOKEN)|CLAUDE_CODE_(OAUTH_TOKEN|USE_.*))$/,
  endpointEnv: /^ANTHROPIC_(\w+_)?BASE_URL$/,
  // `--permission-prompt-tool mcp__relay__permission_prompt`: Claude sends what would prompt to relay.
  approvals: {
    channel: "relay-tool",
    tool: {
      inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
      toAsk(call) {
        const tool = String(call.tool_name);
        const input = call.input as Record<string, unknown>;
        return tool === "WebSearch" ? { kind: "web", summary: `web search: ${String(input.query ?? "")}` }
          : tool === "WebFetch" ? { kind: "web", summary: `fetch ${String(input.url ?? "")}` }
          // A command asks either to leave the sandbox (dangerouslyDisableSandbox) or, sandboxed, because
          // nothing allowed it automatically. Allowed, it goes ahead as asked, so only the first runs unconfined.
          : tool === "Bash" ? {
            kind: "command", summary: String(input.command ?? ""), reason: typeof input.description === "string" ? input.description : undefined,
            ...(input.dangerouslyDisableSandbox === undefined || input.dangerouslyDisableSandbox === false ? { detail: { sandboxed: true } } : {}),
          }
          : typeof input.file_path === "string" ? { kind: "file", summary: `${tool} ${input.file_path}`, paths: [input.file_path] }
          // The whole input, uncut: allowing runs the call with all of it, so all of it is what is
          // shown (the dialog shows it through shown(); JSON keeps it on one line).
          : { kind: "tool", summary: `${tool} ${JSON.stringify(input)}` };
      },
      // An allowed call goes ahead with its own input, unchanged: a sandboxed command stays sandboxed.
      reply: (call, decision) => decision.allow ? { behavior: "allow", updatedInput: call.input } : { behavior: "deny", message: decision.message },
    },
  },
  resumeCommand: (sessionId) => `claude --resume ${shellQuote(sessionId)}`,
  capabilities: { subagents: "never", confinement: "verified", readOnly: true, networkOff: true, writeRoots: true, approvals: "native", escalation: true, resume: true, login: "account-verified", extensions: true },
  // Fast mode: the fastMode setting, which relay passes in its --settings file (Claude Code's
  // flag settings, which also count as the opt-in a headless session needs; checked in 2.1.302).
  // Claude Code offers it for Opus 5.5, 5 and 4.8 (code.claude.com/docs/en/fast-mode, 2026-10-16;
  // in 2.1.302 a model whose id has opus-5 or opus-4-8 in it). The opus alias is the latest Opus.
  // Any other alias, or "default", is for Claude to say: it reports whether the turn ran fast.
  speeds: {
    fast: {
      id: "fastMode",
      models: {
        names: "Opus 5.5, Opus 5 and Opus 4.8",
        has: (model) => (/opus-(?:5|4-8)(?![\d.])/i.test(model) || /^opus(?:\[1m\])?$/i.test(model) ? true
          : /^(?:sonnet|haiku)(?:\[1m\])?$/i.test(model) || /claude-/i.test(model) ? false : null),
      },
    },
  },
  qualified: true,
  text: {
    // Claude jobs always run under the never floor (core/never-coverage.ts): its settings switch off
    // Claude's unsandboxed retry and relay refuses a command approval, so no command is offered a way out.
    blockedHow: (mode) => mode === "write"
      ? "make the edit with your file tools, which ask for approval when it is outside what your sandbox allows. A command the sandbox blocks cannot be approved to run outside it: report it under Open issues"
      : `use ${WEB_TOOLS}. ${AFTER_POLICY_DENIAL} A command the sandbox blocks cannot be approved to run outside it: report it in your final message`,
    // So a command is never among what a Claude turn may ask for. A write turn asks for a path through
    // its file tools (the web, where it can ask for it, is in shellNetwork). A read turn can ask only
    // through its web tools, and not when the turn already has the network (backends/claude.ts allows
    // them outright) or the captured never.hosts denies them (applyClaudeNeverPolicy): then it has
    // nothing to ask for. Where neither is known, policy may still deny them, as WEB_TOOLS says.
    blockedAsks: (mode, { network, webDenied }) => mode === "write" ? "a path outside your worktree"
      : !network && !webDenied ? "web access" : null,
    // Claude Code's sandbox decides network access for commands by itself under -p: its question is
    // never sent to relay's permission tool. WebFetch and WebSearch can ask, where policy leaves them.
    shellNetwork: (canAsk) =>
      "Your shell commands have no network access: the sandbox refuses connections by itself, and nobody is asked, so a refusal it reports (whatever reason it gives) is not a person's decision. " +
      (canAsk
        ? `To read the web, use ${WEB_TOOLS}. ${AFTER_POLICY_DENIAL} If a command itself needs the network, do not retry it with the sandbox disabled (that is refused); say under Open issues that you need a network grant (the root session can give one when it resumes you).`
        : "If you need the web or the network, say under Open issues that you need a network grant (the root session can give one when it resumes you)."),
  },
};
