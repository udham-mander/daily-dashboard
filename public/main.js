// Daily Dashboard page. Talks only to this app's own API (see lib/server.js).
import { $, ago, api, dayOf, daysSince, describeKey, esc, icon, initTheme, longDate, pill, prLink, reviewPill, safeUrl, shortDate, since, store, timeOf, toast } from "./shared.js";

const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const ageLevel = (days, warn, bad) => (days >= bad ? "bad" : days >= warn ? "warn" : "info");

// ---------- state ----------
let DATA = null;
// Item notes edited in this browser but not saved yet. Only these are sent on Save; the server
// merges them into today's file, so notes added elsewhere (e.g. by Claude) are never overwritten.
let dirty = {};
const draftKey = () => `dd-drafts-${DATA?.today}`;

function loadDirty() {
  dirty = JSON.parse(store.get(draftKey()) ?? "{}");
  delete dirty.summary;   // the summary box was replaced by the notes log
  for (const k of store.keys()) if (k.startsWith("dd-drafts-") && k !== draftKey()) store.del(k);   // forget old days
}

// ---------- item notes ----------
const noteBox = (id) =>
  `<textarea class="note" rows="1" data-note="${esc(id)}" placeholder="Add a note…" aria-label="Note"></textarea><div class="prev" data-prev="${esc(id)}"></div>`;
const autosize = (el) => { el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; };
const noteEls = () => [...document.querySelectorAll("textarea[data-note]")];

function applyNotes(notes) {
  if (!notes) return;
  for (const el of noteEls()) if (notes[el.dataset.note] !== undefined) el.value = notes[el.dataset.note];
}

function showPreviousItemNotes() {
  const p = DATA.previous;
  for (const el of document.querySelectorAll("[data-prev]")) {
    const v = p?.notes[el.dataset.prev];
    el.innerHTML = v ? `<b>${esc(longDate(p.date, { month: "short", day: "numeric" }))}:</b> ${esc(v)}` : "";
  }
}

function updateSaveButton() {
  const n = Object.keys(dirty).length;
  $("saveBtn").innerHTML = `${icon("save")}<span>${n ? `Save notes (${n})` : "Save notes"}</span>`;
  for (const el of noteEls()) el.classList.toggle("dirty", el.dataset.note in dirty);
}

