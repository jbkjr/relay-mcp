// Secrets relay knows the shape of, kept out of what it writes (agents' logs, final messages,
// errors, activity, prompts' copies, transcripts, its own diagnostic logs). By value: the values of
// variables in the environment relay passes to agents whose names say they hold a secret (a token,
// a key, a password), and the password in a proxy URL (and its Basic form). By shape alone, for
// what relay cannot know by value: the vendor credentials relay handles, by their published
// prefixes; a URL's password; an Authorization header's credentials (Bearer, Basic or Token ones
// of 8 characters or more, token-like ones after any other scheme or none); and a token-like value
// given to a variable or a key whose name says it holds a secret. The last three cover the per-turn
// proxy token and bridge secret relay hands a confined agent; those are also registered by value
// in the turn's private scope below. A value known by value is cut wherever its text appears, in each of the forms it
// takes (formsOf), as a word of a reply too, so a variable whose name only might be a secret's (a
// CREDENTIAL_STORE, a CACHE_KEY) has its value cut only when it looks like a token (tokenLike).
// Names are read in camelCase as in snake_case (nameWords).

import { AsyncLocalStorage } from "node:async_hooks";

// Each turn keeps its generated credentials until its results and errors have been persisted,
// including after the proxy and broker close. Concurrent turns never share these values.
const turnSecrets = new AsyncLocalStorage<Map<string, string>>();

// A worker learns these from its owning root over a peer-bound broker claim, never through
// process.env. They exist only to cut records; no launch/bridge environment consumes this set.
const rootSecretForms = new Set<string>();
let rootSecretPattern: RegExp | null = null;
export function registerRootRedactionValues(values: readonly string[]): void {
  for (const value of values) for (const form of formsOf(value)) if (form) rootSecretForms.add(form);
  rootSecretPattern = rootSecretForms.size
    ? new RegExp([...rootSecretForms].sort((a, b) => b.length - a.length).map(escape).join("|"), "g") : null;
}
function cutRootSecrets(text: string): string {
  return rootSecretPattern ? text.replace(rootSecretPattern, REDACTED) : text;
}

export function withTurnSecrets<T>(run: () => T, o: { reuse?: boolean } = {}): T {
  return o.reuse && turnSecrets.getStore() ? run() : turnSecrets.run(new Map(), run);
}

/** Register before handing a generated credential to the harness. Never persist its value. */
export function registerTurnSecret(value: string, kind: "proxy token" | "bridge secret" | "environment value" | "executor token" | "broker token"): void {
  const scope = turnSecrets.getStore();
  if (!scope) throw new Error("a generated credential needs a turn redaction scope");
  for (const form of formsOf(value)) if (form) scope.set(form, `[redacted: ${kind}]`);
}

/**
 * Direct backend unit calls have no turn; production launches run inside withTurnSecrets. Only a
 * value worth cutting wherever it appears is registered (secretLike): a released flag such as "1",
 * a number or a path is no secret, and cutting it by value would garble every log and result that
 * mentions it (an exit code or a path). Longer control strings are registered too; fixtures
 * must not use the exact prose/model name their assertions expect as a released control value.
 */
export function registerReleasedEnvironment(env: NodeJS.ProcessEnv, names: readonly string[]): void {
  if (!turnSecrets.getStore()) return;
  for (const name of names) if (env[name] !== undefined && secretLike(env[name]!)) registerTurnSecret(env[name]!, "environment value");
}

function cutTurnSecrets(text: string, scope: Map<string, string> | undefined): string {
  if (!scope?.size || !text) return text;
  const literal = new RegExp([...scope.keys()].sort((a, b) => b.length - a.length).map(escape).join("|"), "g");
  return text.replace(literal, (value) => scope.get(value)!);
}

// Every pattern below costs at most a bounded amount of work from each place it can start, so
// that one long line of an agent's output (a tool's whole output is one event) is cut in time
// linear in its length: a quantifier that could scan to the end of a long run from each start, or
// a lookahead that does, would take minutes on a crafted line, and stall the worker that cuts it.

/**
 * A variable in relay's environment whose name says its value is a secret: the secret's word ends
 * the name (GH_TOKEN, NEXTAUTH_SECRET, DB_PASSWORD, AWS_SECRET_ACCESS_KEY); a password's word
 * glued to what it is for (libpq's PGPASSWORD); or _PWD (MySQL's MYSQL_PWD; not PWD or OLDPWD,
 * the working directories). Its value is cut wherever it appears (secretLike).
 */
