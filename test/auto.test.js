import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildAuto, createAutoNotes, freshMemory, parsePoints, plan, summaryPrompt } from "../lib/auto.js";
import { loadProgress, readDayFull } from "../lib/progress.js";

const cfg = { enabled: true, intervalMinutes: 120, workHours: "07:00-20:00", saveAt: "17:00", catchupDays: 1, useClaude: true, model: "haiku" };
const local = (ymd, hm) => new Date(`${ymd}T${hm}`);
const iso = (ymd, hm) => local(ymd, hm).toISOString();

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

test("plan: previous-day catch-up once a day, end-of-day save once in its window, periodic builds in work hours", () => {
  const D = "2026-11-11", Y = "2026-11-10";
  const types = (s) => plan({ cfg, ...s }).map((a) => `${a.type}:${a.date}`);
  const fresh = { updatedAt: iso(D, "08:30") };
  const saved = { updatedAt: iso(D, "17:00"), eodSavedAt: iso(D, "17:00") };
  const mem = (patch) => ({ ...freshMemory(), ...patch });

  // First tick of the morning: yesterday first, then today's periodic build.
  assert.deepEqual(types({ now: local(D, "09:00"), todayAuto: null }), [`catchup:${Y}`, `auto:${D}`]);
  assert.deepEqual(types({ now: local(D, "09:00"), todayAuto: null, cfg: { ...cfg, catchupDays: 2 } }).slice(0, 2), ["catchup:2026-11-09", `catchup:${Y}`], "oldest first");
  assert.deepEqual(types({ now: local(D, "09:00"), todayAuto: null, cfg: { ...cfg, catchupDays: 0 } }), [`auto:${D}`]);
  // Yesterday already topped up today (stored mark, or done in memory for an empty day): not again; topped up on an earlier day: again.
  assert.deepEqual(types({ now: local(D, "09:00"), todayAuto: fresh, readAuto: () => ({ catchupAt: iso(D, "08:00") }) }), []);
  assert.deepEqual(types({ now: local(D, "09:00"), todayAuto: fresh, memory: mem({ catchupDone: { [Y]: D } }) }), []);
  assert.deepEqual(types({ now: local(D, "09:00"), todayAuto: fresh, readAuto: () => ({ catchupAt: iso(Y, "23:59") }) }), [`catchup:${Y}`]);
  // A failed catch-up: not hammered every minute, retried after the interval.
  assert.deepEqual(types({ now: local(D, "09:05"), todayAuto: fresh, memory: mem({ catchupTried: { [Y]: iso(D, "09:00") } }) }), []);
  assert.deepEqual(types({ now: local(D, "11:05"), todayAuto: { updatedAt: iso(D, "10:00") }, memory: mem({ catchupTried: { [Y]: iso(D, "09:00") } }) }), [`catchup:${Y}`]);
  // Midnight passed while running: the day that just ended is now "yesterday" and gets topped up.
  assert.deepEqual(types({ now: local("2026-11-12", "00:00"), todayAuto: null, memory: mem({ catchupDone: { [Y]: D } }) }), [`catchup:${D}`]);

  // End of day: at 17:00 and until the end of work hours, once.
  const done = { catchupDone: { [Y]: D } };
  assert.deepEqual(types({ now: local(D, "17:00"), todayAuto: fresh, memory: mem(done) }), [`eod:${D}`]);
  assert.deepEqual(types({ now: local(D, "19:00"), todayAuto: null, memory: mem(done) }), [`eod:${D}`], "started late: still saves the day");
  assert.deepEqual(types({ now: local(D, "17:30"), todayAuto: saved, memory: mem(done) }), []);
  assert.deepEqual(types({ now: local(D, "19:30"), todayAuto: saved, memory: mem(done) }), [`auto:${D}`], "after the save, periodic builds resume");
  assert.deepEqual(types({ now: local(D, "17:05"), todayAuto: null, memory: mem({ ...done, eodDone: { [D]: true }, eodTried: { [D]: iso(D, "17:00") } }) }), [], "quiet day: nothing to save, no retry");
  assert.deepEqual(types({ now: local(D, "17:05"), todayAuto: fresh, memory: mem({ ...done, eodTried: { [D]: iso(D, "17:00") } }) }), [], "failed a moment ago: wait");
  assert.deepEqual(types({ now: local(D, "19:05"), todayAuto: fresh, memory: mem({ ...done, eodTried: { [D]: iso(D, "17:00") } }) }), [`eod:${D}`], "failed save is retried after the interval");
  assert.deepEqual(types({ now: local(D, "20:30"), todayAuto: null, memory: mem(done) }), [], "after work hours: left to tomorrow's catch-up");
  assert.deepEqual(types({ now: local(D, "17:05"), todayAuto: fresh, memory: mem(done), cfg: { ...cfg, saveAt: "" } }), [`auto:${D}`], "no saveAt = no end-of-day save, just the periodic rule");

  // Periodic rule.
  assert.deepEqual(types({ now: local(D, "09:00"), todayAuto: null, memory: mem(done) }), [`auto:${D}`], "first run of the day");
  assert.deepEqual(types({ now: local(D, "09:00"), todayAuto: fresh, memory: mem(done) }), [], "updated 30 min ago");
  assert.deepEqual(types({ now: local(D, "10:30"), todayAuto: fresh, memory: mem(done) }), [`auto:${D}`], "2 h later");
  assert.deepEqual(types({ now: local(D, "09:00"), todayAuto: null, memory: mem({ ...done, tried: { [D]: iso(D, "08:30") } }) }), [], "a quiet day: tried 30 min ago, nothing written, don't hammer GitHub");
  assert.deepEqual(types({ now: local(D, "06:59"), todayAuto: null, memory: mem(done) }), [], "before work hours");
  assert.deepEqual(types({ now: local(D, "20:00"), todayAuto: saved, memory: mem(done) }), [], "after work hours");
  assert.deepEqual(plan({ cfg: { ...cfg, enabled: false }, now: local(D, "09:00"), todayAuto: null }), []);
});

