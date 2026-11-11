// Claude Code sessions on this machine, from the records Claude Code keeps for itself under
// ~/.claude (or $CLAUDE_CONFIG_DIR):
//   sessions/<pid>.json           one file per running interactive session (gone once it exits)
//   history.jsonl                 one line per prompt: text, time, folder, session id
//   projects/<slug>/<id>.jsonl    the transcript — read only at its end, for the title Claude
//                                 gave the session (or the name the user gave it)
// Pure functions over file contents, plus one collector that reads them. Nothing is written.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hhmm, localDate } from "./dates.js";

export const claudeHome = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = { title: 100, prompt: 140, prompts: 8, sessions: 20 };
const TAIL_BYTES = 512 * 1024;   // the title records are rewritten near the end of the transcript
const STATUSES = new Set(["busy", "idle"]);
const PROCESS_RE = /^(claude|node)(\.exe)?$/i;   // what a Claude Code session's process is called
const NAMES_TTL_MS = 60_000;
const TITLE_CACHE_MAX = 200;

const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** The last segment of a folder path: "C:\Workspace\github" → "github". */
export const folderName = (dir) => String(dir ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(dir ?? "");
/** Where Claude Code keeps a folder's transcripts: every character that is not a letter or digit becomes "-". */
export const projectSlug = (dir) => String(dir ?? "").replace(/[^A-Za-z0-9]/g, "-");
/** A slash command ("/resume", "/usage") is not work. */
const isCommand = (text) => /^\s*\//.test(String(text ?? ""));

// pid → process name, from the OS; one listing serves a minute of checks (one `tasklist` on Windows).
const names = { at: 0, map: null };
function processNames(fresh = false) {
  if (!fresh && names.map && Date.now() - names.at < NAMES_TTL_MS) return names.map;
  let map = null;
  try {
    map = new Map();
    if (process.platform === "win32") {
      const csv = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      for (const line of csv.split("\n")) { const m = line.match(/^"([^"]*)","(\d+)"/); if (m) map.set(Number(m[2]), m[1]); }
    } else if (process.platform === "linux") {
      for (const d of fs.readdirSync("/proc")) if (/^\d+$/.test(d)) { try { map.set(Number(d), fs.readFileSync(`/proc/${d}/comm`, "utf8").trim()); } catch { /* gone */ } }
    } else {
      const out = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 10_000 });
      for (const line of out.split("\n")) { const m = line.trim().match(/^(\d+)\s+(.*)$/); if (m) map.set(Number(m[1]), path.basename(m[2])); }
    }
  } catch { map = null; }   // no process list on this system: the pid alone decides
  names.at = Date.now(); names.map = map;
  return map;
}

/**
 * Does this session's process still run? A registry file outlives a session that crashed or
 * whose terminal was closed, and the OS reuses pids: the process must exist *and* be a Claude
 * Code process (claude, or node running it).
 */
export function pidAlive(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== "EPERM") return false; }
  let map = processNames();
  if (map && !map.has(pid)) map = processNames(true);   // started since the last listing
  return !map || PROCESS_RE.test(map.get(pid) ?? "");
}

/**
 * One registry file → a running session, or null when the file is not one, its process is
 * gone, or it is a headless `claude -p` run (entrypoint "sdk-cli": the app's own Jira refresh
 * and summary calls register themselves the same way while they run).
 * @param {string} json
 * @param {{ alive?: (pid: number) => boolean }} [o]
 */
export function parseLive(json, { alive = pidAlive } = {}) {
  let s; try { s = JSON.parse(json); } catch { return null; }
  if (!s || typeof s !== "object" || !SESSION_ID_RE.test(String(s.sessionId)) || !Number.isInteger(s.pid) || s.pid <= 0) return null;
  if (s.entrypoint === "sdk-cli" || !alive(s.pid)) return null;
  const at = (ms) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);
  const dir = typeof s.cwd === "string" ? s.cwd : "";
  return {
    id: s.sessionId.toLowerCase(), pid: s.pid, dir, folder: folderName(dir),
    status: STATUSES.has(s.status) ? s.status : "running",
    startedAt: at(s.startedAt), lastActivityAt: at(s.updatedAt) ?? at(s.startedAt),
    name: typeof s.name === "string" ? clip(s.name, 40) : null,
  };
}

/**
 * The sessions with prompts on `date` (a local calendar day), from the text of history.jsonl,
 * most recent activity first. A session started on an earlier day counts with that day's
 * prompts only; slash commands and empty prompts (an image, a paste) are not prompts, and a
 * session with nothing else is left out.
 * @returns {{ id: string, dir: string, folder: string, startedOn: string, first: string, last: string, prompts: number, texts: string[] }[]}
 */
export function sessionsFromHistory(text, date) {
  const by = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== "object" || !SESSION_ID_RE.test(String(o.sessionId)) || typeof o.timestamp !== "number") continue;
    const id = o.sessionId.toLowerCase(), day = localDate(new Date(o.timestamp));
    const s = by.get(id) ?? { id, dir: typeof o.project === "string" ? o.project : "", startedOn: day, first: null, last: null, prompts: 0, texts: [] };
    if (day < s.startedOn) s.startedOn = day;
    const text = clip(o.display, LIMITS.prompt);
    if (day === date && text && !isCommand(text)) {
      s.prompts++;
      if (s.first === null || o.timestamp < s.first) s.first = o.timestamp;
      if (s.last === null || o.timestamp >= s.last) s.last = o.timestamp;
      s.texts.push({ at: o.timestamp, text });
    }
    by.set(id, s);
  }
  return [...by.values()].filter((s) => s.prompts > 0)
    .map((s) => ({ ...s, folder: folderName(s.dir), first: new Date(s.first).toISOString(), last: new Date(s.last).toISOString(),
      texts: s.texts.sort((a, b) => a.at - b.at).map((t) => t.text) }))
    .sort((a, b) => b.last.localeCompare(a.last));
}

