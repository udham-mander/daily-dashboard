// "How did we do?" — what was finished, counted per week: Jira issues moved to Done,
// pull requests merged, pull requests reviewed. Pure functions over the data snapshots.
import { addDays, dateOf, localDate, weekStart } from "./dates.js";

/** When a Jira issue was finished: the move to the Done category, else its resolution (never `updated`). */
export const doneDate = (issue) => issue.statusCategoryChangedAt ?? issue.resolved ?? null;

/** Trims the finished lists to the table's window (`since`, YYYY-MM-DD), so lists and counts agree. */
export function withinWindow({ jiraDone = [], closed = [], reviewed = [] }, since) {
  const after = (iso) => { const d = dateOf(iso); return d !== null && d >= since; };
  return {
    jiraDone: jiraDone.filter((j) => after(doneDate(j))),
    closed: closed.filter((pr) => after(pr.closedAt)),
    reviewed: reviewed.filter((pr) => after(pr.lastReviewAt)),
  };
}

/** Merges a stored `done` snapshot with a live computation for the same day (no duplicates). */
export function mergeDone(stored = {}, live = {}) {
  const union = (a = [], b = [], id) => { const seen = new Set(a.map(id)); return [...a, ...b.filter((x) => !seen.has(id(x)))]; };
  const prId = (pr) => `${pr.repo}#${pr.number}`;
  return {
    jira: union(stored.jira, live.jira, (j) => j.key),
    prs: union(stored.prs, live.prs, prId),
    reviewed: union(stored.reviewed, live.reviewed, prId),
  };
}

/** First day of the oldest week a `weeks`-row table covers (the current week is row one). */
export const scoreSince = (weeks, today = localDate()) => addDays(weekStart(today), -7 * (weeks - 1));

const empty = () => ({ jiraDone: 0, prsMerged: 0, prsReviewed: 0, total: 0 });

/**
 * Weekly counts, current week first.
 * @param {{jiraDone?: object[], closed?: object[], reviewed?: object[]}} data
 * @returns {{since: string, weeks: object[], totals: object}}
 */
export function weeklyScore({ jiraDone = [], closed = [], reviewed = [] }, weeks = 8, today = localDate()) {
  const first = weekStart(today);
  const rows = Array.from({ length: Math.max(1, weeks) }, (_, i) => {
    const start = addDays(first, -7 * i);
    return { start, end: addDays(start, 6), ...empty() };
  });
  const rowFor = (iso) => { const d = dateOf(iso); return d ? rows.find((r) => d >= r.start && d <= r.end) : undefined; };

  for (const j of jiraDone) { const r = rowFor(doneDate(j)); if (r) r.jiraDone++; }
  for (const pr of closed) if (pr.merged) { const r = rowFor(pr.closedAt); if (r) r.prsMerged++; }
  for (const pr of reviewed) {
    const counted = new Set();   // one PR counts once per week, however many review rounds
    for (const rv of pr.reviews ?? []) {
      const r = rowFor(rv.at);
      if (r && !counted.has(r.start)) { counted.add(r.start); r.prsReviewed++; }
    }
  }
  const totals = empty();
  for (const r of rows) {
    r.total = r.jiraDone + r.prsMerged + r.prsReviewed;
    for (const k of Object.keys(totals)) totals[k] += r[k];
  }
  return { since: rows.at(-1).start, weeks: rows, totals };
}

/** What was finished on one local day — goes into that day's log file. */
export function doneOn(date, { jiraDone = [], closed = [], reviewed = [] }) {
  return {
    jira: jiraDone.filter((j) => dateOf(doneDate(j)) === date),
    prs: closed.filter((pr) => dateOf(pr.closedAt) === date),
    reviewed: reviewed.filter((pr) => (pr.reviews ?? []).some((rv) => dateOf(rv.at) === date)),
  };
}
