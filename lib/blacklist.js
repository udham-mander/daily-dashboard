// The agent's blacklist: what the user crossed off the take as not important. A crossed-off
// nudge blacklists the items it names (Jira keys, repo#n); one that names nothing blacklists its
// wording. Later takes are filtered against it and the prompt lists it, so the agent stops
// bringing those up. Kept in ~/.daily-dashboard/blacklist.json; a hand edit counts without a
// restart (the file is re-read when its mtime changes).
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { readJson, writeFileAtomic } from "./fsutil.js";

export const MAX_ENTRIES = 200;
export const MAX_TEXT = 300;
const HINTS = 12;
// The shapes the page links (linkRefs in public/main.js uses the same expression — keep them in
// step): ABC-123, repo#12. Any upper-case TOKEN-123 counts as a key, so a nudge that happens to
// say SHA-256 blacklists "SHA-256" too; the entry is visible on the page and can be put back.
const REF_RE = /\b([A-Z][A-Z0-9]+-\d+|[A-Za-z0-9_.-]+#\d+)\b/g;

/** Item references in a text, normalized: Jira keys as written, PRs as repo#n in lower case (an owner/ prefix is dropped). */
export function refsIn(text) {
  return [...new Set((String(text ?? "").match(REF_RE) ?? []).map((r) => (r.includes("#") ? r.toLowerCase() : r)))];
}

/** Wording compared without case, punctuation or extra spaces. */
export const normText = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}#]+/gu, " ").trim();

/**
 * A new entry for a crossed-off nudge: what it names (or its wording), and the points it took
 * out of that day's take (`points`: `{ index, text }`, the clicked one and any sibling naming the
 * same item), so an undo can put them back.
 */
export function entryFor(text, { date = null, points = [], now = new Date() } = {}) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  if (!clean) throw new Error("nothing to blacklist");
  return { id: randomUUID(), refs: refsIn(clean), text: clean, date, points, at: now.toISOString() };
}

/** Does a nudge fall under an entry: it names a blacklisted item, or (an entry naming nothing) reads the same. */
export function matches(entry, nudge) {
  if (entry.refs.length) { const refs = refsIn(nudge); return entry.refs.some((r) => refs.includes(r)); }
  return normText(entry.text) === normText(nudge);
}

/** The nudges not covered by any entry. */
export const filterNudges = (nudges, entries) => nudges.filter((n) => !entries.some((e) => matches(e, n)));

/** What an entry stands for: "dbms#11, MAYA-26", or the wording in quotes. */
export const labelOf = (e) => (e.refs.length ? e.refs.join(", ") : `"${e.text}"`);

const valid = (e) => e && typeof e === "object" && typeof e.id === "string" && (Array.isArray(e.refs) || typeof e.text === "string");
const normalize = (e) => ({
  id: e.id, refs: Array.isArray(e.refs) ? e.refs.filter((r) => typeof r === "string") : refsIn(e.text), text: typeof e.text === "string" ? e.text.slice(0, MAX_TEXT) : "",
  date: typeof e.date === "string" ? e.date : null,
  points: Array.isArray(e.points) ? e.points.filter((p) => p && Number.isInteger(p.index) && typeof p.text === "string") : [],
  at: typeof e.at === "string" ? e.at : null,
});

/**
 * The persistent blacklist.
 * @param {string} file  JSON file: `{ "entries": [{ id, refs[], text, date, points[], at }] }`
 */
export function createBlacklist(file) {
  const cache = { mtimeMs: null, entries: [] };
  const mtime = () => { try { return fs.statSync(file).mtimeMs; } catch { return -1; } };   // -1: no file
  const load = () => {
    const m = mtime();
    if (m !== cache.mtimeMs) {
      const v = m < 0 ? null : readJson(file, null);
      cache.entries = Array.isArray(v?.entries) ? v.entries.filter(valid).map(normalize) : [];
      cache.mtimeMs = m;
    }
    return cache.entries;
  };
  const save = (entries) => {
    const kept = entries.slice(-MAX_ENTRIES);
    writeFileAtomic(file, JSON.stringify({ entries: kept }, null, 2));
    cache.entries = kept;
    cache.mtimeMs = mtime();
  };
  return {
    /** Oldest first. */
    list: () => load(),
    /**
     * Blacklists a nudge: `{ entry, added }`. Nothing is added when the list already covers it —
     * every item it names is listed, or (naming none) an entry reads the same — and that entry
     * comes back instead. Naming one new item among known ones still adds it.
     */
    add(text, where = {}) {
      const entries = load();
      const entry = entryFor(text, where);
      const known = new Set(entries.flatMap((e) => e.refs));
      const covered = entry.refs.length
        ? (entry.refs.every((r) => known.has(r)) ? entries.find((e) => e.refs.includes(entry.refs[0])) : null)
        : entries.find((e) => matches(e, entry.text));
      if (covered) return { entry: covered, added: false };
      save([...entries, entry]);
      return { entry, added: true };
    },
    /** Takes an entry off; null when the id is unknown. */
    remove(id) {
      const entries = load();
      const entry = entries.find((e) => e.id === id) ?? null;
      if (entry) save(entries.filter((e) => e !== entry));
      return entry;
    },
    /** Takes off every entry that covers `text` (an item like dbms#11, or a wording); returns them, oldest first. */
    removeMatching(text) {
      const entries = load();
      const gone = entries.filter((e) => matches(e, text));
      if (gone.length) save(entries.filter((e) => !gone.includes(e)));
      return gone;
    },
    filter: (nudges) => filterNudges(nudges, load()),
    /** The most recent entries as short labels, for the prompt. */
    hints: () => load().slice(-HINTS).map(labelOf),
  };
}
