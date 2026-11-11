import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingNotes } from "../lib/github.js";

const pr = (over = {}) => ({ isDraft: false, baseRefName: "main", reviewDecision: "APPROVED", mergeable: "MERGEABLE", ...over });
const texts = (p) => pendingNotes(p).map((n) => n.text);
const checks = (contexts, state = "FAILURE") => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes: contexts } } } }] } });

test("approved with no checks is ready to merge", () => {
  assert.deepEqual(pendingNotes(pr()), [{ level: "good", text: "Ready to merge" }]);
});

test("draft is reported and not 'waiting for review'", () => {
  assert.deepEqual(texts(pr({ isDraft: true, reviewDecision: "REVIEW_REQUIRED" })), ["Draft — mark ready for review when done"]);
});

test("blocking problems come first and are 'bad'", () => {
  const notes = pendingNotes(pr({
    mergeable: "CONFLICTING",
    latestOpinionatedReviews: { nodes: [{ state: "CHANGES_REQUESTED", author: { login: "ana" } }] },
    ...checks([{ name: "build", conclusion: "FAILURE" }, { name: "lint", conclusion: "SUCCESS" }]),
  }));
  assert.deepEqual(notes.map((n) => n.level), ["bad", "bad", "bad"]);
  assert.deepEqual(notes.map((n) => n.text), ["Merge conflicts with main", "CI failing: build", "Changes requested by ana"]);
});

test("running CI, unresolved threads and requested reviewers", () => {
  assert.deepEqual(texts(pr({
    reviewDecision: "REVIEW_REQUIRED",
    reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "bo" } }, { requestedReviewer: { name: "core-team" } }] },
    ...checks([{ name: "build", status: "IN_PROGRESS" }], "PENDING"),
  })), ["2 unresolved review threads", "CI running (1 check)", "Waiting for review: bo, core-team"]);
});

test("needs review with nobody requested", () => {
  assert.deepEqual(texts(pr({ reviewDecision: "REVIEW_REQUIRED" })), ["Needs review — no reviewers requested"]);
});

test("collectGithub runs four searches, paginates the score ones and sorts them by update time", async () => {
  const { collectGithub } = await import("../lib/github.js");
  const calls = [];
  const repo = { nameWithOwner: "o/r" };
  const node = (n) => ({ number: n, title: `t${n}`, url: `u${n}`, merged: true, mergedAt: "2026-11-01T00:00:00Z", closedAt: "2026-11-01T00:00:00Z", repository: repo, reviews: { nodes: [] } });
  const graphql = async (_query, vars) => {
    calls.push(vars);
    if (/closed:/.test(vars.q)) {   // two pages for the closed search
      return vars.after ? { search: { pageInfo: { hasNextPage: false }, nodes: [node(2)] } }
        : { search: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node(1)] } };
    }
    return { search: { pageInfo: { hasNextPage: false }, nodes: [] } };
  };
  const data = await collectGithub({ since: "2026-09-21" }, { graphql, user: async () => "me" });
  assert.equal(data.login, "me");
  assert.deepEqual(data.closed.map((p) => p.number), [1, 2]);
  const qs = calls.map((c) => c.q);
  assert.ok(qs.some((q) => q === "is:pr is:open archived:false author:me"));
  assert.ok(qs.some((q) => q === "is:pr is:open archived:false review-requested:me"));
  // one day earlier than `since`: GitHub compares in UTC, the window is local
  assert.ok(qs.some((q) => q === "is:pr is:closed archived:false author:me closed:>=2026-09-20 sort:updated-desc"), qs.join("\n"));
  assert.ok(qs.some((q) => q === "is:pr archived:false reviewed-by:me -author:me updated:>=2026-09-20 sort:updated-desc"));
  assert.equal(calls.filter((c) => c.after === "c1").length, 1, "the second page used the cursor");
  assert.equal(calls.length, 5);
});

test("mapClosed / mapReviewed shape the score lists and skip unsubmitted reviews", async () => {
  const { mapClosed, mapReviewed } = await import("../lib/github.js");
  const repo = { nameWithOwner: "o/r" };
  const closed = mapClosed([
    { number: 1, title: "a", url: "u1", merged: true, mergedAt: "2026-11-02T10:00:00Z", closedAt: "2026-11-02T10:00:01Z", createdAt: "2026-10-01T00:00:00Z", baseRefName: "main", repository: repo },
    { number: 2, title: "b", url: "u2", merged: false, mergedAt: null, closedAt: "2026-11-10T10:00:00Z", createdAt: "2026-10-01T00:00:00Z", baseRefName: "main", repository: repo },
    {},   // search can return non-PR nodes
  ]);
  assert.deepEqual(closed.map((p) => [p.number, p.merged, p.closedAt]), [[2, false, "2026-11-10T10:00:00Z"], [1, true, "2026-11-02T10:00:00Z"]], "newest first; merge time wins");
  assert.equal(closed[1].repo, "o/r");

  const reviewed = mapReviewed([
    { number: 5, title: "x", url: "u5", state: "MERGED", author: { login: "ana" }, repository: repo, createdAt: "2026-10-01T00:00:00Z", closedAt: null,
      reviews: { nodes: [{ state: "APPROVED", submittedAt: "2026-11-04T09:00:00Z" }, { state: "COMMENTED", submittedAt: "2026-11-01T09:00:00Z" }, { state: "PENDING", submittedAt: null }] } },
    { number: 6, title: "y", url: "u6", state: "OPEN", author: null, repository: repo, reviews: { nodes: [{ state: "PENDING", submittedAt: null }] } },
  ]);
  assert.equal(reviewed.length, 1, "a PR with only a pending review is not 'reviewed'");
  assert.deepEqual(reviewed[0].reviews.map((r) => r.state), ["COMMENTED", "APPROVED"], "oldest first");
  assert.equal(reviewed[0].lastReviewState, "APPROVED");
  assert.equal(reviewed[0].lastReviewAt, "2026-11-04T09:00:00Z");
  assert.equal(reviewed[0].author, "ana");
});
