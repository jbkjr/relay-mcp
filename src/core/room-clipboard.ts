// Revision 3, part A (docs/design-rooms.md): in the person's own terminal on macOS, offer each
// seat's prompt on the clipboard in turn, so that they paste rather than select long text. The
// prompts are printed first all the same; the clipboard is only a convenience over that fallback.
// An invite is on the clipboard only while the flow runs: it ends by clearing the clipboard if it
// still holds one of this flow's invites (or if relay cannot tell), on every way out, Ctrl-C and
// end of input included. Nothing here logs or stores a prompt.
import { spawnSync } from "node:child_process";
import { systemTool } from "./executables.js";

export interface Clipboard {
  /** Puts `text` on the clipboard; false if that failed. */
  copy(text: string): boolean;
  /** What the clipboard holds, or null where it cannot be read. */
  read(): string | null;
}

/**
 * macOS's pasteboard through /usr/bin/pbcopy and /usr/bin/pbpaste, by their fixed paths; inside
 * relay's own test suite only, through its stand-ins (executables.ts systemTool), so that no test
 * touches the person's clipboard.
 */
export const pasteboard: Clipboard = {
  copy: (text) => spawnSync(systemTool("/usr/bin/pbcopy"), [], { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 }).status === 0,
  read: () => {
    const r = spawnSync(systemTool("/usr/bin/pbpaste"), [], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return r.status === 0 ? r.stdout : null;
  },
};

/** The flow is offered only on macOS, with both ends of the terminal interactive. */
export function clipboardOffered(platform: NodeJS.Platform = process.platform, stdinTTY = Boolean(process.stdin.isTTY), stdoutTTY = Boolean(process.stdout.isTTY)): boolean {
  return platform === "darwin" && stdinTTY && stdoutTTY;
}

export interface ClipboardIO {
  /** Shows `question` and resolves with the line typed, or null at the end of input. */
  ask(question: string): Promise<string | null>;
  say(line: string): void;
}

export interface ClipboardPrompt { label: string; text: string }

/** What clearing found: cleared (verified where readable), left alone (no invite on it), or failed. */
export type ClearOutcome = "cleared" | "left" | "failed";

/** Said when clearing failed: the person must replace the clipboard themselves. */
export const CLEAR_FAILED = "relay could not clear the clipboard, so it may still hold a room invite. Copy something else now to replace it.";

/**
 * Clears the clipboard if it holds any of `secrets`, or if it cannot be read. Synchronous, so that
 * a signal handler can call it before the process exits. A clear counts only if the copy succeeded
 * and, where the clipboard can be read, it no longer holds an invite.
 */
export function clearInvites(clip: Clipboard, secrets: readonly string[]): ClearOutcome {
  const holds = (text: string | null) => text === null || secrets.some((s) => text.includes(s));
  if (!holds(clip.read())) return "left";
  if (!clip.copy("")) return "failed";
  const after = clip.read();
  return after !== null && holds(after) ? "failed" : "cleared";
}

/**
 * Offers `prompts` on the clipboard one at a time, each replacing the last only after the person
 * presses Enter, and clears the clipboard at the end. Typing n (or anything starting with n) skips
 * or stops; end of input stops. `onCopying` lets the caller arm its signal handlers before the
 * first copy is attempted (a failing pbcopy can still have changed the pasteboard). Resolves with
 * what happened.
 */
export async function clipboardFlow(
  prompts: readonly ClipboardPrompt[], secrets: readonly string[], io: ClipboardIO, clip: Clipboard = pasteboard, onCopying: () => void = () => {},
): Promise<"done" | "skipped" | "stopped" | "failed"> {
  const no = (answer: string | null) => answer === null || /^\s*n/i.test(answer);
  const ordinal = (i: number) => (prompts.length === 1 ? "the intended" : i === 0 ? "the first" : "the second");
  let attempted = false, copied = false, outcome: "done" | "skipped" | "stopped" | "failed" = "done";
  try {
    for (let i = 0; i < prompts.length; i++) {
      const question = i === 0
        ? `Copy ${prompts.length === 1 ? "this prompt" : "each prompt"} to the clipboard${prompts.length === 1 ? "" : " in turn"}? Press Enter to copy ${prompts[0].label}'s prompt, or type n to skip.`
        : `${prompts[i - 1].label}'s prompt is on the clipboard. Paste it into ${ordinal(i - 1)} conversation, then press Enter to copy ${prompts[i].label}'s prompt (n to stop).`;
      if (no(await io.ask(question))) {
        outcome = i === 0 ? "skipped" : "stopped";
        return outcome;
      }
      attempted = true;
      onCopying();
      if (!clip.copy(prompts[i].text)) {
        io.say("relay could not use the clipboard; paste the prompts printed above instead.");
        outcome = "failed";
        return outcome;
      }
      copied = true;
    }
    const last = prompts[prompts.length - 1];
    await io.ask(`${last.label}'s prompt is on the clipboard. Paste it into ${ordinal(prompts.length - 1)} conversation, then press Enter to clear the clipboard.`);
    return outcome;
  } finally {
    // Also after a copy that failed: it may have changed the pasteboard all the same.
    if (attempted) {
      const cleared = clearInvites(clip, secrets);
      if (cleared === "cleared") io.say("Clipboard cleared.");
      else if (cleared === "failed") io.say(CLEAR_FAILED);
      else if (copied) io.say("The clipboard no longer holds an invite; left it as it is.");
    }
  }
}
