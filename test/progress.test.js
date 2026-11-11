import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { addEntry, cleanNotes, dayExists, history, loadProgress, mergeNotes, readAuto, readDayFull, removeEntry, saveProgress, setAuto } from "../lib/progress.js";

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
  assert.deepEqual(p.previous, { date: "2026-11-10", notes: { summary: "day 2" }, entries: [], auto: null });
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

test("automatic points live beside the user's notes: setAuto keeps entries, saves keep auto, md shows both", () => {
  addEntry(dir, "my own note", jira, github, "2026-11-11");
  const auto = { updatedAt: "2026-11-11T08:30:00.000Z", source: "claude", points: ["Merged o/r#8", "Reviewed o/x#3"], activity: [], errors: [],
    sessions: [{ id: "ed90d947-3142-4fa2-a082-9035b6773aca", title: "Perf report", dir: "C:\\w", folder: "w", startedOn: "2026-11-11", first: "2026-11-11T09:00:00.000Z", last: "2026-11-11T09:40:00.000Z", prompts: 1, live: null }] };
  const r = setAuto(dir, "2026-11-11", auto, jira, github);
  assert.deepEqual(r.auto.points, ["Merged o/r#8", "Reviewed o/x#3"]);
  assert.equal(r.entries.length, 1, "entries untouched");
  saveProgress(dir, { summary: "s" }, jira, github, "2026-11-11");
  addEntry(dir, "another", jira, github, "2026-11-11");
  assert.deepEqual(readAuto(dir, "2026-11-11").points, auto.points, "notes writes keep the auto record");
  assert.equal(readAuto(dir, "2026-11-10"), null);
  assert.equal(dayExists(dir, "2026-11-11"), true);
  assert.equal(dayExists(dir, "2026-11-10"), false);
  const md = fs.readFileSync(path.join(dir, "2026-11-11.md"), "utf8");
  assert.match(md, /## Notes\n\n- \*\*Summary:\*\* s\n- \d\d:\d\d — my own note\n- \d\d:\d\d — another\n\n## Automatic \(updated \d\d:\d\d\)\n\n- Merged o\/r#8\n- Reviewed o\/x#3\n\n## Claude sessions \(1\)\n\n- \d\d:\d\d–\d\d:\d\d — Perf report \(w, 1 prompt\)\n\n## Jira/);
  const p = loadProgress(dir, "2026-11-11");
  assert.equal(p.todayAuto.source, "claude");
  assert.deepEqual(history(dir, 1)[0].auto, { updatedAt: auto.updatedAt, source: "claude", points: auto.points }, "history carries a compact auto");
  assert.deepEqual(readDayFull(dir, "2026-11-11").auto, auto);
});

test("writes to a past day keep its stored Jira/PR snapshot and only complete `done`", () => {
  const at = (ymd, hm = "10:00") => new Date(`${ymd}T${hm}`).toISOString();
  const day = "2026-11-10";
  saveProgress(dir, { summary: "as saved" }, jira, github, day);                       // snapshot: PROJ-1 open, o/r#8 mine
  const todayJira = [{ key: "PROJ-99", summary: "Today's issue", url: "j99", status: "Open", statusCategory: "To Do" }];
  const todayGh = { login: "me", mine: [], toReview: [], closed: [{ repo: "o/r", number: 5, title: "Merged that evening", url: "u5", merged: true, closedAt: at(day, "22:00") }], reviewed: [] };
  const auto = { updatedAt: at("2026-11-11", "09:00"), source: "activity", points: ["late push"], activity: [], errors: [] };
  setAuto(dir, day, auto, todayJira, todayGh, { jiraDone: [], keepSnapshot: true });
  const d = readDayFull(dir, day);
  assert.deepEqual(d.jira.map((j) => j.key), ["PROJ-1"], "yesterday's open issues stay yesterday's");
  assert.equal(d.github.mine.length, 1);
  assert.deepEqual(d.done.prs.map((p) => p.number), [5], "but what finished that day is completed from live data");
  assert.deepEqual(d.auto.points, ["late push"]);
  assert.match(fs.readFileSync(path.join(dir, `${day}.md`), "utf8"), /## Jira \(1\)\n\n- \[PROJ-1\]/);
  // Without keepSnapshot the current lists are written (today's own file).
  setAuto(dir, day, auto, todayJira, todayGh, { jiraDone: [] });
  assert.deepEqual(readDayFull(dir, day).jira.map((j) => j.key), ["PROJ-99"]);
  // A past day with no file yet: unknown lists stay empty rather than pretending.
  setAuto(dir, "2026-11-09", auto, todayJira, todayGh, { jiraDone: [], keepSnapshot: true });
  assert.deepEqual(readDayFull(dir, "2026-11-09").jira, []);
  assert.deepEqual(readDayFull(dir, "2026-11-09").github.mine, []);
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
  assert.deepEqual(h[0].counts, { jira: 1, myPRs: 1, toReview: 0, done: 0 });
});

test("the day file records what was finished that day, not the whole closed/reviewed lists", () => {
  const at = (ymd, hm = "10:00") => new Date(`${ymd}T${hm}`).toISOString();
  const gh = { ...github, login: "me",
    closed: [{ repo: "o/r", number: 1, title: "Merged today", url: "u1", merged: true, closedAt: at("2026-11-11") },
      { repo: "o/r", number: 2, title: "Old", url: "u2", merged: true, closedAt: at("2026-10-01") }],
    reviewed: [{ repo: "o/x", number: 3, title: "Reviewed today", url: "u3", author: "ana", lastReviewState: "CHANGES_REQUESTED", reviews: [{ state: "CHANGES_REQUESTED", at: at("2026-11-11", "15:00") }] }] };
  const jiraDone = [{ key: "PROJ-9", summary: "Finished", url: "j9", status: "Closed", statusCategory: "Done", statusCategoryChangedAt: at("2026-11-11", "17:30") },
    { key: "PROJ-8", summary: "Earlier", url: "j8", status: "Closed", statusCategory: "Done", statusCategoryChangedAt: at("2026-11-04") }];
  saveProgress(dir, { summary: "s" }, jira, gh, "2026-11-11", { jiraDone });

  const json = JSON.parse(fs.readFileSync(path.join(dir, "2026-11-11.json"), "utf8"));
  assert.deepEqual(json.done.jira.map((j) => j.key), ["PROJ-9"]);
  assert.deepEqual(json.done.prs.map((p) => p.number), [1]);
  assert.deepEqual(json.done.reviewed.map((p) => p.number), [3]);
  assert.deepEqual(Object.keys(json.github).sort(), ["login", "mine", "toReview"], "long lists stay out of the snapshot");
  const md = fs.readFileSync(path.join(dir, "2026-11-11.md"), "utf8");
  assert.match(md, /## Done today \(3\)\n\n- \[PROJ-9\]\(j9\) Finished — \*\*Closed\*\*\n- \[o\/r#1\]\(u1\) Merged today — \*\*merged\*\*\n- Reviewed \[o\/x#3\]\(u3\) Reviewed today — changes requested\n/);
  assert.equal(readDayFull(dir, "2026-11-11").done.prs.length, 1);
  assert.equal(history(dir, 1)[0].counts.done, 3);

  // Nothing finished → no "Done today" heading, and old files without `done` still read back.
  saveProgress(dir, { summary: "s" }, jira, github, "2026-11-12");
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "2026-11-12.md"), "utf8"), /Done today/);
  const legacy = JSON.parse(fs.readFileSync(path.join(dir, "2026-11-12.json"), "utf8"));
  delete legacy.done; fs.writeFileSync(path.join(dir, "2026-11-12.json"), JSON.stringify(legacy));
  assert.deepEqual(readDayFull(dir, "2026-11-12").done, { jira: [], prs: [], reviewed: [] });
});
