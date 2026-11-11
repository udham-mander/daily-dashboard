import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildAuto, createAutoNotes, parsePoints, plan, summaryPrompt } from "../lib/auto.js";
import { loadProgress, readDayFull } from "../lib/progress.js";

const cfg = { enabled: true, intervalMinutes: 120, workHours: "07:00-20:00", useClaude: true, model: "haiku" };
const local = (ymd, hm) => new Date(`${ymd}T${hm}`);

test("parsePoints accepts only an array of strings and caps it", () => {
  assert.deepEqual(parsePoints('["a", " b\\n c "]'), ["a", "b c"]);
  assert.deepEqual(parsePoints('["a", "", "  "]'), ["a"], "blank strings are dropped, not fatal");
  assert.throws(() => parsePoints('{"a":1}'), /array/);
  assert.throws(() => parsePoints('["a", 1]'), /array of strings/);
  assert.equal(parsePoints(JSON.stringify(Array.from({ length: 30 }, (_, i) => `p${i}`))).length, 12);
  assert.equal(parsePoints(JSON.stringify(["x".repeat(500)]))[0].length, 300);
});

test("summaryPrompt lists the activity as data, one line each", () => {
  const p = summaryPrompt("2026-11-11", [{ text: "Pushed 2 commits\nto x" }, { text: "Finished A-1" }]);
  assert.match(p, /2026-11-11/);
  assert.match(p, /\n- Pushed 2 commits to x\n- Finished A-1$/);
  assert.match(p, /ONLY a JSON array/);
});

test("buildAuto: Claude bullets when they come back, raw activity lines when Claude fails or returns nothing", async () => {
  const activity = { items: [{ text: "Pushed 1 commit to api:main: fix" }, { text: "Finished A-1 (Done): s" }], errors: ["GitHub activity: partial"] };
  const ok = await buildAuto("2026-11-11", { activity, useClaude: true, model: "haiku", claude: async () => '["Fixed main", "Closed A-1"]' });
  assert.deepEqual([ok.source, ok.points, ok.errors], ["claude", ["Fixed main", "Closed A-1"], ["GitHub activity: partial"]]);
  assert.equal(ok.activity.length, 2);

  const failed = await buildAuto("2026-11-11", { activity, useClaude: true, model: "haiku", claude: async () => { throw new Error("timed out"); } });
  assert.equal(failed.source, "activity");
  assert.deepEqual(failed.points, activity.items.map((i) => i.text));
  assert.match(failed.errors[1], /Claude summary failed.*timed out/);

  const empty = await buildAuto("2026-11-11", { activity, useClaude: true, model: "haiku", claude: async () => "[]" });
  assert.equal(empty.source, "activity", "an empty answer falls back to the lines");

  let called = 0;
  const off = await buildAuto("2026-11-11", { activity, useClaude: false, model: "haiku", claude: async () => { called++; return "[]"; } });
  assert.equal(called, 0); assert.equal(off.source, "activity");
  const nothing = await buildAuto("2026-11-11", { activity: { items: [], errors: [] }, useClaude: true, model: "haiku", claude: async () => { called++; return "[]"; } });
  assert.equal(called, 0, "no Claude call for an empty day"); assert.deepEqual(nothing.points, []);
});

test("plan: a periodic update when the last one is older than the interval, only in work hours", () => {
  const types = (s) => plan({ cfg, ...s }).map((a) => `${a.type}:${a.date}`);
  assert.deepEqual(types({ now: local("2026-11-11", "09:00"), todayAuto: null }), ["auto:2026-11-11"], "first run of the day");
  const fresh = { updatedAt: local("2026-11-11", "08:30").toISOString() };
  assert.deepEqual(types({ now: local("2026-11-11", "09:00"), todayAuto: fresh }), [], "updated 30 min ago");
  assert.deepEqual(types({ now: local("2026-11-11", "10:30"), todayAuto: fresh }), ["auto:2026-11-11"], "2 h later");
  assert.deepEqual(types({ now: local("2026-11-11", "09:00"), todayAuto: null, lastTriedAt: local("2026-11-11", "08:30").toISOString() }), [], "a quiet day: tried 30 min ago, nothing written, don't hammer GitHub");
  assert.deepEqual(types({ now: local("2026-11-11", "06:59"), todayAuto: null }), [], "before work hours");
  assert.deepEqual(types({ now: local("2026-11-11", "20:00"), todayAuto: null }), [], "after work hours");
  assert.deepEqual(plan({ cfg: { ...cfg, enabled: false }, now: local("2026-11-11", "09:00"), todayAuto: null }), []);
});

