import assert from "node:assert/strict";
import { test } from "node:test";
import { collectDetails, describePr, prQuery } from "../lib/details.js";

const DAY = "2026-11-10";
const at = (hm, ymd = DAY) => new Date(`${ymd}T${hm}`).toISOString();

test("prQuery batches pull requests with aliases", () => {
  const q = prQuery([{ repo: "o/api", number: 7 }, { repo: "o/web", number: 12 }]);
  assert.match(q, /pr0: repository\(owner: "o", name: "api"\) \{ pullRequest\(number: 7\)/);
  assert.match(q, /pr1: repository\(owner: "o", name: "web"\) \{ pullRequest\(number: 12\)/);
  assert.match(q, /bodyText/); assert.match(q, /messageHeadline/); assert.match(q, /reviews\(last: 30\)/);
});

test("describePr keeps only the user's own work on the day, clipped", () => {
  const pr = {
    title: "DSM-1: Do the thing", bodyText: "Problem\n" + "x".repeat(2000), additions: 10, deletions: 2, changedFiles: 3,
    commits: { nodes: [
      { commit: { messageHeadline: "DSM-1: mine today", committedDate: at("09:00"), author: { user: { login: "me" } } } },
      { commit: { messageHeadline: "someone else", committedDate: at("09:30"), author: { user: { login: "ana" } } } },
      { commit: { messageHeadline: "mine yesterday", committedDate: at("09:00", "2026-11-09"), author: { user: { login: "me" } } } },
    ] },
    reviews: { nodes: [
      { author: { login: "me" }, state: "COMMENTED", submittedAt: at("11:00"), bodyText: "", comments: { nodes: [{ path: "src/a/DBManager.java", bodyText: "Fixed in 91e528f.", createdAt: at("11:00") }] } },
      { author: { login: "me" }, state: "APPROVED", submittedAt: at("15:00"), bodyText: "Looks good.", comments: { nodes: [] } },
      { author: { login: "bot" }, state: "COMMENTED", submittedAt: at("08:00"), bodyText: "nit", comments: { nodes: [] } },
    ] },
    comments: { nodes: [{ author: { login: "me" }, createdAt: at("12:00"), bodyText: "Rebased on main." }, { author: { login: "ana" }, createdAt: at("12:30"), bodyText: "thanks" }] },
  };
  const d = describePr("api#7", pr, { login: "me", date: DAY });
  assert.match(d, /^### api#7 — DSM-1: Do the thing  \(\+10 −2, 3 files\)\n/);
  assert.match(d, /Description: Problem\nx+…\n/);
  assert.ok(d.length < 1400, "clipped");
  assert.match(d, /Your commits today: "DSM-1: mine today"\n/);
  assert.doesNotMatch(d, /someone else|mine yesterday|nit|thanks/);
  assert.match(d, /Your review today: commented, approved — 2 comment\(s\)\n  - DBManager.java: Fixed in 91e528f.\n  - Looks good.\n/);
  assert.match(d, /Your comments today: "Rebased on main."/);
  assert.equal(describePr("api#7", null, { login: "me", date: DAY }), null);
});

test("collectDetails: one GraphQL call for the PRs, commits per pushed branch, failures reported", async () => {
  const items = [
    { ref: "api#7", repo: "o/api", number: 7 },
    { ref: "api#7", repo: "o/api", number: 7 },                 // duplicate (review + merge events)
    { ref: "api:feat/x", repo: "o/api", branch: "feat/x" },
    { ref: "web:main", repo: "o/web", branch: "main" },
    { ref: "evil", repo: "bad repo name", number: 1 },          // skipped
  ];
  const calls = { graphql: 0, rest: [] };
  const graphql = async (q) => { calls.graphql++; assert.match(q, /pr0:/); assert.doesNotMatch(q, /pr1:/, "deduplicated"); return { pr0: { pullRequest: { title: "T", bodyText: "", additions: 1, deletions: 0, changedFiles: 1, commits: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } } } }; };
  const rest = async (path) => { calls.rest.push(path); if (path.includes("o/web")) throw new Error("422"); return [{ commit: { message: "feat: x\n\nbody" } }]; };
  const r = await collectDetails(DAY, items, { login: "me", graphql, rest });
  assert.equal(calls.graphql, 1);
  assert.equal(calls.rest.length, 2);
  assert.match(calls.rest[0], /repos\/o\/api\/commits\?sha=feat%2Fx&author=me&since=/);
  assert.match(r.text, /### api#7 — T/);
  assert.match(r.text, /### Branch api:feat\/x\nYour commits today: "feat: x"/);
  assert.doesNotMatch(r.text, /web:main/, "a failing branch lookup is just skipped");
  assert.deepEqual(r.errors, []);

  const failing = await collectDetails(DAY, items.slice(0, 1), { login: "me", graphql: async () => { throw new Error("rate limited"); }, rest });
  assert.equal(failing.text, "");
  assert.deepEqual(failing.errors, ["PR details: rate limited"]);
  assert.deepEqual(await collectDetails(DAY, [{ ref: "A-1", kind: "jira" }], { login: "me", graphql, rest }), { text: "", errors: [] }, "nothing to look up");
});
