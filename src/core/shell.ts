/** One literal POSIX shell argument, including spaces, quotes and shell metacharacters. */
export const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
