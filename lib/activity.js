// What the user actually did on a day, from records that already exist: their GitHub event
// feed (pushes, PRs, reviews, comments) and the Jira issues that changed. Pure functions, plus
// one collector that fetches the events through `gh`.
import { dateOf } from "./dates.js";
import { doneDate } from "./score.js";

const shortRepo = (name) => String(name ?? "").split("/")[1] ?? name;
const title = (s) => String(s ?? "").split("\n")[0].trim().slice(0, 100);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const REVIEW_RANK = { approved: 3, changes_requested: 2, commented: 1 };

/** "repo#123" → title, from the PR lists the app already has (the event feed carries no titles). */
export function knownTitles(github = {}) {
  const map = new Map();
  for (const list of [github.mine, github.toReview, github.closed, github.reviewed])
    for (const pr of list ?? []) if (pr?.repo && pr.number && pr.title) map.set(`${shortRepo(pr.repo)}#${pr.number}`, title(pr.title));
  return map;
}

/**
 * Turns GitHub events (GET /users/:login/events) that happened on `date` into activity lines.
 * The feed's payloads are slim: a push has only ref/head (no commits), a PR only its number,
 * and PR actions are "opened" | "merged" | "closed". Pushes are grouped per branch, reviews
 * per PR; branch create/delete noise is dropped.
 * @param {Map<string,string>} [titles]  "repo#n" → PR title, see knownTitles()
 * @returns {{at: string, kind: string, ref: string, text: string}[]}  oldest first
 */
