// Daily progress files in the progress folder:
//   YYYY-MM-DD.md   — readable log
//   YYYY-MM-DD.json — snapshot of the data + notes (what the app reads back)
//
// A day holds two kinds of notes:
//   entries — today's log: [{ id, at, text }], appended with "Add" (page) or `dd add` (Claude)
//   notes   — one note per item: { "jira:KEY" | "pr:owner/repo#n" | "review:owner/repo#n" | "summary": text }
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { localDate } from "./dates.js";
import { readJson, writeFileAtomic } from "./fsutil.js";
import { doneOn } from "./score.js";

export { localDate };
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_KEY = /^(summary$|jira:|pr:|review:)/;
const MAX_TEXT = 20_000;
const NO_DONE = Object.freeze({ jira: [], prs: [], reviewed: [] });

const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : null);
const ago = (iso) => { const d = daysSince(iso); return d == null ? "?" : d === 0 ? "today" : d === 1 ? "1 day" : `${d} days`; };
const indent = (s) => s.trim().replace(/\r?\n/g, "\n    ");
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** Keeps only string notes with known key shapes and sane sizes (input comes from the browser or Claude). */
export function cleanNotes(notes) {
  return Object.fromEntries(Object.entries(notes ?? {}).filter(([k, v]) =>
    typeof v === "string" && k.length < 300 && v.length < MAX_TEXT && NOTE_KEY.test(k)));
}

/** Incoming keys replace stored ones, "" (or whitespace) deletes, keys not sent are kept. */
export function mergeNotes(stored, incoming) {
  const notes = { ...stored };
  for (const [k, v] of Object.entries(cleanNotes(incoming))) {
    if (v.trim()) notes[k] = v; else delete notes[k];
  }
  return notes;
}

export function toMarkdown(date, { notes = {}, entries = [] }, jira, github, done = NO_DONE) {
  const L = [`# Daily progress — ${date}`, ""];
  L.push("## Notes", "");
  if (notes.summary?.trim()) L.push(`- **Summary:** ${indent(notes.summary)}`);
  for (const e of entries) L.push(`- ${hhmm(e.at)} — ${indent(e.text)}`);
  if (!entries.length && !notes.summary?.trim()) L.push("_(none)_");
  L.push("");
  const finished = done.jira.length + done.prs.length + done.reviewed.length;
  if (finished) {
    L.push(`## Done today (${finished})`, "");
    for (const j of done.jira) L.push(`- [${j.key}](${j.url}) ${j.summary} — **${j.status}**`);
    for (const pr of done.prs) L.push(`- [${pr.repo}#${pr.number}](${pr.url}) ${pr.title} — **${pr.merged ? "merged" : "closed"}**`);
    for (const pr of done.reviewed) L.push(`- Reviewed [${pr.repo}#${pr.number}](${pr.url}) ${pr.title} — ${(pr.lastReviewState ?? "").toLowerCase().replace("_", " ")}`);
    L.push("");
  }
  const note = (key) => (notes[key] ? [`  - Note: ${indent(notes[key])}`] : []);
  L.push(`## Jira (${jira.length})`, "");
  for (const j of jira) {
    const dur = j.statusCategory === "In Progress" ? `in progress ${ago(j.statusCategoryChangedAt)}` : "not started";
    L.push(`- [${j.key}](${j.url}) ${j.summary} — **${j.status}**, ${dur}`, ...note(`jira:${j.key}`));
  }
  L.push("", `## My pull requests (${github.mine.length})`, "");
  for (const pr of github.mine) {
    L.push(`- [${pr.repo}#${pr.number}](${pr.url}) ${pr.title}`,
      `  - Pending: ${pr.pending.map((n) => n.text).join("; ") || "nothing"}`, ...note(`pr:${pr.repo}#${pr.number}`));
  }
  L.push("", `## Needs my review (${github.toReview.length})`, "");
  for (const pr of github.toReview)
    L.push(`- [${pr.repo}#${pr.number}](${pr.url}) ${pr.title} — by ${pr.author}, open ${ago(pr.createdAt)}`, ...note(`review:${pr.repo}#${pr.number}`));
  return L.join("\n") + "\n";
}

const dayPath = (dir, date, ext) => path.join(dir, `${date}.${ext}`);
const readDay = (dir, date) => readJson(dayPath(dir, date, "json"));

