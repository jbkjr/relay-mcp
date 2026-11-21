// How a launched agent's own text is shown to a person in one line: in relay's approval dialog,
// progress lines, the run tree and event texts. A leaf module, so that core and backends can use it.
import { ROOM_CLIENT_CODE_POINTS, type RoomTextSanitizer } from "./room-types.js";
import { redact } from "./secrets.js";

/**
 * Unicode characters that change how text displays without showing themselves: format characters
 * (category Cf: bidi controls such as U+202E, zero-width characters, U+FEFF, soft hyphens, tags)
 * and the line and paragraph separators U+2028 and U+2029, which some displays break lines at.
 */
const INVISIBLE = /[\p{Cf}\u2028\u2029]/u;

/**
 * Text from a launched agent as one line of the approval dialog, losing nothing: a request whose
 * text has line breaks or other control characters, or invisible format characters (INVISIBLE)
 * that could make it display as something else (a right-to-left override reverses what follows
 * it), is shown escaped (backslashes too, so that the escapes cannot be confused with the text),
 * with how many lines it has, since Claude Code folds everything after the first lines and a
 * second line could otherwise be a hidden second command. Format characters show as \u{XXXX}.
 */
export function shown(text: string, opts: { escapeC1?: boolean } = {}): string {
  const controls = opts.escapeC1 ? /[\u0000-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f]/g;
  if (!controls.test(text) && !INVISIBLE.test(text)) return text;
  const lines = text.split(/\r\n|\r|\n/).length;
  const escaped = text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
    .replace(controls, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(new RegExp(INVISIBLE.source, "gu"), (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`);
  return `(${lines} line${lines === 1 ? "" : "s"}, shown escaped) ${escaped}`;
}

/** Store room text once, after hashing its original, with malformed UTF-16 made displayable. */
// Node >=22.18 has toWellFormed; the repository's ES2023 TypeScript lib does not declare it.
export const roomText: RoomTextSanitizer = (text) => shown((text as string & { toWellFormed(): string }).toWellFormed(), { escapeC1: true });

/** Bound the observed name before escaping; count code points rather than UTF-16 halves. */
export function roomClientName(text: string): string {
  let bounded = "", count = 0;
  for (const c of text) {
    if (count++ === ROOM_CLIENT_CODE_POINTS) break;
    bounded += c;
  }
  return roomText(redact(bounded));
}

/**
 * A launched agent's text (a task, an activity, a value it chose) on one line: its whitespace,
 * line breaks included, flattened to single spaces, then clipped to `max`. What is left that could
 * change how it displays is shown escaped.
 */
export const oneLine = (text: unknown, max: number): string => clipped(String(text ?? "").replace(/\s+/g, " ").trim(), max);

/**
 * shown(text), with the text itself cut to `max` characters (the line count, when there is one, is
 * kept in front): for progress lines, the run tree and event texts, where a long command is cut
 * but its line breaks still show.
 */
export function clipped(text: string, max: number): string {
  const s = shown(text);
  const head = /^\(\d+ lines?, shown escaped\) /.exec(s)?.[0] ?? "";
  const body = s.slice(head.length);
  return head + (body.length > max ? `${body.slice(0, max - 1)}…` : body);
}
