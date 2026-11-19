// The verified-version lists (src/targets/verified.ts) in the one-line shape scripts/release-watch
// rewrites, and the docs' <!-- verified:KEY --> markers, which must say what the lists say.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { englishList, newest, VERIFIED } from "../dist/targets/verified.js";
import "./helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const KEYS = Object.keys(VERIFIED) as (keyof typeof VERIFIED)[];
const parse = (v: string) => v.split(".").map(Number);
const newer = (a: number[], b: number[]) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

test("verified: each list is exact x.y.z versions, oldest first, none twice", () => {
  assert.ok(KEYS.length > 0);
  for (const key of KEYS) {
    const list = VERIFIED[key] as readonly string[];
    assert.ok(list.length > 0, key);
    for (const v of list) assert.match(v, /^\d+\.\d+\.\d+$/, `${key}: ${v}`);
    for (let i = 1; i < list.length; i++) assert.ok(newer(parse(list[i]), parse(list[i - 1])), `${key}: ${list[i - 1]} before ${list[i]}`);
  }
});

test("verified: each list is one line of the source in the shape the release watcher rewrites", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "targets", "verified.ts"), "utf8");
  for (const key of KEYS) {
    // The watcher's own pattern (scripts/release-watch): one line, two-space indent, no comment after it.
    const lines = source.match(new RegExp(`^  (${key}): \\[((?:"[^"]+"(?:, )?)*)\\],$`, "gm")) ?? [];
    assert.equal(lines.length, 1, `${key}: exactly one line in the watcher's shape`);
    const written = [...lines[0].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(written, [...VERIFIED[key]], key);
  }
});

test("verified: englishList and newest", () => {
  assert.equal(englishList([]), "");
  assert.equal(englishList(["0.64.0"]), "0.64.0");
  assert.equal(englishList(["a", "b"]), "a and b");
  assert.equal(englishList(["a", "b", "c"]), "a, b and c");
  for (const key of KEYS) assert.equal(newest(key), VERIFIED[key].at(-1));
});

/** README.md and every Markdown file under docs/. */
function markdown(): string[] {
  const out = [path.join(ROOT, "README.md")];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(path.join(ROOT, "docs"));
  return out;
}

test("verified: every <!-- verified:KEY --> marker in the docs says what VERIFIED says, on one line", () => {
  const OPEN = /<!-- verified:([A-Za-z]+)(:last)? -->/g;
  let count = 0;
  for (const file of markdown()) {
    const text = fs.readFileSync(file, "utf8");
    const where = (i: number) => `${path.relative(ROOT, file)}:${text.slice(0, i).split("\n").length}`;
    for (const m of text.matchAll(OPEN)) {
      const at = m.index!;
      const start = at + m[0].length;
      const end = text.indexOf("<!-- /verified -->", start);
      assert.ok(end >= 0, `${where(at)}: marker not closed`);
      const inner = text.slice(start, end);
      assert.ok(!inner.includes("\n") && !inner.includes("<!--"), `${where(at)}: a marker's text is one line with no marker inside`);
      const key = m[1] as keyof typeof VERIFIED;
      assert.ok(KEYS.includes(key), `${where(at)}: no list ${m[1]} in VERIFIED`);
      assert.equal(inner, m[2] ? newest(key) : englishList(VERIFIED[key]), where(at));
      count++;
    }
    const closes = text.split("<!-- /verified -->").length - 1;
    assert.equal(closes, [...text.matchAll(OPEN)].length, `${path.relative(ROOT, file)}: unmatched <!-- /verified -->`);
  }
  assert.ok(count > 0, "the docs carry markers");
});