/**
 * Applies `change(day)` to the day's notes/entries and rewrites its .md/.json with the current
 * data snapshot. The snapshot keeps open items plus what was finished *that day*; the long
 * closed/reviewed lists stay out of the file.
 */
function updateDay(dir, date, jira, github, change, { jiraDone = [] } = {}) {
  const stored = readDay(dir, date) ?? {};
  const day = { notes: stored.notes ?? {}, entries: stored.entries ?? [] };
  change(day);
  const done = doneOn(date, { jiraDone, closed: github.closed, reviewed: github.reviewed });
  const snapshot = { login: github.login ?? null, mine: github.mine ?? [], toReview: github.toReview ?? [] };
  writeFileAtomic(dayPath(dir, date, "md"), toMarkdown(date, day, jira, snapshot, done));
  writeFileAtomic(dayPath(dir, date, "json"),
    JSON.stringify({ date, savedAt: new Date().toISOString(), notes: day.notes, entries: day.entries, jira, github: snapshot, done }, null, 2));
  return { date, files: [dayPath(dir, date, "md"), dayPath(dir, date, "json")], notes: day.notes, entries: day.entries };
}

/** Merges `incoming` item notes into the day's file. */
export function saveProgress(dir, incoming, jira, github, date = localDate(), extra) {
  return updateDay(dir, date, jira, github, (day) => { day.notes = mergeNotes(day.notes, incoming); }, extra);
}

/** Appends an entry to the day's log. */
export function addEntry(dir, text, jira, github, date = localDate(), extra) {
  if (typeof text !== "string" || !text.trim()) throw new Error("note text is empty");
  if (text.length > MAX_TEXT) throw new Error("note is too long");
  const entry = { id: randomUUID(), at: new Date().toISOString(), text: text.trim() };
  return { entry, ...updateDay(dir, date, jira, github, (day) => { day.entries.push(entry); }, extra) };
}

/** Removes an entry from the day's log by id. Touches no files when the id is unknown. */
export function removeEntry(dir, id, jira, github, date = localDate(), extra) {
  const existing = readDay(dir, date)?.entries ?? [];
  if (!existing.some((e) => e.id === id)) throw new Error("note not found");
  return updateDay(dir, date, jira, github, (day) => { day.entries = day.entries.filter((e) => e.id !== id); }, extra);
}

function dayFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => DAY_FILE.test(f)).sort(); } catch { return []; }
}

/** Today's notes/entries (to show and restore) and the latest earlier day's (shown as "previous"). */
export function loadProgress(dir, today = localDate()) {
  const files = dayFiles(dir);
  const todayDoc = files.includes(`${today}.json`) ? readDay(dir, today) : null;
  const prevFile = files.filter((f) => f < `${today}.json`).at(-1);
  const prev = prevFile ? readJson(path.join(dir, prevFile)) : null;
  return {
    today,
    todayNotes: todayDoc?.notes ?? null,
    todayEntries: todayDoc?.entries ?? [],
    previous: prev ? { date: prev.date ?? prevFile.slice(0, 10), notes: prev.notes ?? {}, entries: prev.entries ?? [] } : null,
  };
}

/** The last `days` saved days, newest first: notes, entries and counts (for the History page, standups, recaps). */
export function history(dir, days = 7) {
  return dayFiles(dir).reverse().slice(0, days).map((f) => {
    const d = readJson(path.join(dir, f));
    if (!d) return { date: f.slice(0, 10), error: "unreadable" };
    return {
      date: d.date ?? f.slice(0, 10), savedAt: d.savedAt, notes: d.notes ?? {}, entries: d.entries ?? [],
      done: { ...NO_DONE, ...(d.done ?? {}) },
      counts: { jira: d.jira?.length ?? 0, myPRs: d.github?.mine?.length ?? 0, toReview: d.github?.toReview?.length ?? 0,
        done: (d.done?.jira?.length ?? 0) + (d.done?.prs?.length ?? 0) + (d.done?.reviewed?.length ?? 0) },
    };
  });
}

/** One saved day in full (notes, entries and the data snapshot), or null. */
export function readDayFull(dir, date) {
  if (!DATE_RE.test(date)) throw new Error("bad date");
  const d = readDay(dir, date);
  return d && { date: d.date ?? date, savedAt: d.savedAt, notes: d.notes ?? {}, entries: d.entries ?? [],
    jira: d.jira ?? [], github: d.github ?? { mine: [], toReview: [] }, done: { ...NO_DONE, ...(d.done ?? {}) } };
}
