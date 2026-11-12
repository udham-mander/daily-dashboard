import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createJiraSource } from "../lib/jira.js";
import { createLauncher } from "../lib/launch.js";
import { createServer } from "../lib/server.js";

let server, port, dir, quit = false, agentOn = true;
const black = [];
const launched = [], launchedArgs = [], autoCalls = [], saved = [];
const SESSION = "384bf14a-2cd8-4c55-a22e-465b1c81e0f8";

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
  request("POST", pathname, { body, headers: { "content-type": "application/json", "x-mwa": "1", origin: `http://127.0.0.1:${port}`, ...extra } });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwa-server-"));
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
    launcher: createLauncher({ defaultDir: dir, recentFile: path.join(dir, "recent.json"), run: async (_f, a, cwd) => { launched.push(cwd); launchedArgs.push(a); } }),
    sessions: (date) => ({   // a stand-in for collectSessions(): one session, running and worked in today
      live: [{ id: SESSION, pid: 1, dir, folder: path.basename(dir), status: "busy", startedAt: "2026-11-12T08:00:00.000Z", lastActivityAt: "2026-11-12T09:00:00.000Z", name: "x-1", title: "Perf report" }],
      day: [{ id: SESSION, title: "Perf report", dir, folder: path.basename(dir), startedOn: date, first: "2026-11-12T08:00:00.000Z", last: "2026-11-12T09:00:00.000Z", prompts: 3,
        texts: ["a prompt that must stay inside the app"], live: { pid: 1, status: "busy", startedAt: "2026-11-12T08:00:00.000Z", lastActivityAt: "2026-11-12T09:00:00.000Z" } }],
      errors: [],
    }),
    auto: {   // a stand-in for createAutoNotes(): records calls, answers like the real one
      update: async (date, opts) => { autoCalls.push([date, opts]); return { auto: { updatedAt: new Date().toISOString(), source: "activity", points: ["did a thing"], errors: [] } }; },
      status() { return { enabled: agentOn, running: false, intervalMinutes: 120, workHours: "07:00-20:00", useClaude: true, blacklist: black }; },
      setEnabled(on) { agentOn = on; return this.status(); },
      dismiss(text) { const entry = { id: `b${black.length + 1}`, refs: [], text, date: null, points: [], at: "" }; black.push(entry); return { entry, added: true, auto: { nudges: [] } }; },
      restore({ id, text }) {
        const gone = black.filter((e) => (id !== undefined ? e.id === id : e.text === text));
        if (!gone.length) return null;
        for (const e of gone) black.splice(black.indexOf(e), 1);
        return { entry: gone[0], removed: gone, auto: { nudges: gone.map((e) => e.text) } };
      },
    },
    saveSetting: (keys, value) => { saved.push([keys, value]); },
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
  assert.equal((await request("POST", "/api/launch", { body: {} })).status, 403, "writes need x-mwa + origin");
  assert.equal((await request("GET", "/api/launch")).status, 404, "never a GET");

  const data = JSON.parse((await request("GET", "/api/data")).body);
  assert.deepEqual(data.claude, { defaultDir: dir, command: "claude", recent: [sub] });

  // Claude sessions: running now and worked in today, without the prompts themselves.
  assert.deepEqual(data.sessions.live.map((s) => [s.id, s.status, s.title]), [[SESSION, "busy", "Perf report"]]);
  assert.deepEqual(data.sessions.today.map((s) => [s.id, s.prompts, s.live.status, s.texts]), [[SESSION, 3, "busy", undefined]], "no prompt text leaves the app");
  assert.deepEqual(data.sessions.errors, []);
  // Resume: the terminal runs `<command> --resume <id>` in that folder; anything but a UUID is refused.
  const r3 = JSON.parse((await write("/api/launch", { dir: sub, resume: SESSION })).body);
  assert.deepEqual([r3.ok, r3.dir, r3.resume], [true, sub, SESSION]);
  assert.ok(launchedArgs.at(-1).some((a) => String(a).includes(`claude --resume ${SESSION}`)), "resumes that session");
  for (const bad of ["384bf14a; calc", "", 7]) {
    const res = await write("/api/launch", { dir: sub, resume: bad });
    assert.equal(res.status, 400, String(bad));
    assert.match(JSON.parse(res.body).error, /session id/);
  }
  assert.equal(launched.length, 3, "nothing launched for a bad id");
});

test("POST /api/auto rebuilds the automatic points (today or a given day); /api/data reports the status", async () => {
  const r = JSON.parse((await write("/api/auto", {})).body);
  assert.deepEqual(r.auto.points, ["did a thing"]);
  assert.equal(r.autoStatus.enabled, true);
  assert.deepEqual(autoCalls.at(-1), [undefined, { reason: "manual" }]);
  assert.equal((await write("/api/auto", { date: "2026-11-10" })).status, 200);
  assert.equal(autoCalls.at(-1)[0], "2026-11-10");
  assert.equal((await write("/api/auto", { date: "nope" })).status, 400);
  assert.equal((await request("POST", "/api/auto", { body: {} })).status, 403, "needs x-mwa + origin");
  assert.equal((await request("GET", "/api/auto")).status, 404, "never a GET");
  const data = JSON.parse((await request("GET", "/api/data")).body);
  assert.equal(data.autoStatus.intervalMinutes, 120);
  assert.equal(data.todayAuto, null, "the stub did not write a file");
});

