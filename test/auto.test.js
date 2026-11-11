import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildAuto, createAutoNotes, freshMemory, parseAnswer, parsePoints, plan, stateSummary, summaryPrompt } from "../lib/auto.js";
import { createBlacklist } from "../lib/blacklist.js";
import { loadProgress, readDayFull } from "../lib/progress.js";

const cfg = { enabled: true, intervalMinutes: 120, workHours: "07:00-20:00", saveAt: "17:00", catchupDays: 1, useClaude: true, nudges: true, model: "haiku" };
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

test("parseAnswer: {points, nudges} or a bare array; anything else is rejected", () => {
  assert.deepEqual(parseAnswer('{"points": ["a"], "nudges": ["b", " c "]}'), { points: ["a"], nudges: ["b", "c"] });
  assert.deepEqual(parseAnswer('{"points": ["a"]}'), { points: ["a"], nudges: [] });
  assert.deepEqual(parseAnswer('["x"]'), { points: ["x"], nudges: [] });
  assert.equal(parseAnswer(JSON.stringify({ points: [], nudges: Array.from({ length: 20 }, (_, i) => `n${i}`) })).nudges.length, 6);
  assert.throws(() => parseAnswer('{"a":1}'), /array/);
  assert.throws(() => parseAnswer('{"points": "none"}'), /array of strings/);
});

