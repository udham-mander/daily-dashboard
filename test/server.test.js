import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createJiraSource } from "../lib/jira.js";
import { createLauncher } from "../lib/launch.js";
import { createServer } from "../lib/server.js";

let server, port, dir, quit = false;
const launched = [], autoCalls = [];

// Raw requests so tests can set Host/Origin freely (fetch won't let us forge Host).
function request(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname,
      headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const write = (pathname, body, extra = {}) =>
  request("POST", pathname, { body, headers: { "content-type": "application/json", "x-dd": "1", origin: `http://127.0.0.1:${port}`, ...extra } });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-server-"));
  // Find a free port first: the server's allowed Host/Origin depend on it.
  port = await new Promise((r) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const cfg = { port, progressDir: path.join(dir, "progress"), githubCacheSeconds: 60, scoreWeeks: 4 };
  const jira = createJiraSource({ site: "s", mode: "claude" }, path.join(dir, "cache.json"),
    async () => ({
      open: [{ key: "PROJ-1", summary: "S", url: "", type: "Story", priority: "Low", status: "Open", statusCategory: "To Do" }],
      done: [{ key: "PROJ-0", summary: "Finished", status: "Closed", statusCategory: "Done", statusCategoryChangedAt: new Date().toISOString() }],
    }));
  await jira.refresh();
  server = createServer({
    cfg, jira, publicDir: path.join(import.meta.dirname, "..", "public"),
    collectGithub: async (opts) => { githubArgs = opts; return { login: "me", mine: [], toReview: [],
      closed: [{ repo: "o/r", number: 1, title: "M", url: "https://github.com/o/r/pull/1", merged: true, closedAt: new Date().toISOString() }],
      reviewed: [] }; },
    launcher: createLauncher({ defaultDir: dir, recentFile: path.join(dir, "recent.json"), run: async (_f, _a, cwd) => { launched.push(cwd); } }),
    auto: {   // a stand-in for createAutoNotes(): records calls, answers like the real one
      update: async (date, opts) => { autoCalls.push([date, opts]); return { auto: { updatedAt: new Date().toISOString(), source: "activity", points: ["did a thing"], errors: [] } }; },
      status: () => ({ enabled: true, running: false, intervalMinutes: 120, workHours: "07:00-20:00", useClaude: true }),
    },
    onQuit: () => { quit = true; },
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
let githubArgs;

test("score: weekly table built from done Jira, closed PRs and reviews; GitHub asked since the oldest week", async () => {
  const data = JSON.parse((await request("GET", "/api/data")).body);
  assert.equal(data.jiraDone[0].key, "PROJ-0");
  assert.equal(data.github.closed.length, 1);
  assert.equal(data.score.weeks.length, 4);
  assert.deepEqual([data.score.weeks[0].jiraDone, data.score.weeks[0].prsMerged, data.score.weeks[0].prsReviewed], [1, 1, 0]);
  assert.equal(data.score.totals.total, 2);
  assert.match(githubArgs.since, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(githubArgs.since, data.score.since);
});

test("POST /api/launch opens Claude in the default or a given folder and reports recent folders", async () => {
  const r = JSON.parse((await write("/api/launch", {})).body);
  assert.deepEqual([r.ok, r.dir, r.recent], [true, dir, []]);
  assert.deepEqual(launched, [dir]);

  const sub = path.join(dir, "repo"); fs.mkdirSync(sub);
  const r2 = await write("/api/launch", { dir: sub });
  assert.equal(r2.status, 200);
  assert.deepEqual(JSON.parse(r2.body).recent, [sub]);
  assert.deepEqual(launched, [dir, sub]);

  for (const [bad, re] of [["relative/x", /absolute/], [path.join(dir, "missing"), /not found/], [`${sub} & calc`, /unsupported/]]) {
    const res = await write("/api/launch", { dir: bad });
    assert.equal(res.status, 400, bad);
    assert.match(JSON.parse(res.body).error, re);
  }
  assert.equal(launched.length, 2, "nothing launched for bad folders");
  assert.equal((await request("POST", "/api/launch", { body: {} })).status, 403, "writes need x-dd + origin");
  assert.equal((await request("GET", "/api/launch")).status, 404, "never a GET");

  const data = JSON.parse((await request("GET", "/api/data")).body);
  assert.deepEqual(data.claude, { defaultDir: dir, command: "claude", recent: [sub] });
});

test("POST /api/auto rebuilds the automatic points (today or a given day); /api/data reports the status", async () => {
  const r = JSON.parse((await write("/api/auto", {})).body);
  assert.deepEqual(r.auto.points, ["did a thing"]);
  assert.equal(r.autoStatus.enabled, true);
  assert.deepEqual(autoCalls.at(-1), [undefined, { reason: "manual" }]);
  assert.equal((await write("/api/auto", { date: "2026-11-10" })).status, 200);
  assert.equal(autoCalls.at(-1)[0], "2026-11-10");
  assert.equal((await write("/api/auto", { date: "nope" })).status, 400);
  assert.equal((await request("POST", "/api/auto", { body: {} })).status, 403, "needs x-dd + origin");
  assert.equal((await request("GET", "/api/auto")).status, 404, "never a GET");
  const data = JSON.parse((await request("GET", "/api/data")).body);
  assert.equal(data.autoStatus.intervalMinutes, 120);
  assert.equal(data.todayAuto, null, "the stub did not write a file");
});

test("a saved day's 'done' is topped up from live data while the day is inside the score window", async () => {
  await write("/api/entries", { text: "first note of the day" });
  const today = JSON.parse((await request("GET", "/api/data")).body).today;
  const day = JSON.parse((await request("GET", `/api/day?date=${today}`)).body);
  assert.deepEqual(day.done.prs.map((p) => p.number), [1], "the PR merged today shows even though it was stored with the note");
  assert.deepEqual(day.done.jira.map((j) => j.key), ["PROJ-0"]);
  // Simulate an older snapshot that missed them: strip `done` from the file, read again.
  const file = path.join(dir, "progress", `${today}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...stored, done: { jira: [], prs: [], reviewed: [] } }));
  const again = JSON.parse((await request("GET", `/api/day?date=${today}`)).body);
  assert.deepEqual(again.done.prs.map((p) => p.number), [1], "live data fills the gap");
  const h = JSON.parse((await request("GET", "/api/history?days=1")).body);
  assert.equal(h.days[0].counts.done, 2, "history count is topped up too");
});

test("serves the page and assets with a strict CSP", async () => {
  const res = await request("GET", "/");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-security-policy"], /script-src 'self'/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  for (const p of ["/main.js", "/shared.js", "/history", "/history.js", "/styles.css", "/theme.js", "/icon.svg"])
    assert.equal((await request("GET", p)).status, 200, p);
  assert.equal((await request("GET", "/../app.js")).status, 404);
});

test("returns data from the injected sources", async () => {
  const data = JSON.parse((await request("GET", "/api/data")).body);
  assert.equal(data.github.login, "me");
  assert.equal(data.jira[0].key, "PROJ-1");
  assert.equal(data.jiraStatus.running, false);
});

test("rejects foreign hosts and cross-site writes", async () => {
  assert.equal((await request("GET", "/api/data", { headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal((await request("POST", "/api/save", { body: {} })).status, 403, "no x-dd/origin");
  assert.equal((await write("/api/save", {}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await write("/api/save", {}, { "x-dd": "0" })).status, 403);
});

test("rejects cross-site subresource/fetch GETs but allows navigations (Sec-Fetch-*)", async () => {
  const get = (p, headers) => request("GET", p, { headers });
  const img = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" };
  const xhr = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
  const nav = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  const iframe = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
  assert.equal((await get("/api/data", img)).status, 403, "<img src> on another site");
  assert.equal((await get("/api/data", xhr)).status, 403, "fetch() from another site");
  assert.equal((await get("/api/data", { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" })).status, 403);
  assert.equal((await get("/", nav)).status, 200, "a link to the dashboard from elsewhere");
  assert.equal((await get("/", iframe)).status, 403, "embedding is refused");
  assert.equal((await get("/api/data", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })).status, 200, "our own page");
  assert.equal((await get("/", { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })).status, 200, "typed URL / desktop icon");
  assert.equal((await get("/api/data", {})).status, 200, "non-browser client such as dd.js");
});

test("a refresh (which runs Claude) is POST-only; GET /api/data never triggers it", async () => {
  let refreshes = 0;
  const jiraSpy = { state: { issues: [] }, status: () => ({ running: false }), refresh: () => { refreshes++; return Promise.resolve(); } };
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "dd-server2-"));
  const port2 = await new Promise((r) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const srv = createServer({ cfg: { port: port2, progressDir: dir2, githubCacheSeconds: 60 }, jira: jiraSpy,
    publicDir: path.join(import.meta.dirname, "..", "public"), collectGithub: async () => ({ login: "me", mine: [], toReview: [] }) });
  await new Promise((r) => srv.listen(port2, "127.0.0.1", r));
  const req = (method, p, headers = {}, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: port2, method, path: p, headers: { host: `127.0.0.1:${port2}`, ...headers } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
  try {
    assert.equal(await req("GET", "/api/data?refresh=1"), 200);
    assert.equal(refreshes, 0, "the old GET trigger is gone");
    assert.equal(await req("GET", "/api/refresh"), 404);
    assert.equal(await req("POST", "/api/refresh", {}, {}), 403, "needs origin + x-dd");
    const hdrs = { "x-dd": "1", origin: `http://127.0.0.1:${port2}`, "content-type": "application/json" };
    assert.equal(await req("POST", "/api/refresh", hdrs, {}), 200);
    assert.equal(refreshes, 1);
    assert.equal(await req("POST", "/api/launch", hdrs, {}), 404, "no launcher injected = feature off");
    assert.equal(await req("POST", "/api/auto", hdrs, {}), 404, "no auto notes injected = feature off");
  } finally {
    srv.close(); fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test("internal errors are logged in full but reported generically", async () => {
  const logs = [];
  const broken = { state: { issues: [] }, status: () => { throw new Error("C:\\secret\\path exploded"); }, refresh: async () => {} };
  const port3 = await new Promise((r) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const srv = createServer({ cfg: { port: port3, progressDir: os.tmpdir(), githubCacheSeconds: 60 }, jira: broken,
    publicDir: path.join(import.meta.dirname, "..", "public"), collectGithub: async () => ({}), log: (m) => logs.push(m) });
  await new Promise((r) => srv.listen(port3, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${port3}/api/status`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "internal error — see app.log" });
    assert.match(logs.join("\n"), /secret\\path exploded/);
  } finally { srv.close(); }
});

test("saves merge and history reads them back", async () => {
  await write("/api/save", { notes: { "jira:PROJ-1": "from Claude" } });
  const r = JSON.parse((await write("/api/save", { notes: { summary: "from page" } })).body);
  assert.deepEqual(r.notes, { "jira:PROJ-1": "from Claude", summary: "from page" });
  const h = JSON.parse((await request("GET", "/api/history?days=3")).body);
  assert.equal(h.days[0].notes.summary, "from page");
});

test("entries API: add, list in data, delete; day endpoint", async () => {
  const added = JSON.parse((await write("/api/entries", { text: "Logged from a test" })).body);
  assert.equal(added.entry.text, "Logged from a test");
  const data = JSON.parse((await request("GET", "/api/data")).body);
  assert.ok(data.todayEntries.some((e) => e.id === added.entry.id));

  assert.equal((await write("/api/entries", { text: "  " })).status, 400);
  assert.equal((await request("POST", "/api/entries", { body: { text: "x" } })).status, 403, "writes need x-dd + origin");

  const day = JSON.parse((await request("GET", `/api/day?date=${data.today}`)).body);
  assert.ok(day.entries.length >= 1);
  assert.equal(day.jira[0].key, "PROJ-1");
  assert.equal((await request("GET", "/api/day?date=1999-01-01")).status, 404);
  assert.equal((await request("GET", "/api/day?date=..%2Fx")).status, 400);

  const del = await write("/api/entries/delete", { id: added.entry.id });
  assert.equal(del.status, 200);
  assert.equal((await write("/api/entries/delete", { id: added.entry.id })).status, 400, "already gone");
});

test("quit calls onQuit", async () => {
  assert.equal((await write("/api/quit", {})).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(quit, true);
});
