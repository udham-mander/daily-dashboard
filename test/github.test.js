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
