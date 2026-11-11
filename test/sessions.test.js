import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectSessions, compactSessions, folderName, parseLive, pidAlive, projectSlug, readTitle, sessionActivity, sessionDetails, sessionsFromHistory, titleFromTranscript, withoutPrompts } from "../lib/sessions.js";

const DAY = "2026-11-12";
const ms = (hm, ymd = DAY) => new Date(`${ymd}T${hm}`).getTime();   // local time → epoch ms (what history.jsonl stores)
const A = "384bf14a-2cd8-4c55-a22e-465b1c81e0f8", B = "ed90d947-3142-4fa2-a082-9035b6773aca", C = "961e0998-ffc2-4704-8c4a-05730c904255";
const line = (sessionId, hm, display, ymd = DAY, project = "C:\\Workspace\\github") => JSON.stringify({ display, pastedContents: {}, timestamp: ms(hm, ymd), project, sessionId });

test("folderName and projectSlug follow Claude Code's own conventions", () => {
  assert.equal(folderName("C:\\Workspace\\github\\"), "github");
  assert.equal(folderName("/home/me/repo"), "repo");
  assert.equal(folderName("C:\\"), "C:", "a drive root");
  assert.equal(projectSlug("C:\\Workspace\\github"), "C--Workspace-github");
  assert.equal(projectSlug("C:\\Users\\udham.mander"), "C--Users-udham-mander");
  assert.equal(projectSlug("/home/me/repo"), "-home-me-repo");
});

test("parseLive: a registry file becomes a running session; malformed files and dead processes are dropped", () => {
  const reg = { pid: 640, sessionId: B.toUpperCase(), cwd: "C:\\Workspace\\github", startedAt: ms("00:37"), name: "github-10", status: "busy", updatedAt: ms("00:38"), kind: "interactive" };
  const s = parseLive(JSON.stringify(reg), { alive: () => true });
  assert.deepEqual(s, { id: B, pid: 640, dir: "C:\\Workspace\\github", folder: "github", status: "busy", name: "github-10",
    startedAt: new Date(ms("00:37")).toISOString(), lastActivityAt: new Date(ms("00:38")).toISOString() });
  assert.equal(parseLive(JSON.stringify({ ...reg, status: "weird", updatedAt: undefined }), { alive: () => true }).status, "running", "unknown status → running");
  assert.equal(parseLive(JSON.stringify({ ...reg, updatedAt: undefined }), { alive: () => true }).lastActivityAt, s.startedAt, "no activity stamp: the start");
  assert.equal(parseLive(JSON.stringify(reg), { alive: () => false }), null, "the process is gone");
  assert.equal(parseLive(JSON.stringify({ ...reg, entrypoint: "sdk-cli", name: "temp-66" }), { alive: () => true }), null, "a headless claude -p run is not a session");
  assert.equal(parseLive(JSON.stringify({ ...reg, entrypoint: "cli" }), { alive: () => true })?.id, B);
  assert.equal(parseLive(JSON.stringify({ ...reg, sessionId: "nope" }), { alive: () => true }), null);
  assert.equal(parseLive(JSON.stringify({ ...reg, pid: "640" }), { alive: () => true }), null);
  assert.equal(parseLive("{not json", { alive: () => true }), null);
  assert.equal(parseLive("null", { alive: () => true }), null);
});

test("pidAlive: this node process counts as a Claude Code process; a pid nobody has does not", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 22 - 1), false);
  assert.equal(pidAlive(process.pid), true, "answered from the cached process list");
});

