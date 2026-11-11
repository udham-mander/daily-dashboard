import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, dateOf, localDate, weekStart } from "../lib/dates.js";
import { doneDate, doneOn, mergeDone, scoreSince, weeklyScore, withinWindow } from "../lib/score.js";

// 2026-11-11 is a Wednesday; its week is Mon 09 → Sun 15.
const TODAY = "2026-11-11";
const at = (ymd, hm = "10:00") => new Date(`${ymd}T${hm}`).toISOString();   // local time → ISO

test("week helpers use the local calendar and start on Monday", () => {
  assert.equal(weekStart(TODAY), "2026-11-09");
  assert.equal(weekStart("2026-11-09"), "2026-11-09", "a Monday is its own week start");
  assert.equal(weekStart("2026-11-15"), "2026-11-09", "Sunday belongs to the week before");
  assert.equal(addDays("2026-11-01", -1), "2026-10-31");
  assert.equal(dateOf(at("2026-11-10", "23:30")), "2026-11-10", "late evening stays on the local day");
  assert.equal(dateOf("garbage"), null);
  assert.equal(scoreSince(8, TODAY), "2026-09-21");
  assert.equal(scoreSince(1, TODAY), "2026-11-09", "one week = just this week");
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test("weeklyScore counts Jira done, merged PRs and reviewed PRs per week, newest first", () => {
  const data = {
    jiraDone: [
      { key: "A-1", statusCategoryChangedAt: at("2026-11-10") },           // this week
      { key: "A-2", statusCategoryChangedAt: at("2026-11-03") },           // last week
      { key: "A-3", resolved: at("2026-11-02") },                          // last week, via resolved
      { key: "A-4", statusCategoryChangedAt: at("2026-01-01") },           // too old: ignored
    ],
    closed: [
      { number: 1, merged: true, closedAt: at("2026-11-09") },             // this week
      { number: 2, merged: false, closedAt: at("2026-11-09") },            // closed, not merged: listed, not scored
      { number: 3, merged: true, closedAt: at("2026-10-28") },             // 2 weeks ago
    ],
    reviewed: [
      { number: 9, reviews: [{ state: "COMMENTED", at: at("2026-11-02") }, { state: "APPROVED", at: at("2026-11-04") }] }, // 2 rounds, 1 week
      { number: 8, reviews: [{ state: "COMMENTED", at: at("2026-11-03") }, { state: "APPROVED", at: at("2026-11-10") }] }, // 2 weeks
    ],
  };
  const s = weeklyScore(data, 3, TODAY);
  assert.equal(s.weeks.length, 3);
  assert.equal(s.since, "2026-10-26");
  assert.deepEqual(s.weeks.map((w) => [w.start, w.end]), [["2026-11-09", "2026-11-15"], ["2026-11-02", "2026-11-08"], ["2026-10-26", "2026-11-01"]]);
  assert.deepEqual(s.weeks.map((w) => [w.jiraDone, w.prsMerged, w.prsReviewed, w.total]), [[1, 1, 1, 3], [2, 0, 2, 4], [0, 1, 0, 1]]);
  assert.deepEqual(s.totals, { jiraDone: 3, prsMerged: 2, prsReviewed: 3, total: 8 });
});

test("weeklyScore tolerates empty or partial data", () => {
  const s = weeklyScore({}, 2, TODAY);
  assert.deepEqual(s.totals, { jiraDone: 0, prsMerged: 0, prsReviewed: 0, total: 0 });
  assert.equal(weeklyScore({ reviewed: [{ number: 1 }], closed: [{ merged: true }] }, 0, TODAY).weeks.length, 1, "at least one row");
});

test("doneDate never falls back to `updated`; withinWindow trims lists to the table; mergeDone unions by id", () => {
  assert.equal(doneDate({ updated: at("2026-11-10") }), null);
  assert.equal(doneDate({ resolved: "r", updated: "u" }), "r");
  assert.equal(weeklyScore({ jiraDone: [{ key: "X-1", updated: at("2026-11-10") }] }, 2, TODAY).totals.jiraDone, 0, "not scored without a done date");

  const w = withinWindow({
    jiraDone: [{ key: "A", statusCategoryChangedAt: at("2026-10-26") }, { key: "B", statusCategoryChangedAt: at("2026-10-25") }, { key: "C" }],
    closed: [{ number: 1, closedAt: at("2026-10-26") }, { number: 2, closedAt: at("2026-10-01") }],
    reviewed: [{ number: 3, lastReviewAt: at("2026-11-01") }, { number: 4, lastReviewAt: at("2026-10-20") }],
  }, "2026-10-26");
  assert.deepEqual([w.jiraDone.map((j) => j.key), w.closed.map((p) => p.number), w.reviewed.map((p) => p.number)], [["A"], [1], [3]]);

  const m = mergeDone(
    { jira: [{ key: "A" }], prs: [{ repo: "o/r", number: 1 }], reviewed: [] },
    { jira: [{ key: "A" }, { key: "B" }], prs: [{ repo: "o/r", number: 1 }, { repo: "o/r", number: 2 }], reviewed: [{ repo: "o/x", number: 9 }] });
  assert.deepEqual([m.jira.map((j) => j.key), m.prs.map((p) => p.number), m.reviewed.map((p) => p.number)], [["A", "B"], [1, 2], [9]]);
  assert.deepEqual(mergeDone(undefined, {}), { jira: [], prs: [], reviewed: [] });
});

test("doneOn picks what finished on one day", () => {
  const data = {
    jiraDone: [{ key: "A-1", statusCategoryChangedAt: at("2026-11-11", "09:00") }, { key: "A-2", statusCategoryChangedAt: at("2026-11-10") }],
    closed: [{ number: 1, closedAt: at("2026-11-11", "18:00") }, { number: 2, closedAt: at("2026-11-12") }],
    reviewed: [{ number: 3, reviews: [{ at: at("2026-11-01") }, { at: at("2026-11-11") }] }, { number: 4, reviews: [{ at: at("2026-11-10") }] }],
  };
  const d = doneOn("2026-11-11", data);
  assert.deepEqual([d.jira.map((j) => j.key), d.prs.map((p) => p.number), d.reviewed.map((p) => p.number)], [["A-1"], [1], [3]]);
  assert.deepEqual(doneOn("2026-11-11", {}), { jira: [], prs: [], reviewed: [] });
});
