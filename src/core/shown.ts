// How a launched agent's own text is shown to a person in one line: in relay's approval dialog,
// progress lines, the run tree and event texts. A leaf module, so that core and backends can use it.

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
export function shown(text: string): string {
  if (!/[\u0000-\u001f\u007f]/.test(text) && !INVISIBLE.test(text)) return text;
  const lines = text.split(/\r\n|\r|\n/).length;
  const escaped = text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(new RegExp(INVISIBLE.source, "gu"), (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`);
  return `(${lines} line${lines === 1 ? "" : "s"}, shown escaped) ${escaped}`;
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