test("sessionsFromHistory: prompts grouped per session on the day, newest activity first; commands and other days ignored", () => {
  const text = [
    line(A, "17:30", "change dir to ai-shield", "2026-11-11"),
    line(A, "23:50", "run the perf test", "2026-11-11"),
    line(A, "00:05", "stop the test and write the report"),
    line(A, "00:37", "log bugs in jira"),
    line(B, "00:38", "analyze if we can create a claude skill"),
    line(B, "00:38", "i mean claude code sessions"),
    line(B, "00:39", "   "),   // an image or a paste: not a prompt
    line(C, "16:13", "/resume", "2026-11-11"),
    line(C, "09:00", "/usage"),
    "{not json", "",
    JSON.stringify({ display: "no session", timestamp: ms("10:00") }),
    JSON.stringify({ display: "bad time", timestamp: "x", sessionId: A }),
  ].join("\n");
  const r = sessionsFromHistory(text, DAY);
  assert.deepEqual(r.map((s) => s.id), [B, A], "most recent activity first");
  const a = r.find((s) => s.id === A);
  assert.deepEqual([a.dir, a.folder, a.startedOn, a.prompts], ["C:\\Workspace\\github", "github", "2026-11-11", 2], "started yesterday, 2 prompts today");
  assert.deepEqual([a.first, a.last], [new Date(ms("00:05")).toISOString(), new Date(ms("00:37")).toISOString()]);
  assert.deepEqual(a.texts, ["stop the test and write the report", "log bugs in jira"], "today's prompts only, in order");
  assert.equal(r.find((s) => s.id === B).startedOn, DAY);
  assert.deepEqual([r.find((s) => s.id === B).prompts, r.find((s) => s.id === B).texts.length], [2, 2], "an empty prompt is neither counted nor listed");
  assert.equal(r.some((s) => s.id === C), false, "slash commands only: not a session worked in");
  assert.deepEqual(sessionsFromHistory(text, "2026-11-11").map((s) => [s.id, s.prompts]), [[A, 2]], "yesterday: A's two prompts; C had only /resume");
  assert.deepEqual(sessionsFromHistory("", DAY), []);
  assert.deepEqual(sessionsFromHistory(null, DAY), []);
  // Long prompts are clipped at 140 characters; whitespace runs collapse.
  const long = sessionsFromHistory(line(B, "10:00", `${"x".repeat(200)}\n\n  y`), DAY)[0].texts[0];
  assert.equal(long.length, 140); assert.ok(long.endsWith("…"));
});

test("titleFromTranscript: the user's own name wins over the generated title; the last of each counts; cut lines are skipped", () => {
  const rec = (o) => JSON.stringify({ ...o, sessionId: A });
  const tail = ['ssistant","content":[]}}', rec({ type: "ai-title", aiTitle: "First title" }), rec({ type: "user", message: { content: "x" } }),
    rec({ type: "ai-title", aiTitle: "Ai-shield directory" })].join("\n");
  assert.equal(titleFromTranscript(tail), "Ai-shield directory");
  assert.equal(titleFromTranscript(`${tail}\n${rec({ type: "custom-title", customTitle: "perf report" })}\n${rec({ type: "ai-title", aiTitle: "Later" })}`), "perf report");
  assert.equal(titleFromTranscript(rec({ type: "user", message: { content: '{"type":"ai-title","aiTitle":"not a record"}' } })), null, "a title inside a message is not a title record");
  assert.equal(titleFromTranscript(rec({ type: "ai-title", aiTitle: 7 })), null);
  assert.equal(titleFromTranscript(""), null);
  assert.equal(titleFromTranscript(rec({ type: "ai-title", aiTitle: `  ${"t".repeat(300)}` })).length, 100, "clipped");
});