/**
 * The title Claude Code shows for a session, from (the end of) its transcript: the name the
 * user gave it (custom-title) wins over the generated one (ai-title); the last of each counts.
 * Null when there is none yet.
 */
export function titleFromTranscript(text) {
  let ai = null, custom = null;
  for (const line of String(text ?? "").split("\n")) {
    const isAi = line.includes('"type":"ai-title"'), isCustom = !isAi && line.includes('"type":"custom-title"');
    if (!isAi && !isCustom) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }   // the first line of a tail may be cut
    if (isAi && o.type === "ai-title" && typeof o.aiTitle === "string") ai = o.aiTitle;
    if (isCustom && o.type === "custom-title" && typeof o.customTitle === "string") custom = o.customTitle;
  }
  return clip(custom || ai, LIMITS.title) || null;
}

/**
 * Reads the end of a session's transcript for its title; null without a transcript or a title.
 * Remembered per file until it changes, so a session listed twice (running, and worked in
 * today) or on every page load costs one stat, not a half-megabyte read.
 */
const titles = new Map();   // transcript path → { size, mtimeMs, title }
export function readTitle(home, dir, id) {
  const file = path.join(home, "projects", projectSlug(dir), `${id}.jsonl`);
  let st; try { st = fs.statSync(file); } catch { return null; }
  const hit = titles.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.title;
  let fd, title = null;
  try {
    const want = Math.min(st.size, TAIL_BYTES);
    if (want) {
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, st.size - want);
      title = titleFromTranscript(buf.toString("utf8", 0, n));
    }
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  if (titles.size >= TITLE_CACHE_MAX) titles.delete(titles.keys().next().value);   // oldest entry out
  titles.set(file, { size: st.size, mtimeMs: st.mtimeMs, title });
  return title;
}

/**
 * Claude Code sessions for `date`: the ones running now (`live`, most recent activity first)
 * and the ones worked in that day (`day`, see sessionsFromHistory, each with its title and —
 * when still open — its live state). Problems reading the records are reported, never thrown.
 * @param {string} date  YYYY-MM-DD (local)
 * @param {{ home?: string, alive?: (pid: number) => boolean }} [o]
 * @returns {{ live: object[], day: object[], errors: string[] }}
 */
export function collectSessions(date, { home = claudeHome(), alive = pidAlive } = {}) {
  const errors = [], live = [];
  const registry = path.join(home, "sessions");
  let files = [];
  try { files = fs.readdirSync(registry).filter((f) => f.endsWith(".json")); }
  catch (e) { if (e.code !== "ENOENT") errors.push(`Claude sessions: ${e.message}`); }
  for (const f of files) {
    try { const s = parseLive(fs.readFileSync(path.join(registry, f), "utf8"), { alive }); if (s) live.push(s); }
    catch { /* a file being written or removed right now */ }
  }
  let day = [];
  try { day = sessionsFromHistory(fs.readFileSync(path.join(home, "history.jsonl"), "utf8"), date); }
  catch (e) { if (e.code !== "ENOENT") errors.push(`Claude sessions: ${e.message}`); }
  const open = new Map(live.map((s) => [s.id, s]));
  day = day.slice(0, LIMITS.sessions).map((s) => {
    const l = open.get(s.id);
    return { ...s, title: readTitle(home, s.dir, s.id) ?? clip(s.texts[0], LIMITS.title) ?? s.folder,
      live: l ? { pid: l.pid, status: l.status, startedAt: l.startedAt, lastActivityAt: l.lastActivityAt } : null };
  });
  for (const l of live) l.title = readTitle(home, l.dir, l.id);
  live.sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
  return { live, day, errors };
}

/** What a day's record keeps of its sessions: the lasting part — no prompt text, no live state (that is about now). */
export const compactSessions = (sessions) =>
  sessions.map(({ id, title, dir, folder, startedOn, first, last, prompts }) => ({ id, title, dir, folder, startedOn, first, last, prompts }));
/** The day's sessions as the API sends them: with their live state, without the prompt text. */
export const withoutPrompts = (sessions) => sessions.map(({ texts: _texts, ...rest }) => rest);

/** Activity lines (see activity.js) for the day's sessions: one per session, at its last prompt. */
export function sessionActivity(sessions) {
  return sessions.map((s) => ({
    at: s.last, kind: "claude", ref: s.title, id: s.id,
    text: `Claude Code session "${s.title}" in ${s.folder}: ${hhmm(s.first)}–${hhmm(s.last)}, ${plural(s.prompts, "prompt")}`,
  }));
}

/**
 * What the engineer asked Claude for in each session that day — prompt material for the summary,
 * clipped hard: at most the first two and the last six prompts, 140 characters each.
 */
export function sessionDetails(sessions) {
  return sessions.filter((s) => s.texts?.length).map((s) => {
    const t = s.texts, cut = t.length > LIMITS.prompts;
    const shown = cut ? [...t.slice(0, 2), ...t.slice(2 - LIMITS.prompts)] : t;
    return `### Claude Code session "${s.title}" (${s.folder}, ${hhmm(s.first)}–${hhmm(s.last)}, ${plural(s.prompts, "prompt")})\n` +
      `Your prompts that day${cut ? ` (the first 2 and the last ${LIMITS.prompts - 2} of ${t.length})` : ""}: ${shown.map((x) => JSON.stringify(x)).join(", ")}`;
  }).join("\n\n");
}
