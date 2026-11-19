// A canonical form of minified JavaScript, for telling whether two builds of a bundle hold the same
// code under different minified names (the maintainer's release checks, and the qualifier's tests).
//
// The scanner reads what Bun's minified output contains: strings, template literals (their
// substitutions read as code), regular expressions, numbers, identifiers, punctuation, comments.
// Canonicalisation renames the identifiers a minifier picks (three characters or fewer) to $1, $2, …
// in order of first appearance across all the segments given, so two inputs come out the same
// exactly when one is the other under a one-to-one renaming of those names. Kept as written:
// keywords, a few short globals, property names after `.` or `?.`, object keys (shorthand and
// method names included), class member names, and every name of four characters or more. A name bound by an import of a Node built-in
// (`import{openSync as pe}from"fs"`) is replaced by what it imports (`fs.openSync`), so a renamed
// import still compares equal and a changed one does not.

const KEYWORDS = new Set(("break case catch class const continue debugger default delete do else export extends false finally for " +
  "function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static " +
  "async await of get set as from undefined").split(" "));
const SHORT_GLOBALS = new Set(["Map", "Set", "URL", "NaN"]);
const CONTEXTUAL = new Set(["of", "get", "set", "as", "from", "async", "static"]);
const PUNCT = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
const REGEX_AFTER_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^",
  "=>", "==", "===", "!=", "!==", "<=", ">=", "&&", "||", "??", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "&&=", "||=", "??=", "...", "**"]);
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

const isIdStart = (c) => /[A-Za-z_$#]/.test(c) || c.charCodeAt(0) >= 0x80;
const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

/**
 * Tokens of `src`, each { t: "id" | "str" | "tpl" | "num" | "re" | "p", v, start, end }. A template
 * literal comes as "tpl" pieces (`` `text${ ``, `}text${`, `` }text` ``) around the tokens of its
 * substitutions. `untilBalanced`: stop after the "}" that closes the first "{". Throws on what it
 * cannot read (an unterminated string, unbalanced braces); callers count that as a difference.
 */
export function scan(src, { untilBalanced = false } = {}) {
  const out = [];
  const braces = []; // "{" for a block or object, "tpl" for a template substitution
  let i = 0, opened = false;
  const regexAllowed = () => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (p.t === "p") return REGEX_AFTER_PUNCT.has(p.v);
    if (p.t === "id") return REGEX_AFTER_WORD.has(p.v);
    return false;
  };
  const template = (from) => {
    for (let j = from; j < src.length; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === "`") return { end: j + 1, open: false };
      if (src[j] === "$" && src[j + 1] === "{") return { end: j + 2, open: true };
    }
    throw new Error(`unterminated template literal at ${from}`);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\n" || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e === -1 ? src.length : e + 1; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e === -1) throw new Error(`unterminated comment at ${i}`);
      i = e + 2; continue;
    }
    let tok;
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n") throw new Error(`newline in a string at ${i}`);
      }
      if (j >= src.length) throw new Error(`unterminated string at ${i}`);
      tok = { t: "str", v: src.slice(i, j + 1), start: i, end: j + 1 };
    } else if (c === "`" || (c === "}" && braces[braces.length - 1] === "tpl")) {
      if (c === "}") braces.pop();
      const r = template(i + 1);
      if (r.open) braces.push("tpl");
      tok = { t: "tpl", v: src.slice(i, r.end), start: i, end: r.end };
    } else if (c === "/" && regexAllowed()) {
      let j = i + 1, cls = false;
      for (; j < src.length; j++) {
        const d = src[j];
        if (d === "\\") { j++; continue; }
        if (d === "\n") throw new Error(`newline in a regular expression at ${i}`);
        if (cls) { if (d === "]") cls = false; } else if (d === "[") cls = true; else if (d === "/") break;
      }
      if (j >= src.length) throw new Error(`unterminated regular expression at ${i}`);
      j++;
      while (j < src.length && /[a-z]/.test(src[j])) j++;
      tok = { t: "re", v: src.slice(i, j), start: i, end: j };
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < src.length && /[0-9A-Za-z_.]/.test(src[j])) {
        if (/[eE]/.test(src[j]) && /[+-]/.test(src[j + 1] ?? "") && !/^0[xX]/.test(src.slice(i, j))) j++;
        j++;
      }
      tok = { t: "num", v: src.slice(i, j), start: i, end: j };
    } else if (isIdStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdPart(src[j])) j++;
      tok = { t: "id", v: src.slice(i, j), start: i, end: j };
    } else {
      let p = PUNCT.find((q) => src.startsWith(q, i));
      if (p === "?." && /[0-9]/.test(src[i + 2] ?? "")) p = undefined; // a?.5:1 is a conditional
      p ??= c;
      if (p === "{") { braces.push("{"); opened = true; }
      else if (p === "}") { if (!braces.length) throw new Error(`unbalanced "}" at ${i}`); braces.pop(); }
      tok = { t: "p", v: p, start: i, end: i + p.length };
    }
    out.push(tok);
    i = tok.end;
    if (untilBalanced && opened && braces.length === 0) return out;
  }
  if (braces.length) throw new Error("unbalanced braces");
  return out;
}

