import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createJiraSource, normalizeIssues, parseClaudeOutput } from "../lib/jira.js";

const compact = {
  key: "PROJ-73", summary: "Add CSV export", type: "Story", priority: "Medium",
  status: "In Progress", statusCategory: "In Progress",
  created: "2026-10-06T07:04:58.309-0500", updated: "2026-10-30T06:13:17.731-0500",
  statusCategoryChangedAt: "2026-10-22T03:37:16.300-0500",
};

test("normalizes the compact shape and builds the URL itself", () => {
  const [j] = normalizeIssues([{ ...compact, url: "https://evil.example/x" }], "acme.atlassian.net");
  assert.equal(j.url, "https://acme.atlassian.net/browse/PROJ-73");
  assert.equal(j.statusCategory, "In Progress");
});

test("normalizes a raw Jira issue", () => {
  const [j] = normalizeIssues([{ key: "OPS-1", fields: {
    summary: "s", issuetype: { name: "Bug" }, priority: { name: "High" },
    status: { name: "Open", statusCategory: { name: "To Do" } }, statuscategorychangedate: "2026-11-01T00:00:00Z",
  } }], "x.atlassian.net");
  assert.deepEqual([j.type, j.priority, j.status, j.statusCategory], ["Bug", "High", "Open", "To Do"]);
});

test("rejects malformed issues", () => {
  assert.throws(() => normalizeIssues({}, "s"), /array/);
  assert.throws(() => normalizeIssues([{ ...compact, key: "not a key" }], "s"), /validation/);
  assert.throws(() => normalizeIssues([{ ...compact, updated: "yesterday" }], "s"), /bad date/);
});

test("parses claude -p JSON output, with or without a code fence", () => {
  const out = (result) => JSON.stringify({ is_error: false, result });
  assert.equal(parseClaudeOutput(out(JSON.stringify([compact])), "s").length, 1);
  assert.equal(parseClaudeOutput(out("```json\n" + JSON.stringify([compact]) + "\n```"), "s").length, 1);
  assert.throws(() => parseClaudeOutput(JSON.stringify({ is_error: true, result: "no access" }), "s"), /no access/);
});

test("source caches good results and keeps them when a refresh fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-jira-"));
  const cache = path.join(dir, "cache.json");
  let fail = false;
  const src = createJiraSource({ site: "s", mode: "claude" }, cache, async () => {
    if (fail) throw new Error("boom");
    return normalizeIssues([compact], "s");
  });
  await src.refresh();
  assert.equal(src.state.issues.length, 1);
  assert.ok(fs.existsSync(cache));

  fail = true;
  await src.refresh();
  assert.equal(src.state.error, "boom");
  assert.equal(src.state.issues.length, 1, "last good data kept");

  const again = createJiraSource({ site: "s", mode: "claude" }, cache, async () => []);
  again.loadCache();
  assert.equal(again.state.issues.length, 1, "cache reloads");
  fs.rmSync(dir, { recursive: true });
});

test("loadCache re-validates the file and rebuilds URLs; a tampered cache is ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-jira-"));
  const cache = path.join(dir, "cache.json");

  fs.writeFileSync(cache, JSON.stringify({ issues: [{ ...compact, url: "javascript:alert(1)" }], fetchedAt: "2026-11-11T00:00:00Z" }));
  const ok = createJiraSource({ site: "good.example.com", mode: "claude" }, cache, async () => []);
  ok.loadCache();
  assert.equal(ok.state.issues[0].url, "https://good.example.com/browse/PROJ-73");
  assert.equal(ok.state.fetchedAt, "2026-11-11T00:00:00Z");

  fs.writeFileSync(cache, JSON.stringify({ issues: [{ key: "<img onerror=x>", summary: "s", status: "Open" }] }));
  const bad = createJiraSource({ site: "good.example.com", mode: "claude" }, cache, async () => []);
  bad.loadCache();
  assert.equal(bad.state.issues, null, "invalid cache dropped");
  fs.rmSync(dir, { recursive: true });
});

test("an empty jira.site reports how to set it up and never runs a fetch", async () => {
  let fetched = 0;
  const src = createJiraSource({ site: "", mode: "claude" }, path.join(os.tmpdir(), "dd-unused-cache.json"), async () => { fetched++; return []; });
  await src.refresh();
  assert.equal(fetched, 0);
  assert.match(src.state.error, /not set up yet/);
  assert.equal(src.status().configured, false);
  assert.equal(src.state.running, false);
});