test("collectSessions reads the registry, the history and the transcript tails; the day's sessions carry titles and live state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dd-claude-"));
  const dir = "C:\\Workspace\\github", slug = path.join(home, "projects", projectSlug(dir));
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.mkdirSync(slug, { recursive: true });
  const reg = (pid, sessionId, status, hm) => fs.writeFileSync(path.join(home, "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: dir, startedAt: ms("17:30", "2026-11-11"), name: `github-${pid}`, status, updatedAt: ms(hm) }));
  reg(30640, A, "busy", "00:39");
  reg(640, B, "idle", "00:38");
  reg(99, "0f2e5fbc-d326-42d5-8bd6-1aa9e4892f91", "busy", "00:10");   // its process is gone (see `alive` below)
  fs.writeFileSync(path.join(home, "sessions", "notes.txt"), "ignored");
  fs.writeFileSync(path.join(home, "history.jsonl"), [
    line(A, "23:50", "run the perf test", "2026-11-11"), line(A, "00:37", "log bugs in jira"),
    line(B, "00:38", "analyze if we can create a claude skill that can find all active sessions from today"),
  ].join("\n") + "\n");
  // A's transcript is big: the title sits well inside the last 512 KB; B has no transcript yet.
  const filler = `${JSON.stringify({ type: "assistant", message: { content: "x".repeat(1000) } })}\n`;
  fs.writeFileSync(path.join(slug, `${A}.jsonl`), filler.repeat(700) + `${JSON.stringify({ type: "ai-title", aiTitle: "Ai-shield directory", sessionId: A })}\n` + filler.repeat(10));
  assert.equal(readTitle(home, dir, A), "Ai-shield directory");
  assert.equal(readTitle(home, dir, B), null);

  const alive = (pid) => pid !== 99;
  const r = collectSessions(DAY, { home, alive });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.live.map((s) => [s.id, s.status, s.title]), [[A, "busy", "Ai-shield directory"], [B, "idle", null]], "live: most recent activity first; the dead pid is gone");
  assert.deepEqual(r.day.map((s) => s.id), [B, A]);
  const [b, a] = r.day;
  assert.equal(a.title, "Ai-shield directory");
  assert.equal(b.title, "analyze if we can create a claude skill that can find all active sessions from today", "no title yet: the first prompt");
  assert.deepEqual([a.live.status, a.live.pid, b.live.status], ["busy", 30640, "idle"]);
  assert.deepEqual(a.texts, ["log bugs in jira"]);
  const lasting = ["dir", "first", "folder", "id", "last", "prompts", "startedOn", "title"];
  const keys = (list) => list.map((s) => Object.keys(s).sort());
  assert.deepEqual(keys(compactSessions(r.day)), [lasting, lasting], "what is stored: no prompt text, no live state");
  assert.deepEqual(keys(withoutPrompts(r.day)), [[...lasting, "live"].sort(), [...lasting, "live"].sort()], "what the API sends: live state, no prompt text");
  // The title is remembered until the transcript changes: a second collection costs a stat, not a read.
  fs.writeFileSync(path.join(slug, `${A}.jsonl`), `${JSON.stringify({ type: "custom-title", customTitle: "perf", sessionId: A })}\n`);
  assert.equal(collectSessions(DAY, { home, alive }).day.find((s) => s.id === A).title, "perf", "a changed transcript is read again");

  // Yesterday: A only; its live state is about now, so it still shows as running.
  assert.deepEqual(collectSessions("2026-11-11", { home, alive }).day.map((s) => [s.id, s.prompts, s.live?.status]), [[A, 1, "busy"]]);
  // No records at all (a machine without Claude Code): empty, no errors.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dd-noclaude-"));
  assert.deepEqual(collectSessions(DAY, { home: empty, alive }), { live: [], day: [], errors: [] });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test("sessionActivity and sessionDetails: one line per session, and the prompts as clipped data", () => {
  const s = { id: A, title: "Ai-shield directory", folder: "ai-shield", dir: "C:\\w\\ai-shield", startedOn: "2026-11-11",
    first: new Date(ms("09:12")).toISOString(), last: new Date(ms("12:40")).toISOString(), prompts: 11,
    texts: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11"] };
  const [item] = sessionActivity([s]);
  assert.deepEqual([item.kind, item.ref, item.id, item.at], ["claude", "Ai-shield directory", A, s.last]);
  assert.equal(item.text, 'Claude Code session "Ai-shield directory" in ai-shield: 09:12–12:40, 11 prompts');
  assert.equal(sessionActivity([{ ...s, prompts: 1 }])[0].text.endsWith("1 prompt"), true);
  const d = sessionDetails([s, { ...s, texts: [] }]);
  assert.match(d, /^### Claude Code session "Ai-shield directory" \(ai-shield, 09:12–12:40, 11 prompts\)\n/);
  assert.match(d, /Your prompts that day \(the first 2 and the last 6 of 11\): "p1", "p2", "p6", "p7", "p8", "p9", "p10", "p11"$/);
  assert.equal(sessionDetails([{ ...s, texts: ["only"] }]).split("\n")[1], 'Your prompts that day: "only"');
  assert.equal(sessionDetails([]), "");
});