const SECRET_VALUE_NAME = /(?:(?:^|_)(?:TOKEN|SECRET|(?:API|ACCESS|PRIVATE|SECRET|SIGNING|ENCRYPTION)_?KEY)|PASSWORD|PASSWD|PASSPHRASE|_PWD)$/i;
/**
 * A variable in relay's environment whose name may be a secret's, or says something about one
 * (AWS_ACCESS_KEY_ID, a CREDENTIAL_STORE, an AUTH_MODE, any name ending in _KEY): its value is cut
 * wherever it appears only when it looks like a token (tokenLike), not when it is a word, words or
 * a time, which a reply can hold for other reasons.
 */
const SECRET_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)(?:_|$)|_KEY$/i;
/**
 * A variable or key next to a value relay does not know, whose name says plainly that it holds a
 * secret (as nameWords spells it). Narrower than SECRET_NAME: a bare _KEY (cache_key, primary_key,
 * idempotency_key) names ordinary data as often as a secret, and the text it is cut from can be an
 * agent's reply.
 */
const SECRET_CONTEXT_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|(?:API|ACCESS|PRIVATE|SECRET|SIGNING|ENCRYPTION)_?KEY|CREDENTIALS?|AUTH)(?:_|$)|(?:PASSWORD|PASSWD|PASSPHRASE|_PWD)$/i;
/** Tokens named for what they page through, not what they open. */
const NOT_SECRET_NAME = /(?:^|_)(?:NEXT|PAGE|NEXT_PAGE|CONTINUATION|CURSOR|SYNC)_?TOKEN$/i;
/**
 * A name with its words parted by `_` where camelCase parts them by case, so that the rules above
 * read JSON's and JavaScript's spelling as they read a variable's: accessToken as access_Token,
 * clientSecret as client_Secret, secretAccessKey as secret_Access_Key, npm's _authToken as
 * _auth_Token. maxTokens (max_Tokens) and authorName (author_Name) still name no secret.
 */
const nameWords = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
const PROXY_NAME = /^(?:https?|all|ftp)_proxy$/i;
/** Credentials by their shape: Anthropic's keys and OAuth tokens, OpenAI's keys (with a digit in them: checked in cut), xAI's keys, GitHub's tokens. */
/**
 * A relay session token's shape, in any case (session-token.ts issues them lowercase): a bearer key
 * a conversation's model carries on a shared relay. Cut wherever an agent writes one, so that relay
 * neither keeps nor returns it.
 */
export const SESSION_TOKEN_SHAPE = /rs1_[0-9a-f]{56}/i;
const SHAPES: [RegExp, (match: string) => boolean][] = [
  [new RegExp(SESSION_TOKEN_SHAPE.source, "gi"), () => true],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, () => true],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, (m) => /\d/.test(m.replace(/^sk-(?:proj-|svcacct-|admin-)?/, ""))],
  // xAI's official SDK uses (?i)xai-[a-z0-9]{20,80}; keep longer matches whole too, as above.
  // https://github.com/xai-org/xai-sdk-python/blob/ddc27ddf06dd9799058c44def8818aa496ba1722/.gitleaks.toml#L7
  [/\bxai-[A-Za-z0-9]{20,}/gi, () => true],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, () => true],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}/g, () => true],
];
export const REDACTED = "[redacted]";