test("createAutoNotes.update writes the day's auto record beside the user's notes; an empty day writes nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-auto-"));
  const day = "2026-11-11";
  const events = [{ type: "PushEvent", created_at: iso(day, "10:00"), repo: { name: "o/api" }, payload: { ref: "refs/heads/main", size: 1, commits: [{ message: "fix" }] } }];
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

  // End-of-day and catch-up marks are stamped once and survive later rebuilds.
  assert.equal(readDayFull(dir, day).auto.eodSavedAt, null);
  await auto.update(day, { reason: "end of day", refresh: true, markEod: true });
  const eod = readDayFull(dir, day).auto.eodSavedAt;
  assert.ok(eod, "end-of-day mark set"); assert.equal(refreshed, 2);
  await auto.update(day, { reason: "later" });
  assert.equal(readDayFull(dir, day).auto.eodSavedAt, eod, "a later rebuild keeps the mark");
  assert.equal(readDayFull(dir, day).auto.catchupAt, null);
  await auto.update(day, { reason: "catch-up", markCatchup: true });
  assert.ok(readDayFull(dir, day).auto.catchupAt);
  assert.equal(readDayFull(dir, day).auto.eodSavedAt, eod);

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
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tick(): one feed download per tick, quiet days not retried, end of day once, midnight catch-up, failures retried later", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-tick-"));
  const D = "2026-11-13";
  const events = [{ type: "PushEvent", created_at: iso("2026-11-12", "10:00"), repo: { name: "o/api" }, payload: { ref: "refs/heads/main", head: "a", before: "b" } }];
  const jira = { state: { issues: [], done: [], fetchedAt: new Date().toISOString() }, refresh: async () => {} };
  let fetches = 0, clock = local(D, "09:00"), failGithub = false;
  const t = createAutoNotes({ cfg, progressDir: dir, jira, data: () => ({ github: { login: "me", mine: [], toReview: [], closed: [], reviewed: [] }, jiraDone: [], since: "2026-01-01" }),
    refreshGithub: async () => { if (failGithub) throw new Error("gh: offline"); }, fetchEvents: async () => { fetches++; return events; },
    claude: async () => '["pushed to main"]', now: () => clock });

  // 09:00, first tick: yesterday (has a push) and today (quiet) — the feed is fetched once for both.
  assert.deepEqual((await t.tick()).map((a) => `${a.type}:${a.date}`), ["catchup:2026-11-12", `auto:${D}`]);
  assert.equal(fetches, 1, "one download served both actions");
  assert.deepEqual(readDayFull(dir, "2026-11-12").auto.points, ["pushed to main"]);
  assert.ok(readDayFull(dir, "2026-11-12").auto.catchupAt);
  assert.equal(fs.existsSync(path.join(dir, `${D}.json`)), false, "quiet today: no file");
  assert.deepEqual(await t.tick(), [], "nothing is retried a minute later");
  assert.equal(fetches, 1);

  // 17:00: the end-of-day save, once; GitHub is down → retried after the interval, then done.
  clock = local(D, "17:00"); failGithub = true;
  assert.deepEqual((await t.tick()).map((a) => a.type), ["eod"]);
  assert.match(t.status().error, /offline/);
  clock = local(D, "17:30");
  assert.deepEqual(await t.tick(), [], "not every minute");
  clock = local(D, "19:00"); failGithub = false;
  assert.deepEqual((await t.tick()).map((a) => a.type), ["eod"], "retried after the interval");
  clock = local(D, "19:30");
  assert.deepEqual(await t.tick(), [], "quiet day saved (nothing stored) — done for today");

  // Midnight: the day that just ended is topped up once.
  clock = local("2026-11-14", "00:00");
  assert.deepEqual((await t.tick()).map((a) => `${a.type}:${a.date}`), [`catchup:${D}`]);
  assert.deepEqual(await t.tick(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