export const tokenize = (src) => scan(src);

/**
 * The function whose body holds offset `at` of `text`: { start, end, name } for the nearest
 * `function NAME(…){…}` before `at` whose braces close after it, or null. Looks back at most `back`
 * characters.
 */
export function enclosingFunction(text, at, back = 40000) {
  for (let k = text.lastIndexOf("function", at); k !== -1 && k >= at - back; k = text.lastIndexOf("function", k - 1)) {
    if (k > 0 && isIdPart(text[k - 1])) continue;
    const open = text.indexOf("{", k);
    if (open === -1 || open > at) continue;
    let toks;
    try { toks = scan(text.slice(open, Math.min(text.length, open + back * 4)), { untilBalanced: true }); } catch { continue; }
    const last = toks[toks.length - 1];
    if (!last || last.v !== "}") continue;
    const end = open + last.end;
    if (end <= at) continue;
    const name = /^function\s*\*?\s*([A-Za-z_$][\w$]*)?/.exec(text.slice(k, open))?.[1] ?? null;
    return { start: k, end, name };
  }
  return null;
}

/** The run of `import…from"…";` statements that ends exactly at offset `at` of `text`: its start offset (`at` when there is none). */
export function importRunBefore(text, at) {
  let start = at;
  for (;;) {
    const head = text.slice(Math.max(0, start - 2000), start);
    const m = /import(?:\{[^{}]*\}|\*as [A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)?from"[^"]*";$|import"[^"]*";$/.exec(head);
    if (!m) return start;
    start -= m[0].length;
  }
}

const builtin = (mod) => !mod.startsWith("/") && !mod.startsWith(".");

/**
 * What a bundle chunk's text imports from other chunks (local name → exported name) and exports
 * (exported name → local name), read from its `import{…}from"/$bunfs/…"` and `export{…}` statements.
 */
export function chunkLinks(text) {
  const imports = new Map(), exports = new Map();
  const specs = (list) => list.split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split(/\s+as\s+/));
  for (const m of text.matchAll(/import\{([^{}]*)\}from"\/\$bunfs\/[^"]*"/g)) for (const [name, as] of specs(m[1])) imports.set(as ?? name, name);
  for (const m of text.matchAll(/(?:^|\n)export\{([^{}]*)\}/g)) for (const [name, as] of specs(m[1])) exports.set(as ?? name, name);
  return { imports, exports };
}

/** The import statement starting at token k: { end, bindings: [[local, imported]], mod } or null. */
function importAt(toks, k) {
  if (toks[k]?.t !== "id" || toks[k].v !== "import") return null;
  let j = k + 1;
  const bindings = [];
  if (toks[j]?.t === "str") return toks[j + 1]?.v === ";" ? { end: j + 2, bindings, mod: JSON.parse(toks[j].v) } : null;
  if (toks[j]?.v === "{") {
    j++;
    while (toks[j] && toks[j].v !== "}") {
      const name = toks[j]?.v;
      if (toks[j + 1]?.v === "as") { bindings.push([toks[j + 2].v, name]); j += 3; } else { bindings.push([name, name]); j += 1; }
      if (toks[j]?.v === ",") j++;
    }
    j++;
  } else if (toks[j]?.v === "*" && toks[j + 1]?.v === "as") {
    bindings.push([toks[j + 2].v, "*"]); j += 3;
  } else if (toks[j]?.t === "id") {
    bindings.push([toks[j].v, "default"]); j += 1;
  } else return null;
  if (toks[j]?.v !== "from" || toks[j + 1]?.t !== "str") return null;
  const mod = toks[j + 1].v.slice(1, -1);
  return { end: toks[j + 2]?.v === ";" ? j + 3 : j + 2, bindings, mod };
}

/** Names a segment declares at its top level: `function X`, `class X`, and `var|let|const X=…,Y` outside any bracket. */
function topLevelNames(body) {
  const out = new Set();
  let depth = 0, decl = false;
  for (let k = 0; k < body.length; k++) {
    const t = body[k], prev = body[k - 1];
    if (t.t === "p" && (t.v === "{" || t.v === "(" || t.v === "[")) depth++;
    else if (t.t === "p" && (t.v === "}" || t.v === ")" || t.v === "]")) depth--;
    else if (t.t === "tpl") { if (t.v.startsWith("}")) depth--; if (t.v.endsWith("${")) depth++; }
    if (depth !== 0) continue;
    if (t.t === "p" && t.v === ";") decl = false;
    if (t.t !== "id") continue;
    if (["var", "let", "const"].includes(t.v)) { decl = true; continue; }
    if (prev?.t === "id" && (prev.v === "function" || prev.v === "class")) out.add(t.v);
    else if (decl && ((prev?.t === "id" && ["var", "let", "const"].includes(prev.v)) || (prev?.t === "p" && prev.v === ","))) out.add(t.v);
  }
  return out;
}

/** Whether a "{" after token `prev` opens an object literal or pattern rather than a block. */
const OBJECT_AFTER_PUNCT = new Set(["(", ",", "=", ":", "[", "?", "&&", "||", "??", "!", "+", "-", "*", "/", "%", "<", ">", "<=", ">=", "==", "===", "!=", "!==",
  "...", "&", "|", "^", "~", "+=", "-=", "*=", "/=", "%=", "&&=", "||=", "??="]);
const OBJECT_AFTER_WORD = new Set(["return", "let", "const", "var", "typeof", "void", "in", "of", "yield", "await", "delete", "throw", "instanceof"]);
const opensObject = (prev) => !!prev && ((prev.t === "p" && OBJECT_AFTER_PUNCT.has(prev.v)) || (prev.t === "id" && OBJECT_AFTER_WORD.has(prev.v)) || (prev.t === "tpl" && prev.v.endsWith("${")));

/**
 * The canonical form of `segments` ([{ label, src, chunk?, imports?, exports? }]). A name a segment
 * declares at its top level is numbered across all segments ($G1, $G2, …), so that a call in
 * another segment to that function keeps naming it. It is the same name there only when both
 * segments are in one bundle chunk (`chunk`, any value that tells chunks apart; absent: all one),
 * or when the other's chunk imports it (`imports`: local name → exported name) under a name that
 * exactly one chunk of the whole bundle exports (`exporters`: exported name → the chunks exporting
 * it), and that chunk is the declaring segment's, exporting it as that declaration (`exports`:
 * exported name → local name). An import ESM resolves elsewhere, or that cannot be resolved, is not
 * linked. Every other short name is numbered within its segment ($1, $2, …), so a name that only
 * happens to match something elsewhere changes nothing. Returns { tokens, text, names }: the
 * canonical token strings, a readable rendering for diffs, and the renaming.
 */
export function canonicalize(segments, { exporters } = {}) {
  const globals = new Map();
  const names = {};
  const tokens = [];
  const parsed = segments.map((seg) => {
    const all = scan(seg.src);
    const alias = new Map();
    const body = [];
    for (let k = 0; k < all.length;) {
      const imp = importAt(all, k);
      if (imp) {
        if (builtin(imp.mod)) {
          const mod = imp.mod.replace(/^node:/, "");
          for (const [local, imported] of imp.bindings) alias.set(local, imported === "*" ? mod : `${mod}.${imported}`);
        }
        k = imp.end;
        continue;
      }
      body.push(all[k]);
      k++;
    }
    return { seg, alias, body, declared: topLevelNames(body) };
  });
  /** The segment index and local name that `v`, as segment `s` uses it, is declared as, or null. */
  const declaration = (s, v) => {
    if (parsed[s].declared.has(v)) return [s, v];
    const seg = parsed[s].seg;
    for (let d = 0; d < parsed.length; d++) {
      if (d === s) continue;
      const other = parsed[d].seg;
      if ((seg.chunk ?? 0) === (other.chunk ?? 0)) { if (parsed[d].declared.has(v)) return [d, v]; continue; }
      const exported = seg.imports?.get(v);
      if (exported === undefined) continue;
      const there = other.exports?.get(exported);
      const sole = exporters?.get(exported);
      if (there !== undefined && sole?.length === 1 && sole[0] === (other.chunk ?? 0) && parsed[d].declared.has(there)) return [d, there];
    }
    return null;
  };
  for (const [s, { seg, alias, body }] of parsed.entries()) {
    const local = new Map();
    const rename = (v) => {
      const decl = declaration(s, v);
      if (decl) {
        const key = `${decl[0]}:${decl[1]}`;
        if (!globals.has(key)) globals.set(key, `$G${globals.size + 1}`);
        return globals.get(key);
      }
      if (!local.has(v)) local.set(v, `$${local.size + 1}`);
      return local.get(v);
    };
    const used = new Set();
    const stack = [{ kind: "top", ternary: 0 }];
    let pendingClass = false;
    const segTokens = [];
    for (let k = 0; k < body.length; k++) {
      const tok = body[k], prev = body[k - 1], next = body[k + 1], top = stack[stack.length - 1];
      if (tok.t === "p") {
        if (tok.v === "{") { stack.push({ kind: pendingClass ? "class" : opensObject(prev) ? "obj" : "block", ternary: 0 }); pendingClass = false; }
        else if (tok.v === "(" || tok.v === "[") stack.push({ kind: tok.v, ternary: 0 });
        else if (tok.v === "}" || tok.v === ")" || tok.v === "]") { if (stack.length > 1) stack.pop(); }
        else if (tok.v === "?") top.ternary++;
        else if (tok.v === ":" && top.ternary > 0) top.ternary--;
        segTokens.push(tok.v);
        continue;
      }
      if (tok.t === "tpl") {
        if (tok.v.startsWith("}") && stack.length > 1) stack.pop();
        if (tok.v.endsWith("${")) stack.push({ kind: "tpl", ternary: 0 });
        segTokens.push(tok.v);
        continue;
      }
      if (tok.t !== "id") { segTokens.push(tok.v); continue; }
      const v = tok.v;
      if (v === "class") pendingClass = true;
      const property = prev?.t === "p" && (prev.v === "." || prev.v === "?.");
      // In an object literal or pattern: a key (`a:`), a shorthand (`{a}`, `{a=1}` in a pattern) or a
      // method (`a(){}`, `get a(){}`) names a property, which renaming would change.
      const leads = prev?.t === "p" && (prev.v === "{" || prev.v === ",");
      const accessor = prev?.t === "id" && ["get", "set", "async"].includes(prev.v) && body[k - 2]?.t === "p" && (body[k - 2].v === "{" || body[k - 2].v === ",");
      const key = top.kind === "obj" && top.ternary === 0 && next?.t === "p" && (
        (leads && [":", ",", "}", "=", "("].includes(next.v)) || ((accessor || (prev?.t === "p" && prev.v === "*")) && next.v === "("));
      const member = top.kind === "class" && ((prev?.t === "p" && ["{", "}", ";", "*"].includes(prev.v)) || (prev?.t === "id" && ["static", "get", "set", "async"].includes(prev.v)));
      if (KEYWORDS.has(v) || property || key || member || SHORT_GLOBALS.has(v) || v.startsWith("#")) { segTokens.push(v); continue; }
      if (alias.has(v)) { used.add(alias.get(v)); segTokens.push(alias.get(v)); continue; }
      if (v.length > 3) { segTokens.push(v); continue; }
      segTokens.push(rename(v));
    }
    tokens.push(`@segment ${seg.label}`, `@imports ${[...used].sort().join(",")}`, ...segTokens);
    names[seg.label] = Object.fromEntries(local);
  }
  names.globals = Object.fromEntries(globals);
  return { tokens, text: render(tokens), names };
}

/**
 * `text` with its short names (three characters or fewer, not after "." and not keywords) renamed
 * $1, $2, … in order of appearance, and each of `names` (a Map of name → label) replaced by its
 * label. For comparing a statement of minified code across builds while keeping which names are the
 * same binding.
 */
export function renameShort(text, names = new Map()) {
  const seen = new Map();
  // After a lone "." a name is a property; after a spread's "..." it is a name. Words that are
  // keywords only in some positions (of, get, set, as, from, async, static) are names a minifier
  // may pick, so they are renamed here.
  return text.replace(/(?<![\w$#])(?<!(?<!\.)\.)[A-Za-z_$][\w$]*(?![\w$])/g, (id) => {
    if (names.has(id)) return names.get(id);
    if (id.length > 3 || (KEYWORDS.has(id) && !CONTEXTUAL.has(id)) || SHORT_GLOBALS.has(id)) return id;
    if (!seen.has(id)) seen.set(id, `$${seen.size + 1}`);
    return seen.get(id);
  });
}

/** Canonical tokens as lines, broken after ";", "{" and "}", for a readable diff. */
export function render(tokens) {
  let s = "";
  for (const t of tokens) {
    if (t.startsWith("@")) { s += `${s && !s.endsWith("\n") ? "\n" : ""}${t}\n`; continue; }
    if (s && isIdPart(s[s.length - 1]) && isIdPart(t[0])) s += " ";
    s += t;
    if (t === ";" || t === "{" || t === "}") s += "\n";
  }
  return s.endsWith("\n") ? s : `${s}\n`;
}

/** A unified-style line diff of two renderings (small inputs only): lines only in a as "-", only in b as "+", with line numbers. */
export function lineDiff(a, b, labelA = "a", labelB = "b") {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { i++; j++; continue; }
    if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { out.push(`+${j + 1}: ${y[j]}`); j++; }
    else { out.push(`-${i + 1}: ${x[i]}`); i++; }
  }
  return out.join("\n");
}