test("createAutoNotes.update writes the day's auto record beside the user's notes; an empty day writes nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-auto-"));
  const day = "2026-11-11";
  const events = [{ type: "PushEvent", created_at: new Date(`${day}T10:00`).toISOString(), repo: { name: "o/api" }, payload: { ref: "refs/heads/main", size: 1, commits: [{ message: "fix" }] } }];
  let refreshed = 0, claudeCalls = 0;
  const jira = { state: { issues: [], done: [], fetchedAt: new Date().toISOString() }, refresh: async () => {} };
  const data = (login = "me") => () => ({ github: { login, mine: [], toReview: [], closed: [], reviewed: [] }, jiraDone: [], since: "2026-01-01" });
  const auto = createAutoNotes({
    cfg, progressDir: dir, jira, data: data(),
    refreshGithub: async () => { refreshed++; },
    fetchEvents: async () => events,
    claude: async () => { claudeCalls++; return '["Fixed main"]'; },
  });
  const r = await auto.update(day, { reason: "test" });
  assert.deepEqual(r.auto.points, ["Fixed main"]);
  const stored = readDayFull(dir, day);
  assert.equal(stored.auto.source, "claude");
  assert.deepEqual(stored.auto.activity.map((a) => a.text), ["Pushed 1 commit to api:main: fix"]);
  assert.match(fs.readFileSync(path.join(dir, `${day}.md`), "utf8"), /## Automatic \(updated \d\d:\d\d\)\n\n- Fixed main\n/);
  assert.deepEqual(loadProgress(dir, day).todayAuto.points, ["Fixed main"]);
  assert.deepEqual(loadProgress(dir, "2026-11-12").previous.auto.points, ["Fixed main"], "yesterday's auto points come along as 'previous'");

  await auto.update(day, { reason: "refresh", refresh: true });
  assert.equal(refreshed, 1, "refresh=true refetches GitHub first");
  assert.equal(claudeCalls, 2);

  // An empty day with no file: nothing is written (no weekend files).
  assert.equal(await auto.update("2026-11-08", { reason: "test" }), null);
  assert.equal(fs.existsSync(path.join(dir, "2026-11-08.json")), false);
  assert.equal(auto.status().running, false);
  assert.equal(auto.status().error, null);

  // Right after start the GitHub login is not known yet: update() fetches GitHub first.
  let login = null, cheapRefreshes = 0;
  const early = createAutoNotes({ cfg, progressDir: dir, jira, data: () => data(login)(),
    refreshGithub: async (force) => { if (!force) cheapRefreshes++; login = "me"; }, fetchEvents: async () => events, claude: async () => '["x"]' });
  assert.equal((await early.update(day, { reason: "manual" })).auto.points[0], "x");
  assert.equal(cheapRefreshes, 1);
  // No login even after that: the reason is reported, nothing invented.
  const noLogin = createAutoNotes({ cfg, progressDir: dir, jira, data: data(null), refreshGithub: async () => {}, fetchEvents: async () => events, claude: async () => '["x"]' });
  assert.equal(await noLogin.update("2026-11-01", { reason: "manual" }), null);
  assert.match(noLogin.status().error, /not signed in/);

  // GitHub down later in the day: the richer record is kept, not replaced by Jira-only lines.
  const flaky = createAutoNotes({ cfg, progressDir: dir, jira, data: data(), refreshGithub: async () => {},
    fetchEvents: async () => { throw new Error("gh: 502"); }, claude: async () => '["should not be used"]' });
  const kept = await flaky.update(day, { reason: "scheduled" });
  assert.equal(kept.kept, true);
  assert.deepEqual(readDayFull(dir, day).auto.points, ["x"], "previous points survive");
  assert.match(flaky.status().error, /gh: 502/);

  // tick() runs the plan: the first tick of a (quiet) day tries once; the next tick does not retry,
  // and rebuilding another day in between does not reset that guard.
  let fetches = 0;
  const t = createAutoNotes({ cfg, progressDir: dir, jira, data: data(), refreshGithub: async () => {},
    fetchEvents: async () => { fetches++; return events; }, claude: async () => '["again"]', now: () => local("2026-11-13", "09:00") });
  assert.deepEqual((await t.tick()).map((a) => a.type), ["auto"]);
  assert.equal(fetches, 1);
  await t.update(day, { reason: "manual" });
  assert.deepEqual(await t.tick(), []);
  assert.equal(fetches, 2, "only the manual rebuild fetched again");
  fs.rmSync(dir, { recursive: true, force: true });
});
