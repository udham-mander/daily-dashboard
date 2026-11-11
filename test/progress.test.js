import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { addEntry, cleanNotes, history, loadProgress, mergeNotes, readDayFull, removeEntry, saveProgress } from "../lib/progress.js";

const github = { mine: [{ repo: "o/r", number: 8, title: "T", url: "u", pending: [{ level: "info", text: "Draft" }] }], toReview: [] };
const jira = [{ key: "PROJ-1", summary: "S", url: "j", status: "Open", statusCategory: "To Do" }];
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-progress-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("cleanNotes drops unknown keys and non-strings", () => {
  assert.deepEqual(cleanNotes({ summary: "a", "jira:X-1": "b", evil: "c", "pr:o/r#1": 5, summaryX: "d" }),
    { summary: "a", "jira:X-1": "b" });
});

test("mergeNotes: replace, delete with empty, keep unsent", () => {
  assert.deepEqual(mergeNotes({ summary: "old", "jira:A-1": "keep", "jira:B-2": "gone" }, { summary: "new", "jira:B-2": " " }),
    { summary: "new", "jira:A-1": "keep" });
});

test("two writers don't overwrite each other", () => {
  saveProgress(dir, { "jira:PROJ-1": "from Claude" }, jira, github, "2026-11-11");
  const r = saveProgress(dir, { summary: "from the page" }, jira, github, "2026-11-11");
  assert.deepEqual(r.notes, { "jira:PROJ-1": "from Claude", summary: "from the page" });
  const md = fs.readFileSync(path.join(dir, "2026-11-11.md"), "utf8");
  assert.match(md, /## Notes\n\n- \*\*Summary:\*\* from the page/);
  assert.match(md, /- \[PROJ-1\]\(j\) S — \*\*Open\*\*, not started\n {2}- Note: from Claude/);
  assert.match(md, /Pending: Draft/);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0, "no temp files left");
});

test("loadProgress returns today's notes and the latest earlier day", () => {
  saveProgress(dir, { summary: "day 1" }, jira, github, "2026-11-09");
  saveProgress(dir, { summary: "day 2" }, jira, github, "2026-11-10");
  saveProgress(dir, { summary: "today" }, jira, github, "2026-11-11");
  const p = loadProgress(dir, "2026-11-11");
  assert.equal(p.todayNotes.summary, "today");
  assert.deepEqual(p.previous, { date: "2026-11-10", notes: { summary: "day 2" }, entries: [] });
  assert.equal(loadProgress(path.join(dir, "missing"), "2026-11-11").previous, null);
});

test("entries: add, keep alongside item notes, remove", () => {
  const a = addEntry(dir, "  Reviewed api#101  ", jira, github, "2026-11-11");
  addEntry(dir, "Paired on PROJ-73", jira, github, "2026-11-11");
  saveProgress(dir, { "jira:PROJ-1": "item note" }, jira, github, "2026-11-11");
  let p = loadProgress(dir, "2026-11-11");
  assert.deepEqual(p.todayEntries.map((e) => e.text), ["Reviewed api#101", "Paired on PROJ-73"]);
  assert.equal(p.todayNotes["jira:PROJ-1"], "item note", "saving item notes keeps entries");
  assert.match(a.entry.id, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(a.entry.at));

  const md = fs.readFileSync(path.join(dir, "2026-11-11.md"), "utf8");
  assert.match(md, /## Notes\n\n- \d\d:\d\d — Reviewed api#101\n- \d\d:\d\d — Paired on PROJ-73/);

  removeEntry(dir, a.entry.id, jira, github, "2026-11-11");
  p = loadProgress(dir, "2026-11-11");
  assert.deepEqual(p.todayEntries.map((e) => e.text), ["Paired on PROJ-73"]);
  assert.throws(() => removeEntry(dir, "nope", jira, github, "2026-11-11"), /not found/);
  assert.throws(() => addEntry(dir, "   ", jira, github, "2026-11-11"), /empty/);
  assert.throws(() => removeEntry(dir, "nope", jira, github, "2026-12-25"), /not found/);
  assert.ok(!fs.existsSync(path.join(dir, "2026-12-25.json")), "a failed delete creates no files");
});

test("previous day includes its entries; readDayFull validates the date", () => {
  addEntry(dir, "yesterday's work", jira, github, "2026-11-10");
  assert.deepEqual(loadProgress(dir, "2026-11-11").previous.entries.map((e) => e.text), ["yesterday's work"]);
  const day = readDayFull(dir, "2026-11-10");
  assert.equal(day.entries.length, 1);
  assert.equal(day.jira[0].key, "PROJ-1", "includes the data snapshot");
  assert.equal(readDayFull(dir, "2026-01-01"), null);
  assert.throws(() => readDayFull(dir, "../secret"), /bad date/);
});

test("history is newest first and limited", () => {
  for (const d of ["2026-11-08", "2026-11-09", "2026-11-10"]) saveProgress(dir, { summary: d }, jira, github, d);
  const h = history(dir, 2);
  assert.deepEqual(h.map((x) => x.date), ["2026-11-10", "2026-11-09"]);
  assert.deepEqual(h[0].counts, { jira: 1, myPRs: 1, toReview: 0 });
});