test("POST /api/agent switches the Activity agent and remembers it in the config", async () => {
  const off = JSON.parse((await write("/api/agent", { enabled: false })).body);
  assert.equal(off.autoStatus.enabled, false);
  assert.deepEqual(saved.at(-1), [["auto", "enabled"], false]);
  assert.equal(JSON.parse((await request("GET", "/api/data")).body).autoStatus.enabled, false);
  const on = JSON.parse((await write("/api/agent", { enabled: true })).body);
  assert.equal(on.autoStatus.enabled, true);
  assert.equal((await write("/api/agent", { enabled: "yes" })).status, 400);
  assert.equal((await write("/api/agent", {})).status, 400);
  assert.equal((await request("GET", "/api/agent")).status, 404, "never a GET");
  assert.equal((await request("POST", "/api/agent", { body: { enabled: false } })).status, 403, "needs x-mwa + origin");
});

test("POST /api/blacklist/add and /remove: the agent's take can be crossed off and put back", async () => {
  const added = JSON.parse((await write("/api/blacklist/add", { text: "Review dbms#11" })).body);
  assert.equal(added.entry.text, "Review dbms#11");
  assert.equal(added.added, true);
  assert.deepEqual(added.auto, { nudges: [] });
  assert.equal(added.autoStatus.blacklist.length, 1);
  assert.equal(JSON.parse((await request("GET", "/api/data")).body).autoStatus.blacklist[0].id, added.entry.id, "/api/data carries the blacklist");
  assert.equal(JSON.parse((await request("GET", "/api/status")).body).autoStatus.blacklist[0].id, added.entry.id, "/api/status too (no GitHub refresh)");
  const removed = JSON.parse((await write("/api/blacklist/remove", { id: added.entry.id })).body);
  assert.deepEqual([removed.removed, removed.auto], [1, { nudges: ["Review dbms#11"] }]);
  assert.equal(removed.autoStatus.blacklist.length, 0);
  assert.equal((await write("/api/blacklist/remove", { id: added.entry.id })).status, 400, "unknown id");
  await write("/api/blacklist/add", { text: "same" }); await write("/api/blacklist/add", { text: "same" });
  const byText = JSON.parse((await write("/api/blacklist/remove", { text: "same" })).body);
  assert.equal(byText.removed, 2, "by text: every covering entry");
  assert.equal((await write("/api/blacklist/remove", { text: "same" })).status, 400);
  assert.equal((await write("/api/blacklist/remove", {})).status, 400, "neither id nor text");
  assert.equal((await write("/api/blacklist/remove", { id: 5 })).status, 400);
  assert.equal((await write("/api/blacklist/add", { text: "" })).status, 400);
  assert.equal((await write("/api/blacklist/add", { text: 7 })).status, 400);
  assert.equal((await write("/api/blacklist/add", { text: "x".repeat(301) })).status, 400);
  assert.equal((await request("POST", "/api/blacklist/add", { body: { text: "x" } })).status, 403, "needs x-mwa + origin");
  assert.equal((await request("GET", "/api/blacklist/add")).status, 404, "never a GET");
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
  assert.equal((await request("POST", "/api/save", { body: {} })).status, 403, "no x-mwa/origin");
  assert.equal((await write("/api/save", {}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await write("/api/save", {}, { "x-mwa": "0" })).status, 403);
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
  assert.equal((await get("/", nav)).status, 200, "a link to the app from elsewhere");
  assert.equal((await get("/", iframe)).status, 403, "embedding is refused");
  assert.equal((await get("/api/data", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })).status, 200, "our own page");
  assert.equal((await get("/", { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })).status, 200, "typed URL / desktop icon");
  assert.equal((await get("/api/data", {})).status, 200, "non-browser client such as mwa.js");
});

test("a refresh (which runs Claude) is POST-only; GET /api/data never triggers it", async () => {
  let refreshes = 0;
  const jiraSpy = { state: { issues: [] }, status: () => ({ running: false }), refresh: () => { refreshes++; return Promise.resolve(); } };
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "mwa-server2-"));
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
    assert.equal(await req("POST", "/api/refresh", {}, {}), 403, "needs origin + x-mwa");
    const hdrs = { "x-mwa": "1", origin: `http://127.0.0.1:${port2}`, "content-type": "application/json" };
    assert.equal(await req("POST", "/api/refresh", hdrs, {}), 200);
    assert.equal(refreshes, 1);
    assert.equal(await req("POST", "/api/launch", hdrs, {}), 404, "no launcher injected = feature off");
    assert.equal(await req("POST", "/api/auto", hdrs, {}), 404, "no auto notes injected = feature off");
    assert.equal(await req("POST", "/api/blacklist/add", hdrs, { text: "x" }), 404, "no blacklist = feature off, not a 500");
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
  assert.equal((await request("POST", "/api/entries", { body: { text: "x" } })).status, 403, "writes need x-mwa + origin");

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
