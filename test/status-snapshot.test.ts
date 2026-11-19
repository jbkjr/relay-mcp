// What status, result, progress lines and relay tree show of a registry is a stable surface: work on
// how they are built must not change a byte of it. registries.json holds registries relay's own tests
// made (discussions and reviews, a withheld reviewer, running, queued, lost, timed-out, refused and
// blocked items, Copilot, approval requests, extensions, a fast speed), with ids, tokens, paths and
// times made fixed; expected.json is what relay showed for them at the performance work's baseline
// (a699dc4). RELAY_UPDATE_STATUS_VIEWS=1 writes expected.json from the build under test instead.
import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closeDbForTests, db } from "../dist/core/db.js";
import { newInstance } from "../dist/core/caller.js";
import { result, status } from "../dist/core/ops.js";
import { progressLine, renderTree } from "../dist/core/views.js";

const FIXTURES = new URL("./fixtures/status-views/", import.meta.url);
type Row = Record<string, string | number | null>;
interface Registry { from: string; now: number; rows: Record<string, Row[]> }

test("status, result, progress and tree show fixed registries exactly as before", async (t) => {
  const { registries } = JSON.parse(fs.readFileSync(new URL("registries.json", FIXTURES), "utf8")) as { registries: Registry[] };
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-views-")));
  const old = { RELAY_HOME: process.env.RELAY_HOME, RELAY_CONFIG: process.env.RELAY_CONFIG };
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
    closeDbForTests();
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.RELAY_CONFIG = path.join(dir, "config.json");
  fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ allow_temp_home: true }));
  const shown: { what: string; v: unknown }[] = [];
  for (const [i, reg] of registries.entries()) {
    const home = path.join(dir, `h${i}`);
    process.env.RELAY_HOME = home;
    for (const [table, rows] of Object.entries(reg.rows)) {
      for (const row of rows) {
        const cols = Object.keys(row);
        db().prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
      }
    }
    Date.now = () => reg.now;
    try {
      const show = async (what: string, fn: () => unknown) => {
        let v: unknown;
        try { v = await fn(); } catch (err) { v = { threw: (err as Error).message }; }
        shown.push({ what: `${reg.from} ${what}`, v: JSON.parse(JSON.stringify(v ?? null).split(home).join("<RELAY_HOME>").split(os.homedir()).join("<HOME>")) });
      };
      for (const run of reg.rows.runs) {
        const inst = newInstance({ kind: "root" } as never, String(run.root_cwd), "claude");
        inst.token = String(run.root_token ?? "none");
        inst.runId = String(run.id);
        await show(`status ${run.id}`, () => status(inst, {}));
        await show(`tree ${run.id}`, () => renderTree(String(run.id)));
        for (const n of [...reg.rows.nodes].filter((x) => x.run_id === run.id).sort((a, b) => Number(a.created_at) - Number(b.created_at) || String(a.id).localeCompare(String(b.id)))) {
          await show(`status ${n.id}`, () => status(inst, { id: String(n.id) }));
          await show(`result ${n.id}`, () => result(inst, { job_id: String(n.id) }));
          await show(`progress ${n.id}`, () => progressLine(String(n.id)));
        }
        await show(`status of run ${run.id}`, () => status(inst, { id: String(run.id) }));
      }
    } finally {
      Date.now = realNow;
      closeDbForTests();
    }
  }
  const file = new URL("expected.json", FIXTURES);
  if (process.env.RELAY_UPDATE_STATUS_VIEWS === "1") {
    fs.writeFileSync(file, JSON.stringify(shown, null, 1) + "\n");
    return;
  }
  const expected = JSON.parse(fs.readFileSync(file, "utf8")) as typeof shown;
  assert.deepEqual(shown.map((s) => s.what), expected.map((s) => s.what));
  for (const [i, s] of shown.entries()) assert.equal(JSON.stringify(s.v), JSON.stringify(expected[i].v), `${s.what} shows something else than before`);
});