// ---------- today's notes (log) ----------
// One list, newest first: the user's own entries (time, deletable) and the automatic points
// (a small icon instead of a time; built from GitHub/Jira activity, never editable here).
function renderToday() {
  const entries = DATA.todayEntries ?? [];
  const notes = DATA.todayNotes ?? {};
  const auto = DATA.todayAuto;
  const autoPoints = auto?.points ?? [];
  const itemKeys = Object.keys(notes).filter((k) => k !== "summary");

  const rows = [
    ...entries.map((e) => ({ at: e.at, html: `<li class="entry"><time class="when" datetime="${esc(e.at)}">${esc(timeOf(e.at))}</time>
      <div class="text">${esc(e.text)}</div>
      <button class="icon-btn" data-del="${esc(e.id)}" title="Delete note" aria-label="Delete note">${icon("trash")}</button></li>` })),
    ...autoPoints.map((p) => ({ at: auto.updatedAt, html: `<li class="entry is-auto" title="Activity agent — written from your GitHub, Jira and Claude Code activity (${esc(timeOf(auto.updatedAt))})">
      <span class="when">${icon("bot", "i auto-ico")}<span class="visually-hidden">Activity agent</span></span><div class="text">${esc(p)}</div><span></span></li>` })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  $("entries").innerHTML =
    (notes.summary ? `<li class="entry"><span class="when">Summary</span><div class="text">${esc(notes.summary)}</div>
      <button class="icon-btn" data-del-summary title="Delete">${icon("trash")}</button></li>` : "") +
    rows.map((r) => r.html).join("") +
    (!rows.length && !notes.summary ? `<li class="empty">No notes yet today — click Add${DATA.autoStatus?.enabled ? ", or the Activity agent adds them on its own" : ""}.</li>` : "");

  // Problems building the automatic points: one muted line, only when there is one.
  const problem = auto?.errors?.length ? auto.errors.join(" · ") : DATA.autoStatus?.error;
  $("autoNote").hidden = !problem;
  $("autoNote").innerHTML = problem ? `${icon("alert")} ${esc(problem)}` : "";

  $("itemNotesToday").innerHTML = itemKeys.length
    ? `<h3>Notes on items</h3><ul class="item-notes">${itemKeys.map((k) => {
        const d = describeKey(k, DATA.jira, DATA.github);
        const label = d.url ? `<a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">${esc(d.label)}</a>` : esc(d.label);
        return `<li><span class="key">${label}</span>${d.title ? ` <span class="muted">${esc(d.title)}</span>` : ""}<div class="text">${esc(notes[k])}</div></li>`;
      }).join("")}</ul>` : "";

  const p = DATA.previous;
  const prevCount = p ? p.entries.length + (p.auto?.points?.length ?? 0) + Object.keys(p.notes).length : 0;
  $("prevDay").innerHTML = p
    ? `${icon("history")} ${esc(longDate(p.date))}: ${prevCount} note${prevCount === 1 ? "" : "s"} · <a href="/history?date=${esc(p.date)}">View previous days →</a>`
    : `${icon("history")} <a href="/history">View previous days →</a>`;

  const total = entries.length + autoPoints.length + itemKeys.length + (notes.summary ? 1 : 0);
  $("count-today").textContent = total;
  const hints = (entries.length ? pill("good", `last at ${timeOf(entries.at(-1).at)}`, true) : "") +
    (autoPoints.length ? pill("info", `${autoPoints.length} by the agent`) : "");
  $("hint-today").innerHTML = hints || pill("info", "none yet");
  renderAgentSwitch();
  renderAgent();
  renderTiles();
}

// ---------- the agent's take ----------
// Up to five things the Activity agent picked from the current state as worth attention today,
// with the keys and PR references it names linked to the real items.
function refLinks() {
  const map = new Map();
  for (const j of [...(DATA.jira ?? []), ...(DATA.jiraDone ?? [])]) map.set(j.key, j.url);
  for (const list of ["mine", "toReview", "closed", "reviewed"]) for (const pr of DATA.github?.[list] ?? []) map.set(`${pr.repo.split("/")[1]}#${pr.number}`, pr.url);
  return map;
}
function linkRefs(text, map) {
  return esc(text).replace(/\b([A-Z][A-Z0-9]+-\d+|[A-Za-z0-9_.-]+#\d+)\b/g, (m) =>
    map.has(m) ? `<a href="${esc(safeUrl(map.get(m)))}" target="_blank" rel="noopener">${m}</a>` : m);
}
// Each point has a cross: it goes, and what it names (or its wording) is blacklisted, so the
// agent stops bringing it up. The blacklist can be opened from the card and entries put back.
let showBlacklist = false;
const blacklistLabel = (e) => (e.refs?.length ? e.refs.join(", ") : `"${e.text.length > 70 ? `${e.text.slice(0, 70)}…` : e.text}"`);
function renderAgent() {
  const a = DATA.todayAuto, st = DATA.autoStatus ?? {};
  const takeOn = Boolean(st.enabled && st.nudges && st.useClaude);   // the take exists only with Claude and nudges on
  const nudges = takeOn ? (a?.nudges ?? []) : [];
  const black = takeOn && a ? (st.blacklist ?? []) : [];
  const card = $("agent");
  card.hidden = !nudges.length && !black.length;
  if (card.hidden) return;
  const map = refLinks();
  card.innerHTML = `<div class="head">${icon("bot")}Agent's take <span class="when">· ${esc(timeOf(a.updatedAt))}</span>
      ${black.length ? `<button class="bl" id="blacklistBtn" type="button" aria-expanded="${showBlacklist}" title="What you crossed off — the agent will not bring these up again. Click to see them and put any back.">${black.length} blacklisted</button>` : ""}</div>
    ${nudges.length
      ? `<ol>${nudges.map((n) => `<li><div class="row"><span class="text">${linkRefs(n, map)}</span>
          <button class="icon-btn x" type="button" data-dismiss="${esc(n)}" title="Not important: remove it and blacklist what it names, so the agent does not bring it up again" aria-label="Remove and blacklist">${icon("x")}</button></div></li>`).join("")}</ol>`
      : `<p class="none">Nothing on the list right now.</p>`}
    ${showBlacklist && black.length ? `<ul class="blacklist" aria-label="Blacklist">${[...black].reverse().map((e) => `<li class="chip" title="${esc(e.text)}"><span>${esc(blacklistLabel(e))}</span>
          <button class="icon-btn" type="button" data-restore="${esc(e.id)}" title="Take it off the blacklist${e.date === DATA.today && e.points?.length ? ` and put the point${e.points.length > 1 ? "s" : ""} back` : ""}" aria-label="Restore">${icon("x")}</button></li>`).join("")}</ul>` : ""}`;
}

async function dismissNudge(text) {
  try {
    const r = await api("/api/blacklist/add", { text });
    DATA.todayAuto = r.auto ?? DATA.todayAuto;
    DATA.autoStatus = r.autoStatus;
    renderAgent();
    // Undo only when this click added the entry; otherwise it would take an older entry off instead.
    if (r.added) toast(`Crossed off · ${blacklistLabel(r.entry)} blacklisted`, "check", { label: "Undo", run: () => restoreNudge(r.entry.id) });
    else toast(`Crossed off · ${blacklistLabel(r.entry)} was already blacklisted`);
  } catch (e) {
    toast(`Could not blacklist it: ${e.message}`, "alert");
  }
}
async function restoreNudge(id) {
  try {
    const r = await api("/api/blacklist/remove", { id });
    DATA.todayAuto = r.auto ?? DATA.todayAuto;
    DATA.autoStatus = r.autoStatus;
    renderAgent();
    toast(`${blacklistLabel(r.entry)} is off the blacklist`);
  } catch (e) {
    toast(`Could not restore it: ${e.message}`, "alert");
  }
}

// The Activity agent switch lives in the Today's notes header, where its entries appear.
// On/off at runtime, remembered in the config; off = nothing is written or saved on its own.
function renderAgentSwitch() {
  const st = DATA.autoStatus ?? { enabled: false };
  const on = Boolean(st.enabled);
  const every = st.intervalMinutes >= 60 ? `${+(st.intervalMinutes / 60).toFixed(1)} h` : `${st.intervalMinutes} min`;
  const btn = $("agentToggle");
  btn.setAttribute("aria-checked", String(on));
  btn.classList.toggle("on", on);
  btn.title = on
    ? `Activity agent is on: writes the automatic points every ${every} (${st.workHours})${st.saveAt ? `, saves the day at ${st.saveAt}` : ""}, gives its take. Click to turn it off.`
    : "Activity agent is off: nothing is written or saved on its own (your own notes still work). Click to turn it on.";
  btn.innerHTML = `${icon("bot")}<span class="track" aria-hidden="true"></span><span class="state">Activity agent · ${on ? "On" : "Off"}</span>`;
}

async function setAgent(enabled) {
  try {
    const r = await api("/api/agent", { enabled });
    DATA.autoStatus = r.autoStatus;
    toast(enabled ? "Activity agent on" : "Activity agent off");
  } catch (e) {
    toast(`Could not change the agent: ${e.message}`, "alert");
  }
  renderAgentSwitch();
  renderAgent();
  renderToday();
}

// The text box is shown only on demand (Add button, the N key, or the tile) and closed again
// after a note is added; a draft typed earlier is kept in the browser.
function openComposer() {
  $("sec-today").open = true;
  $("composer").hidden = false;
  $("newBtn").hidden = true;
  const box = $("entryText");
  autosize(box);
  box.focus({ preventScroll: false });
}
function closeComposer() {
  $("composer").hidden = true;
  $("newBtn").hidden = false;
}

async function addEntry(e) {
  e?.preventDefault();
  const box = $("entryText");
  const text = box.value.trim();
  if (!text) { box.focus(); return; }
  $("addBtn").disabled = true;
  try {
    const r = await api("/api/entries", { text });
    Object.assign(DATA, { todayEntries: r.entries, todayNotes: r.notes });
    box.value = ""; autosize(box);
    store.del(`dd-entry-draft`);
    renderToday();
    closeComposer();
    toast("Note added");
  } catch (err) {
    toast(`Could not add the note: ${err.message}`, "alert");
    box.focus();
  } finally {
    $("addBtn").disabled = false;
  }
}

async function deleteEntry(id) {
  try {
    const r = id === "summary" ? await api("/api/save", { notes: { summary: "" } }) : await api("/api/entries/delete", { id });
    Object.assign(DATA, { todayEntries: r.entries, todayNotes: r.notes });
    renderToday();
    toast("Note deleted");
  } catch (err) { toast(`Could not delete: ${err.message}`, "alert"); }
}

// ---------- rendering ----------
const section = (title, count, hint, body) =>
  `<summary><span class="chev" aria-hidden="true"></span><h2>${esc(title)} <span class="count">${count}</span></h2>` +
  `<span class="hint">${hint}</span></summary><div class="body">${body}</div>`;
const skeleton = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';

function tile(id, iconName, label, value, detail = "", level = "") {
  $(id).innerHTML = `<span class="label">${icon(iconName)}${esc(label)}</span>` +
    `<div class="value">${value}</div><div class="detail ${level}">${detail}</div>`;
}

function renderTiles() {
  if (!DATA) return;
  const { github: gh, jira, jiraStatus: js } = DATA;
  const inProg = jira.filter((j) => j.statusCategory === "In Progress");
  const stale = inProg.filter((j) => daysSince(j.statusCategoryChangedAt) >= 14).length;
  tile("tile-jira", "jira", "Jira in progress", js.running && !jira.length ? "…" : inProg.length,
    stale ? `${stale} for 14+ days` : `${jira.length} open in total`, stale ? "bad" : "");

  const blocked = gh.mine.filter((pr) => pr.pending.some((n) => n.level === "bad")).length;
  const ready = gh.mine.filter((pr) => pr.pending.some((n) => n.text === "Ready to merge")).length;
  tile("tile-mine", "pr", "My pull requests", gh.mine.length,
    blocked ? `${blocked} blocked` : ready ? `${ready} ready to merge` : gh.mine.some((p) => p.draft) ? "draft in progress" : "",
    blocked ? "bad" : ready ? "good" : "");

  const oldest = gh.toReview.reduce((m, pr) => Math.max(m, daysSince(pr.createdAt) ?? 0), 0);
  tile("tile-review", "eye", "Needs my review", gh.toReview.length,
    gh.toReview.length ? `oldest waiting ${oldest} day${oldest === 1 ? "" : "s"}` : "all clear",
    !gh.toReview.length ? "good" : oldest >= 7 ? "bad" : oldest >= 3 ? "warn" : "");

  const entries = DATA.todayEntries ?? [];
  const unsaved = Object.keys(dirty).length;
  tile("tile-today", "pen", "Today's notes", entries.length + Object.keys(DATA.todayNotes ?? {}).length,
    unsaved ? `${unsaved} unsaved on items` : entries.length ? `last at ${timeOf(entries.at(-1).at)}` : "none yet",
    unsaved ? "warn" : "");

  const ss = DATA.sessions;
  $("tile-claude").hidden = !ss;
  if (ss) {
    const busy = ss.live.filter((s) => s.status === "busy").length;
    tile("tile-claude", "terminal", "Claude sessions", ss.today.length,
      ss.live.length ? `${ss.live.length} running${busy ? ` · ${busy} busy` : ""}` : ss.today.length ? "none running now" : "none today",
      ss.live.length ? "good" : "");
  }

  const [week, last] = DATA.score?.weeks ?? [];
  if (week) tile("tile-week", "trophy", "Done this week", week.total,
    `${week.jiraDone} Jira · ${week.prsMerged} merged · ${week.prsReviewed} reviewed`,
    last && week.total > last.total ? "good" : "");
}

function render() {
  const { github: gh, jira, jiraStatus: js } = DATA;
  const open = Object.fromEntries([...document.querySelectorAll("details.sec")].map((d) => [d.id, d.open]));

  $("meta").textContent = longDate(DATA.today) + (gh.login ? ` · @${gh.login}` : "");
  $("status").innerHTML =
    `GitHub ${since(DATA.githubFetchedAt)} · Jira ${js.running ? `${icon("refresh", "i spin")} refreshing via ${esc(js.source)}…` : since(js.fetchedAt)}` +
    ` · saving to <code>${esc(DATA.progressDir)}</code>`;
  $("banners").innerHTML =
    (DATA.githubError ? `<div class="banner bad">${icon("alert")}GitHub: ${esc(DATA.githubError)}</div>` : "") +
    (js.error ? (js.configured === false
      ? `<div class="banner warn">${icon("alert")}${esc(js.error)}</div>`
      : `<div class="banner bad">${icon("alert")}Jira refresh failed${jira.length ? " — showing the last good data" : ""}. ${esc(js.error)}</div>`) : "");

  const prsByKey = {};
  for (const pr of gh.mine) for (const k of new Set(`${pr.title} ${pr.branch}`.match(KEY_RE) ?? [])) (prsByKey[k] ??= []).push(pr);

  // My Jira
  const order = { "In Progress": 0, "To Do": 1 };
  const issues = jira.toSorted((a, b) => (order[a.statusCategory] ?? 2) - (order[b.statusCategory] ?? 2) || a.key.localeCompare(b.key));
  const inProg = issues.filter((j) => j.statusCategory === "In Progress");
  const stale = inProg.filter((j) => daysSince(j.statusCategoryChangedAt) >= 14).length;
  $("sec-jira").innerHTML = section("My Jira", issues.length,
    (inProg.length ? pill("info", `${inProg.length} in progress`) : "") + (stale ? pill("bad", `${stale} for 14+ days`, true) : ""),
    issues.length ? issues.map((j) => {
      const d = daysSince(j.statusCategoryChangedAt);
      const dur = j.statusCategory === "In Progress"
        ? pill(d >= 14 ? "bad" : d >= 7 ? "warn" : "good", `in progress ${ago(j.statusCategoryChangedAt)}`, true)
        : pill("info", `not started · created ${ago(j.created)} ago`);
      const prs = prsByKey[j.key]?.map((pr) => prLink(pr, "")).join(", ");
      return `<div class="item"><div class="row">
        <a class="key" href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener">${esc(j.key)}</a>
        <span class="title">${esc(j.summary)}</span>${pill("info", j.status)}${dur}</div>
        <div class="sub">${esc(j.type)} · ${esc(j.priority)} priority · updated ${ago(j.updated)} ago${prs ? ` · PRs: ${prs}` : ""}</div>
        ${noteBox(`jira:${j.key}`)}</div>`;
    }).join("") : js.running ? skeleton : '<p class="empty">No open Jira issues assigned to you.</p>');

  // My pull requests
  const blocked = gh.mine.filter((pr) => pr.pending.some((n) => n.level === "bad")).length;
  const ready = gh.mine.filter((pr) => pr.pending.some((n) => n.text === "Ready to merge")).length;
  const drafts = gh.mine.filter((pr) => pr.draft).length;
  $("sec-mine").innerHTML = section("My pull requests", gh.mine.length,
    (blocked ? pill("bad", `${blocked} blocked`, true) : "") + (ready ? pill("good", `${ready} ready to merge`, true) : "") +
    (drafts ? pill("info", `${drafts} draft`) : ""),
    gh.mine.length ? gh.mine.map((pr) => `<div class="item"><div class="row">
        ${prLink(pr)}
        <span class="title">${esc(pr.title)}</span>${pill("info", `open ${ago(pr.createdAt)}`)}</div>
        <div class="chips">${pr.pending.map((n) => pill(n.level, n.text, true)).join("")}</div>
        <div class="sub">${esc(pr.branch)} → ${esc(pr.base)} · updated ${ago(pr.updatedAt)} ago</div>
        ${noteBox(`pr:${pr.repo}#${pr.number}`)}</div>`).join("") : '<p class="empty">No open pull requests.</p>');

  // Needs my review — last, oldest first
  const reviews = gh.toReview.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const oldest = reviews.length ? daysSince(reviews[0].createdAt) : 0;
  $("sec-review").innerHTML = section("Needs my review", reviews.length,
    reviews.length ? pill(ageLevel(oldest, 3, 7), `oldest open ${ago(reviews[0].createdAt)}`, true) : "",
    reviews.length ? reviews.map((pr) => `<div class="item"><div class="row">
        ${prLink(pr)}
        <span class="title">${esc(pr.title)}</span>${pr.draft ? pill("info", "draft") : ""}
        ${pill(ageLevel(daysSince(pr.createdAt), 3, 7), `open ${ago(pr.createdAt)}`, true)}</div>
        <div class="sub">by ${esc(pr.author)} · updated ${ago(pr.updatedAt)} ago</div>
        ${noteBox(`review:${pr.repo}#${pr.number}`)}</div>`).join("") : '<p class="empty">Nothing waiting on you. 🎉</p>');

  renderClaude();
  renderDone();

  for (const d of document.querySelectorAll("details.sec")) if (d.id in open) d.open = open[d.id];
  applyNotes(DATA.todayNotes);   // saved today (by the page or by Claude)
  applyNotes(dirty);             // unsaved edits in this browser win
  showPreviousItemNotes();
  noteEls().forEach(autosize);
  updateSaveButton();
  renderToday();
}

// Claude sessions: the Claude Code sessions worked in today (from Claude Code's own prompt
// history: title, folder, first and last prompt, how many) and the ones running right now.
// A closed one can be resumed in its folder (claude --resume); a running one shows its state.
const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function renderClaude() {
  const ss = DATA.sessions;
  const sec = $("sec-claude");
  sec.hidden = !ss;
  if (!ss) return;
  const rows = [...ss.today];
  // Running sessions without a prompt today (started yesterday, or idle since) are listed too.
  const seen = new Set(rows.map((s) => s.id));
  for (const l of ss.live) if (!seen.has(l.id))
    rows.push({ id: l.id, title: l.title ?? l.name ?? l.folder, dir: l.dir, folder: l.folder, startedOn: l.startedAt ? localDay(l.startedAt) : null, first: null, last: null, prompts: 0, live: l });
  const busy = ss.live.filter((s) => s.status === "busy").length;
  const state = (s) => !s.live ? pill("info", "closed")
    : s.live.status === "busy" ? pill("warn", "busy", true) : s.live.status === "idle" ? pill("good", "idle", true) : pill("good", "running", true);
  sec.innerHTML = section("Claude sessions", ss.today.length,
    (ss.live.length ? pill("good", `${ss.live.length} running`, true) : "") + (busy ? pill("warn", `${busy} busy`) : "") +
    (ss.errors?.length ? pill("bad", "some records unreadable") : ""),
    rows.length ? rows.map((s) => `<div class="item"><div class="row">
        <span class="key">${icon("terminal")}${esc(s.folder)}</span>
        <span class="title">${esc(s.title)}</span>${state(s)}
        ${s.prompts ? pill("info", `${timeOf(s.first)} – ${timeOf(s.last)} · ${s.prompts} prompt${s.prompts === 1 ? "" : "s"}`) : pill("info", "no prompts today")}
        ${s.live ? "" : `<button class="btn small resume" type="button" data-resume="${esc(s.id)}" data-dir="${esc(s.dir)}" title="Open a terminal in ${esc(s.dir)} and resume this session (claude --resume)">${icon("terminal")}<span>Resume</span></button>`}</div>
        <div class="sub">${esc(s.dir)}${s.startedOn && s.startedOn !== DATA.today ? ` · since ${esc(shortDate(s.startedOn))}` : ""}${s.live?.lastActivityAt ? ` · last activity ${esc(since(s.live.lastActivityAt))}` : ""} · <code>${esc(s.id.slice(0, 8))}</code></div></div>`).join("")
    : '<p class="empty">No Claude Code sessions today.</p>');
}

// Done & score: the weekly table ("our score"), then what was finished — Jira issues moved to
// Done, my merged/closed PRs, and PRs I reviewed — over the same weeks.
function renderDone() {
  const sc = DATA.score ?? { weeks: [], totals: {} };
  const jiraDone = DATA.jiraDone ?? [];
  const closed = DATA.github.closed ?? [];
  const reviewed = DATA.github.reviewed ?? [];
  const [week] = sc.weeks;
  const td = (n) => `<td class="${n ? "" : "zero"}">${n}</td>`;
  const label = (w, i) => `${i === 0 ? "This week" : i === 1 ? "Last week" : shortDate(w.start)}` +
    `<span class="range">${i < 2 ? `${shortDate(w.start)} – ${shortDate(w.end)}` : `– ${shortDate(w.end)}`}</span>`;
  const list = (title, items, row) =>
    `<h3>${esc(title)} (${items.length})</h3>` + (items.length
      ? `<div class="done-list">${items.map((it) => `<div class="item"><div class="row">${row(it)}</div></div>`).join("")}</div>`
      : '<p class="empty">None in this period.</p>');

  const table = sc.weeks.length ? `<table class="score">
    <thead><tr><th>Week</th><th>Jira done</th><th>PRs merged</th><th>PRs reviewed</th><th>Total</th></tr></thead>
    <tbody>${sc.weeks.map((w, i) => `<tr class="${i === 0 ? "now" : ""}"><td>${label(w, i)}</td>${td(w.jiraDone)}${td(w.prsMerged)}${td(w.prsReviewed)}${td(w.total)}</tr>`).join("")}</tbody>
    <tfoot><tr><td>${sc.weeks.length} weeks</td>${td(sc.totals.jiraDone)}${td(sc.totals.prsMerged)}${td(sc.totals.prsReviewed)}${td(sc.totals.total)}</tr></tfoot>
  </table>` : "";

  $("sec-done").innerHTML = section("Done & score", sc.totals.total ?? 0,
    week ? pill(week.total ? "good" : "info", `this week: ${week.jiraDone} Jira · ${week.prsMerged} merged · ${week.prsReviewed} reviewed`, Boolean(week.total)) : "",
    table +
    list("Jira done", jiraDone, (j) =>
      `<a class="key" href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener">${esc(j.key)}</a><span class="title">${esc(j.summary)}</span>` +
      `${pill("info", j.status)}${pill("good", `done ${dayOf(j.doneAt)}`, true)}`) +
    list("My pull requests merged or closed", closed, (pr) =>
      `${prLink(pr)}<span class="title">${esc(pr.title)}</span>${pr.merged ? pill("good", `merged ${dayOf(pr.closedAt)}`, true) : pill("info", `closed ${dayOf(pr.closedAt)}`)}`) +
    list("Reviewed by me", reviewed, (pr) =>
      `${prLink(pr)}<span class="title">${esc(pr.title)} <span class="muted">by ${esc(pr.author)}</span></span>` +
      `${reviewPill(pr.lastReviewState)}${pill("info", `${pr.reviews.length > 1 ? `${pr.reviews.length} rounds · ` : ""}last ${dayOf(pr.lastReviewAt)}`)}`));
}

// ---------- launch Claude ----------
// A split button: the main part opens a new Claude Code session in the default folder, the
// caret offers the default, the 5 most recent folders, and a box for any other folder.
const baseName = (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

function renderLaunchMenu() {
  const c = DATA?.claude;
  const item = (dir, tag) => `<button class="menu-item" data-dir="${esc(dir)}" role="menuitem">${icon("terminal")}<b>${esc(baseName(dir))}</b>` +
    `<span class="path">${esc(dir)}</span>${tag ? `<span class="tag">${esc(tag)}</span>` : ""}</button>`;
  $("launchMenu").innerHTML = !c ? '<p class="empty small">Launching is not available.</p>'
    : `<h5>New Claude session in…</h5>${item(c.defaultDir, "default")}` +
      (c.recent.length ? `<h5>Recent</h5>${c.recent.map((d) => item(d)).join("")}` : "") +
      `<form class="menu-form" id="launchForm"><label class="visually-hidden" for="launchDir">Other folder</label>` +
      `<input id="launchDir" placeholder="Other folder, e.g. C:\\Workspace\\my-repo" autocomplete="off" spellcheck="false">` +
      `<button class="btn small primary" type="submit">Open</button></form>`;
}

function toggleLaunchMenu(open = $("launchMenu").hidden) {
  if (open) renderLaunchMenu();
  $("launchMenu").hidden = !open;
  $("launchMenuBtn").setAttribute("aria-expanded", String(open));
  if (open) $("launchDir")?.focus();
}

let launching = false;   // one launch at a time, whether it came from the button, the menu, the L key or a Resume button
async function launchClaude(dir, resume) {
  toggleLaunchMenu(false);
  if (launching) return;
  launching = true;
  const btn = $("launchBtn");
  btn.disabled = true;
  try {
    const r = await api("/api/launch", { ...(dir ? { dir } : {}), ...(resume ? { resume } : {}) });
    if (DATA) DATA.claude = { ...DATA.claude, defaultDir: r.defaultDir, recent: r.recent };
    toast(resume ? `Resuming the Claude session in ${r.dir}` : `Claude is starting in ${r.dir}`);
  } catch (e) {
    toast(`Could not launch Claude: ${e.message}`, "alert");
  } finally {
    launching = false;
    btn.disabled = false;
  }
}

// ---------- data ----------
let polling = null;
let renderPending = false;
// A full render replaces the item note boxes; never do that while one has focus.
const typingInNote = () => document.activeElement?.matches?.("textarea[data-note]");
function renderWhenIdle() {
  if (typingInNote()) { renderPending = true; renderTiles(); return; }
  renderPending = false;
  render();
}
document.addEventListener("focusout", () => { if (renderPending) setTimeout(() => { if (renderPending && !typingInNote()) renderWhenIdle(); }, 0); });

async function load({ refresh = false } = {}) {
  setRefreshBusy(true);
  try {
    // A refresh runs Claude for Jira, so it is a POST (writes need our origin + header).
    DATA = refresh ? await api("/api/refresh", {}) : await api("/api/data");
    loadDirty();
    renderWhenIdle();
    if (DATA.jiraStatus.running) pollJira();
  } catch (e) {
    toast(`Could not load data: ${e.message}`, "alert");
  } finally {
    setRefreshBusy(false);
  }
}

// Jira via Claude takes ~20 s: poll its status, then reload once it finishes.
function pollJira() {
  if (polling) return;
  polling = setInterval(async () => {
    try {
      const { jiraStatus } = await api("/api/status");
      if (jiraStatus.running) return;
      clearInterval(polling); polling = null;
      load();
    } catch { clearInterval(polling); polling = null; }
  }, 4000);
}

function setRefreshBusy(busy) {
  const btn = $("refreshBtn");
  btn.disabled = busy;
  btn.innerHTML = `${icon("refresh", busy ? "i spin" : "i")}<span>Refresh</span>`;
}

async function saveItemNotes() {
  if (!Object.keys(dirty).length) { toast("No unsaved notes on items"); return; }
  $("saveBtn").disabled = true;
  try {
    const r = await api("/api/save", { notes: dirty });
    dirty = {};
    store.del(draftKey());
    Object.assign(DATA, { todayNotes: r.notes, todayEntries: r.entries });
    // Show the merged result — includes notes saved elsewhere (e.g. by Claude) since load.
    for (const el of noteEls()) { el.value = r.notes[el.dataset.note] ?? ""; autosize(el); }
    updateSaveButton();
    renderToday();
    toast(`Saved to ${r.date}.md`);
  } catch (e) {
    toast(`Save failed: ${e.message}`, "alert");
  } finally {
    $("saveBtn").disabled = false;
  }
}

async function quit() {
  if (Object.keys(dirty).length) await saveItemNotes();
  try { await api("/api/quit", {}); } catch {}
  document.body.innerHTML = `<main><div class="banner">${icon("power")}Daily Dashboard stopped. Start it again from the desktop icon.</div></main>`;
}

// ---------- wiring ----------
$("historyLink").innerHTML = `${icon("history")}<span>History</span>`;
$("addBtn").innerHTML = `${icon("plus")}<span>Add</span>`;
$("newBtn").innerHTML = `${icon("plus")}<span>Add</span>`;
// The Add button sits in the section header: it must not toggle the section.
$("newBtn").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openComposer(); });
$("cancelBtn").addEventListener("click", closeComposer);
$("quitBtn").innerHTML = `${icon("power")}<span>Quit</span>`;
$("refreshBtn").addEventListener("click", () => load({ refresh: true }));
$("launchBtn").innerHTML = `${icon("terminal")}<span>Launch Claude</span>`;
$("launchMenuBtn").innerHTML = icon("chevron");
$("launchBtn").addEventListener("click", () => launchClaude());
$("launchMenuBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleLaunchMenu(); });
$("launchMenu").addEventListener("click", (e) => { e.stopPropagation(); const b = e.target.closest(".menu-item"); if (b) launchClaude(b.dataset.dir); });
$("launchMenu").addEventListener("submit", (e) => { e.preventDefault(); const v = $("launchDir").value.trim(); if (v) launchClaude(v); });
document.addEventListener("click", () => { if (!$("launchMenu").hidden) toggleLaunchMenu(false); });
$("saveBtn").addEventListener("click", saveItemNotes);
$("quitBtn").addEventListener("click", quit);
$("composer").addEventListener("submit", addEntry);
initTheme($("themeSel"));

// Typing a new note: keep a draft, grow the box, Ctrl+Enter adds it.
$("entryText").value = store.get("dd-entry-draft") ?? "";
$("entryText").addEventListener("input", (e) => { store.set("dd-entry-draft", e.target.value); autosize(e.target); });
$("entryText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) addEntry(e);
  else if (e.key === "Escape") { e.preventDefault(); closeComposer(); $("newBtn").focus(); }
});

$("entries").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (btn?.dataset.del) deleteEntry(btn.dataset.del);
  else if (btn?.hasAttribute("data-del-summary")) deleteEntry("summary");
});
// In the section header: it must not toggle the section.
$("agentToggle").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setAgent(e.currentTarget.getAttribute("aria-checked") !== "true"); });
// The agent's take: cross a point off, open the blacklist, put an entry back.
$("agent").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.id === "blacklistBtn") { showBlacklist = !showBlacklist; renderAgent(); }
  else if (btn.dataset.dismiss !== undefined) { btn.disabled = true; dismissNudge(btn.dataset.dismiss); }
  else if (btn.dataset.restore) { btn.disabled = true; restoreNudge(btn.dataset.restore); }
});
// Claude sessions: resume a closed one in the folder it ran in.
$("sec-claude").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-resume]");
  if (btn) launchClaude(btn.dataset.dir, btn.dataset.resume);
});