/** Admission primitive, independent of replacement text or a variable's name. Linear bounded patterns. */
export function recognizedSecretShape(value: string): boolean {
  for (const [pattern, is] of SHAPES) {
    const scan = new RegExp(pattern.source, pattern.flags);
    for (let m = scan.exec(value); m; m = scan.exec(value)) if (is(m[0])) return true;
  }
  if (/-----BEGIN (?:[A-Z0-9 ]{0,40} )?PRIVATE KEY-----/.test(value)) return true;
  if (/\b(?:Bearer|Basic|Token)[ \t]{1,8}[A-Za-z0-9._~+/=-]{8,}/i.test(value)) return true;
  if (/\bAKIA[A-Z0-9]{16}\b/.test(value)) return true;
  if (/"(?:private_key|client_secret|access_token)"[ \t\r\n]{0,32}:[ \t\r\n]{0,32}"[^"\r\n]{1,4096}"/.test(value)) return true;
  if (/\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@"'<>]{0,256}:[^\s@/"'<>]{1,4096}@/i.test(value)) return true;
  return false;
}

/** Whether a variable's value is worth cutting wherever it appears: long enough, and not a path or a number. */
const secretLike = (v: string) => v.length >= 8 && !/^[/~.]/.test(v) && !/^\d+$/.test(v);
/** A word of a value: its letters in one case or capitalised, then up to three digits (v2, oauth2, x509, Rs256); or a short number (2026). */
const WORD = /^(?:[a-z]+|[A-Z]+|[A-Z][a-z]+)\d{0,3}$|^\d{1,4}$/;
/** Whether a value is words joined by _ - . or /: an enum (oauth2_device_flow_v2), a relative path (secrets/token_v2.json). */
const words = (v: string) => {
  const parts = v.split(/[_./-]/);
  return parts.length >= 2 && parts.every((p) => WORD.test(p));
};
/** A date, or a date and time, as ISO 8601 and RFC 3339 write them (2026-10-19, 2026-10-19T03:00:00Z): an expiry, not a secret. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;
/** An identifier in camel or Pascal case (getAccessToken, SomeProviderName): code, not a token, where it has no digit. */
const CAMEL = /^[a-z]*(?:[A-Z][a-z]+)+$/;
/**
 * Whether a value found next to a secret's name looks like a secret rather than code, a URL, a
 * time or words: 16 characters or more of a token's alphabet with letters and digits both, or 24
 * or more in both cases and no digit (a base64url secret can draw none) that is not an identifier;
 * not a path, not a URL (the rule for a URL's password cuts what of it is secret), not a date or
 * time, and not words (see words). A token's random characters (a UUID, base64) are not words,
 * separators or not.
 */
const tokenLike = (v: string) => v.length >= 16 && /[A-Za-z]/.test(v) && !/^[/~.]/.test(v) && !v.includes("://") && !words(v) && !TIMESTAMP.test(v)
  && (/\d/.test(v) || (v.length >= 24 && /[a-z]/.test(v) && /[A-Z]/.test(v) && !CAMEL.test(v)));

/** The schemes of an Authorization header whose credentials are cut at 8 characters or more, token-like or not. */
const KNOWN_SCHEME = /^(?:Bearer|Basic|Token)$/i;

/** Secrets by their context, each with what is kept of a match. Applied after the values, so a value already cut is not matched again. */
const CONTEXTS: [RegExp, (match: string, ...groups: string[]) => string][] = [
  // A URL's password, scheme://user:password@, however short: not a reference to one ($VAR, ${...},
  // <...>, %s). The scheme is bounded (32 characters), and the user and the password both stop at
  // a slash, as the next start's :// has one: from each start, the scan ends where the next could begin.
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@"'<>]*:)([^\s@/"'<>]+)@/gi, (m, before, pass) => (/^[$<{%*[]/.test(pass) ? m : `${before}${REDACTED}@`)],
  // An Authorization or Proxy-Authorization header's credentials: as a header line
  // (`Authorization: Bearer x`), a JSON key (`"Authorization": "Bearer x"`, its quotes escaped too,
  // inside a JSON string) or a TOML or shell assignment (`Authorization = "Bearer x"`). After a
  // scheme (one word, bounded) or none: those of Bearer, Basic or Token at 8 characters or more,
  // any other only when they look like a token (an ApiKey's, a Bot's, a bare one). Digest's
  // parameters are not cut.
  [/\b((?:Proxy-)?Authorization\\*"?[ \t]{0,8}[:=][ \t]{0,8}\\*"?[ \t]{0,8})(?:([A-Za-z][A-Za-z0-9_-]{0,31})([ \t]{1,8}))?([A-Za-z0-9._~+/=-]+)/gi,
    (m, before, scheme, space, creds) => ((scheme && KNOWN_SCHEME.test(scheme) ? creds.length >= 8 : tokenLike(creds)) ? `${before}${scheme ?? ""}${space ?? ""}${REDACTED}` : m)],
];

/**
 * The head of an assignment or a key, whose value is read after it (VALUE): `NAME=value`;
 * `NAME="value"` and `name = 'value'` (shell, TOML, INI, code: with spaces around the = only when
 * the value is quoted); `name: value` (YAML); and `"name": "value"` (JSON, or a Python dict's
 * single quotes, and with its quotes escaped inside a JSON string). The name stops where a word
 * does, so a scan of it from one start ends where the next start could be.
 */
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)(\\*["'][ \t]{0,8}:[ \t]{0,8}\\*["']|[ \t]{0,8}=[ \t]{0,8}(?:\\*"|')|=|:[ \t]{1,8}(?:\\*"|')?)/g;
const VALUE = /[A-Za-z0-9_\-+/=.~:]+/y;

/**
 * Cuts a token-like value given to a name that plainly names a secret. A name that does not is
 * passed over, but not what follows it, which can itself be an assignment: in
 * `--from-literal=API_TOKEN=x` or `--build-arg=NPM_TOKEN=x`, `literal=` is passed over and
 * `API_TOKEN=x` read next. A secret's value is read once, so the work stays linear.
 */
function cutAssignments(text: string): string {
  let out = "";
  let kept = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(text); m; m = ASSIGNMENT.exec(text)) {
    const name = nameWords(m[1]);
    if (!SECRET_CONTEXT_NAME.test(name) || NOT_SECRET_NAME.test(name)) continue;
    const at = m.index + m[0].length;
    VALUE.lastIndex = at;
    const value = VALUE.exec(text)?.[0];
    if (!value) continue;
    if (tokenLike(value)) {
      out += text.slice(kept, at) + REDACTED;
      kept = at + value.length;
    }
    ASSIGNMENT.lastIndex = at + value.length;
  }
  return kept ? out + text.slice(kept) : text;
}

/** The secret values in an environment: see the top of this file. */
export function secretValues(env: NodeJS.ProcessEnv | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v !== "string" || !v) continue;
    if (PROXY_NAME.test(k)) {
      try {
        const u = new URL(v);
        const pass = decodeURIComponent(u.password);
        if (pass && secretLike(pass)) {
          out.push(pass, u.password);
          out.push(Buffer.from(`${decodeURIComponent(u.username)}:${pass}`).toString("base64"));
        }
      } catch {
        // Not a URL: nothing in it relay knows to be a secret.
      }
      continue;
    }
    const name = nameWords(k);
    if (SECRET_VALUE_NAME.test(name) ? secretLike(v) : SECRET_NAME.test(name) && secretLike(v) && tokenLike(v)) out.push(v);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The armour around a PEM block, which says what the block holds and is no part of the secret. */
const ARMOUR = /^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/;

/**
 * The forms a secret's text takes where relay meets it, beside the text itself: trimmed of the
 * whitespace around it (a value read from a file, or from a CRLF .env, ends in a line break); each
 * line of one that has several (a PEM key, printed a line at a time, and an agent's log is cut a
 * line at a time), when the line is 16 characters or more with no space in it and is not the armour
 * around a key; percent-encoded, as in a URL, with its hex in either case; and JSON-escaped, once
 * (an agent's event stream) or twice (a tool's arguments given as a JSON string inside an event).
 */
function formsOf(v: string): string[] {
  const bases = [v];
  const trimmed = v.trim();
  if (trimmed !== v && secretLike(trimmed)) bases.push(trimmed);
  if (/[\r\n]/.test(trimmed)) {
    for (const line of trimmed.split(/\r?\n|\r/)) {
      const l = line.trim();
      if (l.length >= 16 && !/\s/.test(l) && !ARMOUR.test(l)) bases.push(l);
    }
  }
  const out = new Set<string>();
  for (const b of bases) {
    out.add(b);
    try {
      const url = encodeURIComponent(b);
      out.add(url);
      out.add(url.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    } catch {
      // A lone surrogate, which no URL holds.
    }
    let json = b;
    for (let depth = 0; depth < 2; depth++) {
      const next = JSON.stringify(json).slice(1, -1);
      if (next === json) break;
      out.add(next);
      json = next;
    }
  }
  return [...out];
}

/** Every by-value form the ordinary redactor cuts, captured after turn credentials register. */
export function streamSecretValues(extra: readonly string[] = [], ...envs: (NodeJS.ProcessEnv | undefined)[]): string[] {
  const values = new Set([...rootSecretForms, ...(turnSecrets.getStore()?.keys() ?? [])]);
  for (const v of [...extra, ...[process.env, ...envs].flatMap(secretValues)]) {
    for (const form of formsOf(v)) if (form) values.add(form);
  }
  return [...values];
}

/**
 * A function that cuts every secret of these environments out of a text, in each of its forms
 * (formsOf), and the secrets known by their shape or their context whatever the environment.
 */
function environmentRedactor(...envs: (NodeJS.ProcessEnv | undefined)[]): (text: string) => string {
  const values = new Set<string>();
  for (const env of envs) {
    for (const v of secretValues(env)) for (const form of formsOf(v)) values.add(form);
  }
  const literal = values.size ? new RegExp([...values].sort((a, b) => b.length - a.length).map(escape).join("|"), "g") : null;
  return (text: string) => {
    if (!text) return text;
    let out = literal ? text.replace(literal, REDACTED) : text;
    for (const [shape, is] of SHAPES) out = out.replace(shape, (m) => (is(m) ? REDACTED : m));
    for (const [shape, keep] of CONTEXTS) out = out.replace(shape, keep as (m: string, ...g: string[]) => string);
    return cutAssignments(out);
  };
}

/** Capture the turn's mutable set too, so stream callbacks keep their turn's redactor. */
export function redactor(...envs: (NodeJS.ProcessEnv | undefined)[]): (text: string) => string {
  const scope = turnSecrets.getStore();
  const cut = environmentRedactor(...envs);
  return (text) => cut(cutRootSecrets(cutTurnSecrets(text, scope)));
}

let own: ((text: string) => string) | null = null;
/** Cuts this process's secrets, root redaction-only values, and the current turn's secrets. */
export function redact(text: string): string {
  own ??= environmentRedactor(process.env);
  return own(cutRootSecrets(cutTurnSecrets(text, turnSecrets.getStore())));
}