test("summaryPrompt: activity and details as data, Jira reads only when allowed, nudges only with a state", () => {
  const items = [{ text: "Pushed 2 commits\nto x" }, { text: "Finished A-1" }];
  const p = summaryPrompt("2026-11-11", { items });
  assert.match(p, /2026-11-11/);
  assert.match(p, /ACTIVITY:\n- Pushed 2 commits to x\n- Finished A-1/);
  assert.match(p, /ONLY one JSON object/);
  assert.match(p, /WHAT was done/);
  assert.doesNotMatch(p, /getJiraIssue|CURRENT STATE|DETAILS:/);
  const full = summaryPrompt("2026-11-11", { items, details: "### api#7 — CSV\nYour commits today: \"Add export\"", state: "Open Jira issues:\n- A-1 · In Progress · 20d · no PR", jiraKeys: ["A-1"], site: "acme.atlassian.net" });
  assert.match(full, /DETAILS:\n### api#7/);
  assert.match(full, /CURRENT STATE:\nOpen Jira issues/);
  assert.match(full, /mcp__claude_ai_Atlassian__getJiraIssue with cloudId "acme.atlassian.net" for these keys only/);
  assert.match(full, /comments the engineer wrote on 2026-11-11\. The issue's description and comments from other days are background/);
  assert.match(p, /Only the ACTIVITY and the lines marked "Your …" in DETAILS are what the engineer did on 2026-11-11/, "background is never reported as the day's work");
  assert.match(full, /"nudges": from the CURRENT STATE/);
  assert.doesNotMatch(summaryPrompt("2026-11-11", { items, jiraKeys: ["A-1"], site: "" }), /getJiraIssue/, "no site, no tool");
});

test("stateSummary writes out open work, waiting reviews and the week's score as data", () => {
  const now = local("2026-11-11", "10:00");
  const s = stateSummary({
    jiraOpen: [{ key: "AB-1", summary: "Slow thing", status: "In Progress", statusCategoryChangedAt: local("2026-10-20", "09:00").toISOString() }],
    github: {
      mine: [{ repo: "o/api", number: 9, title: "AB-1 export", branch: "ab-1", draft: true, createdAt: local("2026-11-06", "09:00").toISOString(), pending: [{ level: "info", text: "Draft" }] }],
      toReview: [{ repo: "o/web", number: 3, title: "Fix", author: "ana", createdAt: local("2026-11-08", "09:00").toISOString() }],
      closed: [], reviewed: [],
    },
    jiraDone: [], now, weeks: 2,
  });
  assert.match(s, /- AB-1 · In Progress · 22d · api#9 \(draft\) · "Slow thing"/);
  assert.match(s, /- api#9 · 5d · Draft · "AB-1 export"/);
  assert.match(s, /- web#3 · by ana · waiting 3d · "Fix"/);
  assert.match(s, /Score — this week: 0 Jira done · 0 PRs merged · 0 reviewed; last week: 0 · 0 · 0/);
});

test("buildAuto: Claude bullets when they come back, raw activity lines when Claude fails or returns nothing", async () => {
  const activity = { items: [{ text: "Pushed 1 commit to api:main: fix" }, { text: "Finished A-1 (Done): s", kind: "jira", ref: "A-1" }], errors: ["GitHub activity: partial"] };
  const ok = await buildAuto("2026-11-11", { activity, useClaude: true, model: "haiku", claude: async () => '["Fixed main", "Closed A-1"]' });
  assert.deepEqual([ok.source, ok.points, ok.errors, ok.nudges], ["claude", ["Fixed main", "Closed A-1"], ["GitHub activity: partial"], []]);
  assert.equal(ok.activity.length, 2);

  // With details, a state and Jira keys: the prompt carries them, the Jira read tool is allowed, nudges come back.
  let seen;
  const rich = await buildAuto("2026-11-11", { activity, details: "### api#7", state: "Open Jira issues:", jiraKeys: ["A-1"], site: "acme.atlassian.net", useClaude: true, model: "haiku",
    claude: async (prompt, opts) => { seen = { prompt, opts }; return '{"points": ["Shipped the CSV export (api#7)"], "nudges": ["web#3 has waited 3 days for your review"]}'; } });
  assert.deepEqual(rich.points, ["Shipped the CSV export (api#7)"]);
  assert.deepEqual(rich.nudges, ["web#3 has waited 3 days for your review"]);
  assert.deepEqual(seen.opts.allowedTools, ["mcp__claude_ai_Atlassian__getJiraIssue"]);
  assert.match(seen.prompt, /DETAILS:\n### api#7/);
  const noSite = await buildAuto("2026-11-11", { activity, jiraKeys: ["A-1"], site: "", useClaude: true, model: "haiku", claude: async (_p, opts) => { seen = opts; return "[]"; } });
  assert.deepEqual(seen.allowedTools, [], "token mode / no site: no tools at all");
  assert.equal(noSite.source, "activity");

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

  // With a blacklist: the prompt names what was crossed off, and nudges about it are dropped anyway.
  const blacklist = { hints: () => ["dbms#11", '"Your week trails last week"'], filter: (n) => n.filter((x) => !/dbms#11/i.test(x)), list: () => [] };
  const crossed = await buildAuto("2026-11-11", { activity, state: "Open Jira issues:", useClaude: true, model: "haiku", blacklist,
    claude: async (prompt) => { seen = prompt; return '{"points": ["Fixed main"], "nudges": ["Review DBMS#11 — 44 days", "web#3 waits for you"]}'; } });
  assert.match(seen, /crossed these off as not important[^\n]*dbms#11; "Your week trails last week"/);
  assert.deepEqual(crossed.nudges, ["web#3 waits for you"]);
  await buildAuto("2026-11-11", { activity, useClaude: true, model: "haiku", blacklist, claude: async (prompt) => { seen = prompt; return "[]"; } });
  assert.doesNotMatch(seen, /crossed these off/, "no take asked for (past day): no blacklist in the prompt");
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
  const detailCalls = [], prompts = [];
  const auto = createAutoNotes({
    cfg, progressDir: dir, jira, data: data(), site: "acme.atlassian.net",
    refreshGithub: async () => { refreshed++; },
    fetchEvents: async () => events,
    details: async (date, items, { login }) => { detailCalls.push({ date, n: items.length, login }); return { text: "### api:main\nYour commits today: \"fix\"", errors: [] }; },
    claude: async (prompt) => { claudeCalls++; prompts.push(prompt); return '{"points": ["Fixed main"], "nudges": ["nothing urgent"]}'; },
    now: () => local(day, "10:00"),
  });
  const r = await auto.update(day, { reason: "test" });
  assert.deepEqual(r.auto.points, ["Fixed main"]);
  assert.deepEqual(r.auto.nudges, ["nothing urgent"], "today gets the agent's take");
  assert.deepEqual(detailCalls, [{ date: day, n: 1, login: "me" }], "details fetched for the day's items");
  assert.match(prompts[0], /DETAILS:\n### api:main/);
  assert.match(prompts[0], /CURRENT STATE:/);
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

  // An empty past day with no file: nothing is written (no weekend files)…
  assert.equal(await auto.update("2026-11-08", { reason: "test" }), null);
  assert.equal(fs.existsSync(path.join(dir, "2026-11-08.json")), false);
  // …but a quiet *today* still gets the agent's take (it is about what is open, not what happened).
  const quiet = createAutoNotes({ cfg, progressDir: dir, jira, data: data(), fetchEvents: async () => [], refreshGithub: async () => {},
    claude: async (p) => { assert.match(p, /CURRENT STATE/); assert.doesNotMatch(p, /DETAILS:/); return '{"points": [], "nudges": ["web#3 has waited 3 days"]}'; },
    now: () => local("2026-11-15", "10:00") });
  const q = await quiet.update("2026-11-15", { reason: "scheduled" });
  assert.deepEqual([q.auto.points, q.auto.nudges], [[], ["web#3 has waited 3 days"]]);
  assert.equal(await createAutoNotes({ cfg: { ...cfg, nudges: false }, progressDir: dir, jira, data: data(), fetchEvents: async () => [], refreshGithub: async () => {},
    claude: async () => "[]", now: () => local("2026-11-16", "10:00") }).update("2026-11-16", { reason: "scheduled" }), null, "nudges off: a quiet today writes nothing");
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

test("dismiss/restore: a crossed-off nudge leaves today's take and is blacklisted; restoring puts it back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-dismiss-"));
  const day = "2026-11-11";
  const jira = { state: { issues: [], done: [], fetchedAt: new Date().toISOString() }, refresh: async () => {} };
  const data = () => ({ github: { login: "me", mine: [], toReview: [], closed: [], reviewed: [] }, jiraDone: [], since: "2026-01-01" });
  const blacklist = createBlacklist(path.join(dir, "blacklist.json"));
  const take = ["Review dbms#11 — 43 days", "MAYA-26 in progress 86 days, no PR", "Your week trails last week"];
  const auto = createAutoNotes({ cfg, progressDir: dir, jira, data, blacklist, refreshGithub: async () => {}, fetchEvents: async () => [],
    claude: async () => JSON.stringify({ points: [], nudges: take }), now: () => local(day, "10:00") });
  assert.deepEqual((await auto.update(day)).auto.nudges, take);
  assert.deepEqual(auto.status().blacklist, []);

  const d = auto.dismiss("MAYA-26 in progress 86 days, no PR");
  assert.deepEqual([d.entry.refs, d.entry.date, d.entry.points, d.added], [["MAYA-26"], day, [{ index: 1, text: take[1] }], true]);
  assert.deepEqual(d.auto.nudges, [take[0], take[2]], "gone from today's record");
  assert.deepEqual(readDayFull(dir, day).auto.nudges, [take[0], take[2]]);
  assert.deepEqual(auto.status().blacklist.map((e) => e.refs), [["MAYA-26"]]);
  assert.deepEqual(auto.dismiss("MAYA-26 again").added, false, "already covered");
  // A later build: Claude is told, and anything about MAYA-26 is filtered out anyway.
  const again = await auto.update(day);
  assert.deepEqual(again.auto.nudges, [take[0], take[2]]);
  // Restoring (undo) puts the point back where it was.
  assert.equal(auto.restore({ id: "unknown" }), null);
  assert.equal(auto.restore({ text: "nothing like this" }), null);
  const r = auto.restore({ id: d.entry.id });
  assert.deepEqual([r.entry.id, r.removed.length], [d.entry.id, 1]);
  assert.deepEqual(r.auto.nudges, take);
  assert.deepEqual(readDayFull(dir, day).auto.nudges, take);
  assert.deepEqual(auto.status().blacklist, []);
  // Restoring an entry from another day does not touch today's take; a text the page no longer shows is still blacklisted.
  const old = blacklist.add("web#3 is stale", { date: "2026-11-01", points: [{ index: 0, text: "web#3 is stale" }] }).entry;
  assert.deepEqual(auto.restore({ id: old.id }).auto.nudges, take);
  const stale = auto.dismiss("dbms#11 — a wording the record never had");
  assert.deepEqual(stale.auto.nudges, [take[1], take[2]], "the item it names is crossed off all the same");
  assert.deepEqual(stale.entry.points, [{ index: 0, text: take[0] }], "it remembers what it took out, not its own text");
  assert.deepEqual(auto.restore({ text: "acme/DBMS#11" }).auto.nudges, take, "by item, in any spelling: what the entry took out comes back; its own text is never inserted");
  assert.deepEqual(auto.status().blacklist, []);
  // Stacked cross-offs: an entry takes its siblings too (same item); undoing by text brings every point back, in order.
  auto.dismiss(take[0]); auto.dismiss("dbms#11 and MAYA-26 are both old");
  assert.deepEqual(readDayFull(dir, day).auto.nudges, [take[2]]);
  assert.deepEqual(auto.status().blacklist.map((e) => e.points.map((p) => p.index)), [[0], [0]], "indices as the take stood at each cross-off");
  const both = auto.restore({ text: "dbms#11" });
  assert.equal(both.removed.length, 2);
  assert.deepEqual(both.auto.nudges, take);
  // Undo of one cross-off that took two points (both naming dbms#11) brings both back.
  await auto.update(day);
  const twin = createAutoNotes({ cfg, progressDir: dir, jira, data, blacklist, refreshGithub: async () => {}, fetchEvents: async () => [],
    claude: async () => JSON.stringify({ points: [], nudges: ["Review dbms#11 — 43 days", "dbms#11 has failing CI", "web#3 waits"] }), now: () => local(day, "11:00") });
  await twin.update(day);
  const t = twin.dismiss("dbms#11 has failing CI");
  assert.deepEqual([t.auto.nudges, t.entry.points.map((p) => p.index)], [["web#3 waits"], [0, 1]]);
  assert.deepEqual(twin.restore({ id: t.entry.id }).auto.nudges, ["Review dbms#11 — 43 days", "dbms#11 has failing CI", "web#3 waits"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tick(): one feed download per tick, quiet days not retried, end of day once, midnight catch-up, failures retried later", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-tick-"));
  const D = "2026-11-13";
  const events = [{ type: "PushEvent", created_at: iso("2026-11-12", "10:00"), repo: { name: "o/api" }, payload: { ref: "refs/heads/main", head: "a", before: "b" } }];
  const jira = { state: { issues: [], done: [], fetchedAt: new Date().toISOString() }, refresh: async () => {} };
  let fetches = 0, clock = local(D, "09:00"), failGithub = false;
  // nudges off: this test is about quiet days, and the agent's take would give today a file.
  const t = createAutoNotes({ cfg: { ...cfg, nudges: false }, progressDir: dir, jira, data: () => ({ github: { login: "me", mine: [], toReview: [], closed: [], reviewed: [] }, jiraDone: [], since: "2026-01-01" }),
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