// Item note boxes: track unsaved edits ("" is kept: it deletes that note on Save).
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.matches?.("textarea[data-note]") || !DATA) return;
  dirty[el.dataset.note] = el.value;
  store.set(draftKey(), JSON.stringify(dirty));
  autosize(el);
  updateSaveButton();
  renderTiles();
});

const sections = () => document.querySelectorAll("details.sec");
$("expandAll").addEventListener("click", () => sections().forEach((d) => (d.open = true)));
$("collapseAll").addEventListener("click", () => sections().forEach((d) => (d.open = false)));
// Note boxes in a closed section have no height until it opens.
document.addEventListener("toggle", (e) => { if (e.target.open) e.target.querySelectorAll(".note").forEach(autosize); }, true);

for (const t of document.querySelectorAll(".tile")) {
  t.addEventListener("click", () => {
    const sec = $(t.dataset.target);
    sec.open = true;
    sec.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveItemNotes(); return; }
  if (e.key === "Escape" && !$("launchMenu").hidden) { toggleLaunchMenu(false); $("launchMenuBtn").focus(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return;
  const key = e.key.toLowerCase();
  if (key === "r") load({ refresh: true });
  else if (key === "l") launchClaude();
  else if (key === "e") $("expandAll").click();
  else if (key === "c") $("collapseAll").click();
  else if (key === "h") location.href = "/history";
  else if (key === "n") { e.preventDefault(); openComposer(); }
});

setRefreshBusy(false);
updateSaveButton();
load();
