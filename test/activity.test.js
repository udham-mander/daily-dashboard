import assert from "node:assert/strict";
import { test } from "node:test";
import { activityFromEvents, activityFromJira, collectActivity, knownTitles } from "../lib/activity.js";

const DAY = "2026-11-11";
const at = (hm, ymd = DAY) => new Date(`${ymd}T${hm}`).toISOString();   // local time → ISO
const ev = (type, created_at, payload, repo = "o/api") => ({ type, created_at, repo: { name: repo }, payload });

test("activityFromEvents: pushes grouped per branch, reviews per PR, PR actions, comments; other days ignored", () => {
  const events = [
    ev("PushEvent", at("09:00"), { ref: "refs/heads/feat/x", size: 2, commits: [{ message: "Add CSV export\n\nlong body" }, { message: "Fix tests" }] }),
    ev("PushEvent", at("11:00"), { ref: "refs/heads/feat/x", size: 1, commits: [{ message: "Fix tests" }] }),
    ev("PullRequestEvent", at("11:30"), { action: "opened", pull_request: { number: 7, title: "CSV export", merged: false } }),
    ev("PullRequestReviewCommentEvent", at("13:00"), { action: "created", pull_request: { number: 9, title: "Oracle tests" } }, "o/web"),
    ev("PullRequestReviewEvent", at("13:01"), { action: "created", review: { state: "commented" }, pull_request: { number: 9, title: "Oracle tests" } }, "o/web"),
    ev("PullRequestReviewEvent", at("15:00"), { action: "created", review: { state: "approved" }, pull_request: { number: 9, title: "Oracle tests" } }, "o/web"),
    ev("PullRequestEvent", at("16:00"), { action: "closed", pull_request: { number: 5, title: "Old one", merged: true } }),
    ev("IssueCommentEvent", at("16:30"), { action: "created", issue: { number: 12, title: "Flaky build" } }),
    ev("CreateEvent", at("08:00"), { ref: "feat/x", ref_type: "branch" }),
    ev("PushEvent", at("23:30", "2026-11-10"), { ref: "refs/heads/main", size: 1, commits: [{ message: "yesterday" }] }),
  ];
  const texts = activityFromEvents(events, DAY).map((a) => a.text);
  assert.deepEqual(texts, [
    "Pushed 3 commits to api:feat/x: Add CSV export; Fix tests",
    "Opened PR api#7: CSV export",
    "Reviewed PR web#9 (approved, 1 comment): Oracle tests",
    "Merged PR api#5: Old one",
    "Commented on api#12: Flaky build",
  ]);
  assert.deepEqual(activityFromEvents(events, "2026-11-10").map((a) => a.text), ["Pushed 1 commit to api:main: yesterday"]);
  assert.deepEqual(activityFromEvents([], DAY), []);
  assert.deepEqual(activityFromEvents([{ type: "PushEvent" }, null], DAY), [], "malformed events are skipped");
});

test("activityFromEvents copes with today's slim payloads: no commits, no titles, action 'merged'", () => {
  const slim = [
    ev("PushEvent", at("09:00"), { ref: "refs/heads/main", head: "abc", before: "def" }, "o/udham-swe"),
    ev("PushEvent", at("09:30"), { ref: "refs/heads/main", head: "abd", before: "abc" }, "o/udham-swe"),
    ev("PushEvent", at("10:00"), { ref: "refs/heads/feature/x", head: "a", before: "b" }, "o/ai-shield"),
    ev("PullRequestEvent", at("11:00"), { action: "merged", number: 63, pull_request: { number: 63, url: "u" } }, "o/dbms"),
    ev("PullRequestEvent", at("11:05"), { action: "closed", number: 262, pull_request: { number: 262 } }, "o/controller"),
    ev("PullRequestReviewEvent", at("12:00"), { action: "created", review: { state: "approved" }, pull_request: { number: 81 } }, "o/dbms"),
  ];
  const titles = knownTitles({ closed: [{ repo: "o/dbms", number: 63, title: "DSM-7528: Never drop a Shared DB location" }], reviewed: [{ repo: "o/dbms", number: 81, title: "DSM-6485: TLS tests" }] });
  assert.deepEqual(activityFromEvents(slim, DAY, titles).map((a) => a.text), [
    "Pushed 2 times to udham-swe:main",
    "Pushed to ai-shield:feature/x",
    "Merged PR dbms#63: DSM-7528: Never drop a Shared DB location",
    "Closed PR controller#262",
    "Reviewed PR dbms#81 (approved): DSM-6485: TLS tests",
  ]);
  assert.equal(knownTitles({}).size, 0);
});

test("activityFromJira: finished, moved and updated issues on the day", () => {
  const open = [
    { key: "A-0", summary: "Brand new", status: "To Do", created: at("09:00"), statusCategoryChangedAt: at("09:00"), updated: at("09:00") },
    { key: "A-1", summary: "Moved today", status: "In Review", created: at("09:00", "2026-10-01"), statusCategoryChangedAt: at("10:00"), updated: at("10:00") },
    { key: "A-2", summary: "Touched today", status: "In Progress", statusCategoryChangedAt: at("10:00", "2026-11-01"), updated: at("12:00") },
    { key: "A-3", summary: "Untouched", status: "To Do", updated: at("12:00", "2026-11-02") },
  ];
  const done = [{ key: "A-9", summary: "Closed today", status: "Closed", statusCategoryChangedAt: at("17:00") }];
  assert.deepEqual(activityFromJira({ open, done }, DAY).map((a) => a.text), [
    "Created A-0 (To Do): Brand new",
    "A-1 moved to In Review: Moved today",
    "A-2 updated (In Progress): Touched today",
    "Finished A-9 (Closed): Closed today",
  ]);
  assert.deepEqual(activityFromJira({}, DAY), []);
});

test("collectActivity pages the event feed until it passes the day, and reports (not throws) failures", async () => {
  const pages = [];
  const fetchEvents = async (login, page) => {
    pages.push(`${login}:${page}`);
    if (page === 1) return Array.from({ length: 100 }, () => ev("IssueCommentEvent", at("09:00"), { action: "created", issue: { number: 1, title: "t" } }));
    return [ev("PushEvent", at("09:00", "2026-11-10"), { ref: "refs/heads/m", size: 1, commits: [] })];   // older than the day → stop
  };
  const r = await collectActivity(DAY, { login: "me", jira: {}, fetchEvents });
  assert.deepEqual(pages, ["me:1", "me:2"]);
  assert.equal(r.items.length, 100);
  assert.deepEqual(r.errors, []);

  const failing = await collectActivity(DAY, { login: "me", jira: { done: [{ key: "A-1", summary: "s", status: "Done", statusCategoryChangedAt: at("08:00") }] }, fetchEvents: async () => { throw new Error("gh: 401"); } });
  assert.deepEqual(failing.items.map((i) => i.text), ["Finished A-1 (Done): s"], "Jira still contributes");
  assert.match(failing.errors[0], /GitHub activity: gh: 401/);
  assert.match((await collectActivity(DAY, { login: null, jira: {}, fetchEvents })).errors[0], /not signed in/);

  // Three full pages still on the day: the feed is cut off and the record says so.
  const busy = async () => Array.from({ length: 100 }, () => ev("IssueCommentEvent", at("09:00"), { action: "created", issue: { number: 1, title: "t" } }));
  const cut = await collectActivity(DAY, { login: "me", jira: {}, fetchEvents: busy });
  assert.equal(cut.items.length, 300);
  assert.match(cut.errors[0], /GitHub activity: the event feed was cut off/);
});