export function activityFromEvents(events, date, titles = new Map()) {
  const pushes = new Map(), reviews = new Map(), out = [];
  const onDay = (events ?? []).filter((e) => e?.created_at && dateOf(e.created_at) === date)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const named = (ref, fallback) => { const t = title(fallback) || titles.get(ref); return t ? `${ref}: ${t}` : ref; };
  for (const e of onDay) {
    const repo = shortRepo(e.repo?.name), p = e.payload ?? {}, pr = p.pull_request;
    const ref = pr ? `${repo}#${pr.number}` : p.issue ? `${repo}#${p.issue.number}` : repo;
    switch (e.type) {
      case "PushEvent": {
        const key = `${repo}:${String(p.ref ?? "").replace("refs/heads/", "")}`;
        const g = pushes.get(key) ?? { at: e.created_at, kind: "push", ref: key, pushes: 0, commits: 0, titles: [] };
        g.pushes += 1;
        g.commits += p.size ?? p.commits?.length ?? 0;
        g.at = e.created_at;
        for (const c of p.commits ?? []) { const t = title(c.message); if (t && !g.titles.includes(t)) g.titles.push(t); }
        pushes.set(key, g);
        break;
      }
      case "PullRequestEvent": {
        const verb = { opened: "Opened", merged: "Merged", closed: pr?.merged ? "Merged" : "Closed", reopened: "Reopened", ready_for_review: "Marked ready for review" }[p.action];
        if (verb) out.push({ at: e.created_at, kind: "pr", ref, text: `${verb} PR ${named(ref, pr?.title)}` });
        break;
      }
      case "PullRequestReviewEvent": {
        const state = String(p.review?.state ?? "commented").toLowerCase();
        const r = reviews.get(ref) ?? { at: e.created_at, kind: "review", ref, title: pr?.title, state, comments: 0 };
        if ((REVIEW_RANK[state] ?? 0) >= (REVIEW_RANK[r.state] ?? 0)) r.state = state;
        r.at = e.created_at;
        reviews.set(ref, r);
        break;
      }
      case "PullRequestReviewCommentEvent": {
        const r = reviews.get(ref) ?? { at: e.created_at, kind: "review", ref, title: pr?.title, state: "commented", comments: 0 };
        r.comments += 1;
        reviews.set(ref, r);
        break;
      }
      case "IssueCommentEvent":
        if (p.action === "created") out.push({ at: e.created_at, kind: "comment", ref, text: `Commented on ${named(ref, p.issue?.title)}` });
        break;
      default: break;   // CreateEvent/DeleteEvent/WatchEvent…: noise for a daily log
    }
  }
  for (const g of pushes.values()) {
    const count = g.commits ? plural(g.commits, "commit") : g.pushes > 1 ? `${g.pushes} times` : "";
    const what = g.titles.length ? `: ${g.titles.slice(0, 3).join("; ")}${g.titles.length > 3 ? "; …" : ""}` : "";
    out.push({ at: g.at, kind: g.kind, ref: g.ref, text: `Pushed${count ? ` ${count}` : ""} to ${g.ref}${what}` });
  }
  for (const r of reviews.values()) {
    const how = r.state.replace("_", " ") + (r.comments ? `, ${plural(r.comments, "comment")}` : "");
    out.push({ at: r.at, kind: r.kind, ref: r.ref, text: `Reviewed PR ${named(r.ref, r.title).replace(r.ref, `${r.ref} (${how})`)}` });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Jira changes on `date`, from the current open/done lists: issues finished, issues whose
 * status changed, and issues otherwise updated that day.
 */
export function activityFromJira({ open = [], done = [] }, date) {
  const out = [];
  const seen = new Set();
  for (const j of done) if (dateOf(doneDate(j)) === date) { seen.add(j.key); out.push({ at: doneDate(j), kind: "jira", ref: j.key, text: `Finished ${j.key} (${j.status}): ${title(j.summary)}` }); }
  for (const j of open) {
    if (dateOf(j.statusCategoryChangedAt) === date) {
      // Jira sets the status-category date on creation too: that is a new issue, not a move.
      const isNew = j.created && Math.abs(Date.parse(j.statusCategoryChangedAt) - Date.parse(j.created)) < 60_000;
      seen.add(j.key);
      out.push({ at: j.statusCategoryChangedAt, kind: "jira", ref: j.key, text: isNew ? `Created ${j.key} (${j.status}): ${title(j.summary)}` : `${j.key} moved to ${j.status}: ${title(j.summary)}` });
    } else if (dateOf(j.updated) === date && !seen.has(j.key)) out.push({ at: j.updated, kind: "jira", ref: j.key, text: `${j.key} updated (${j.status}): ${title(j.summary)}` });
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/**
 * Downloads the event feed (newest first, 100 per page, GitHub keeps ~300 events / 90 days)
 * until a page ends before `date`. `complete` is false when the feed ran out first.
 * @returns {Promise<{events: object[], complete: boolean}>}
 */
export async function fetchFeedUntil(login, date, fetchEvents, maxPages = 3) {
  const events = [];
  let complete = false;
  for (let page = 1; page <= maxPages && !complete; page++) {
    const batch = await fetchEvents(login, page);
    events.push(...batch);
    complete = batch.length < 100 || (batch.at(-1)?.created_at && dateOf(batch.at(-1).created_at) < date);
  }
  return { events, complete };
}

/**
 * Everything recorded for `date`. GitHub events come from `feed` (already downloaded, see
 * fetchFeedUntil) or through `fetchEvents(login, page)`.
 * @returns {Promise<{items: object[], errors: string[]}>}
 */
export async function collectActivity(date, { login, jira, github = {}, fetchEvents, feed, maxPages = 3 }) {
  const items = [], errors = [];
  if (login && (feed || fetchEvents)) {
    try {
      const { events, complete } = feed ?? await fetchFeedUntil(login, date, fetchEvents, maxPages);
      if (!complete) errors.push(`GitHub activity: the event feed was cut off before reaching the start of ${date} (GitHub keeps ~300 events); the day may be incomplete`);
      items.push(...activityFromEvents(events, date, knownTitles(github)));
    } catch (e) { errors.push(`GitHub activity: ${e.message}`); }
  } else if (!login) errors.push("GitHub activity: not signed in (no login)");
  items.push(...activityFromJira(jira ?? {}, date));
  return { items: items.sort((a, b) => String(a.at).localeCompare(String(b.at))), errors };
}
