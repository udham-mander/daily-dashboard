// History page: every saved day, newest first, with its notes and the data snapshot.
import { $, api, describeKey, esc, icon, initTheme, longDate, pill, prLink, reviewPill, safeUrl, timeOf, toast } from "./shared.js";

let DAYS = [];          // from /api/history (notes + entries + counts per day)
let selected = null;    // date string
const cache = new Map(); // date -> full day from /api/day

const noteCount = (d) => (d.entries?.length ?? 0) + (d.auto?.points?.length ?? 0) + Object.keys(d.notes ?? {}).length;
const text = (d) => [...(d.entries ?? []).map((e) => e.text), ...(d.auto?.points ?? []), ...Object.values(d.notes ?? {})].join("\n").toLowerCase();

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const shown = q ? DAYS.filter((d) => text(d).includes(q)) : DAYS;
  $("days").innerHTML = shown.length ? shown.map((d) => {
    const n = noteCount(d);
    const first = d.entries?.[0]?.text ?? d.auto?.points?.[0] ?? d.notes?.summary ?? Object.values(d.notes ?? {})[0] ?? "";
    return `<li><button class="day${d.date === selected ? " active" : ""}" data-date="${esc(d.date)}">
      <span class="day-date">${esc(longDate(d.date, { weekday: "short", month: "short", day: "numeric" }))}</span>
      <span class="day-count">${n}</span>
      <span class="day-preview">${esc(first.split("\n")[0] || "No notes")}</span></button></li>`;
  }).join("") : `<li class="empty">${q ? "No days match your search." : "Nothing saved yet."}</li>`;
}

// One list like the dashboard's: the user's entries with their time, the automatic points
// (GitHub/Jira/Claude Code activity) with a small icon, newest first.
function notesBlock(day) {
  const entries = day.entries ?? [];
  const auto = day.auto;
  const summary = day.notes?.summary;
  const rows = [
    ...entries.map((e) => ({ at: e.at, html: `<li class="entry"><time class="when" datetime="${esc(e.at)}">${esc(timeOf(e.at))}</time><div class="text">${esc(e.text)}</div></li>` })),
    ...(auto?.points ?? []).map((p) => ({ at: auto.updatedAt, html: `<li class="entry is-auto" title="Activity agent — written from GitHub, Jira and Claude Code activity (${esc(timeOf(auto.updatedAt))})">
      <span class="when">${icon("bot", "i auto-ico")}<span class="visually-hidden">Activity agent</span></span><div class="text">${esc(p)}</div></li>` })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (!rows.length && !summary) return '<p class="empty">No notes logged this day.</p>';
  return `<ol class="entries">` +
    (summary ? `<li class="entry"><span class="when">Summary</span><div class="text">${esc(summary)}</div></li>` : "") +
    rows.map((r) => r.html).join("") + `</ol>` +
    (auto?.nudges?.length ? `<h3>Activity agent's take that day</h3><ol class="snapshot">${auto.nudges.map((n) => `<li>${esc(n)}</li>`).join("")}</ol>` : "");
}

function itemNotesBlock(day) {
  const keys = Object.keys(day.notes ?? {}).filter((k) => k !== "summary");
  if (!keys.length) return "";
  return `<h3>Notes on items</h3><ul class="item-notes">${keys.map((k) => {
    const d = describeKey(k, day.jira, day.github);
    const label = d.url ? `<a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">${esc(d.label)}</a>` : esc(d.label);
    return `<li><span class="key">${label}</span>${d.title ? ` <span class="muted">${esc(d.title)}</span>` : ""}<div class="text">${esc(day.notes[k])}</div></li>`;
  }).join("")}</ul>`;
}

// The Claude Code sessions worked in that day, as the Activity agent recorded them.
function claudeBlock(day) {
  const list = day.auto?.sessions ?? [];
  if (!list.length) return "";
  return `<h3>Claude sessions that day</h3><ul class="snapshot">${list.map((s) =>
    `<li><span class="key">${esc(s.folder)}</span> ${esc(s.title)} ${pill("info", `${timeOf(s.first)} – ${timeOf(s.last)} · ${s.prompts} prompt${s.prompts === 1 ? "" : "s"}`)}</li>`).join("")}</ul>`;
}

function doneBlock(day) {
  const done = day.done ?? {};
  const jira = done.jira ?? [], prs = done.prs ?? [], reviewed = done.reviewed ?? [];
  if (!jira.length && !prs.length && !reviewed.length) return "";
  return `<h3>Done that day</h3><ul class="snapshot">` +
    jira.map((j) => `<li><a class="key" href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener">${esc(j.key)}</a> ${esc(j.summary)} ${pill("good", j.status, true)}</li>`).join("") +
    prs.map((pr) => `<li>${prLink(pr)} ${esc(pr.title)} ${pr.merged ? pill("good", "merged", true) : pill("info", "closed")}</li>`).join("") +
    reviewed.map((pr) => `<li>Reviewed ${prLink(pr)} ${esc(pr.title)} <span class="muted">by ${esc(pr.author)}</span> ${reviewPill(pr.lastReviewState)}</li>`).join("") +
    `</ul>`;
}

function snapshotBlock(day) {
  const gh = day.github ?? { mine: [], toReview: [] };
  const jira = day.jira ?? [];
  const list = (items) => `<ul class="snapshot">${items.join("")}</ul>`;
  return `<details class="snap"><summary>What was open that day</summary>
    <h4>Jira (${jira.length})</h4>${jira.length ? list(jira.map((j) =>
      `<li><a class="key" href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener">${esc(j.key)}</a> ${esc(j.summary)} ${pill("info", j.status)}</li>`)) : '<p class="empty">None</p>'}
    <h4>My pull requests (${gh.mine.length})</h4>${gh.mine.length ? list(gh.mine.map((pr) =>
      `<li>${prLink(pr)} ${esc(pr.title)}
       <div class="chips">${(pr.pending ?? []).map((n) => pill(n.level, n.text, true)).join("")}</div></li>`)) : '<p class="empty">None</p>'}
    <h4>Needs my review (${gh.toReview.length})</h4>${gh.toReview.length ? list(gh.toReview.map((pr) =>
      `<li>${prLink(pr)} ${esc(pr.title)} <span class="muted">by ${esc(pr.author)}</span></li>`)) : '<p class="empty">None</p>'}
  </details>`;
}

async function select(date, { push = true } = {}) {
  selected = date;
  renderList();
  if (push) history.replaceState(null, "", `/history?date=${encodeURIComponent(date)}`);
  const pane = $("day");
  pane.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    if (!cache.has(date)) cache.set(date, await api(`/api/day?date=${encodeURIComponent(date)}`));
    const day = cache.get(date);
    if (selected !== date) return;   // a newer selection won
    const n = noteCount(day);
    pane.innerHTML = `<div class="day-head">
        <h2>${esc(longDate(day.date, { weekday: "long", year: "numeric", month: "long", day: "numeric" }))}</h2>
        <div class="hint">${pill("info", `${n} note${n === 1 ? "" : "s"}`)}${pill("info", `${day.jira.length} Jira`)}
          ${pill("info", `${day.github.mine.length} PRs`)}${pill("info", `${day.github.toReview.length} to review`)}</div>
      </div>
      <h3>Notes</h3>${notesBlock(day)}${itemNotesBlock(day)}${claudeBlock(day)}${doneBlock(day)}${snapshotBlock(day)}
      <p class="muted small">Saved ${day.savedAt ? new Date(day.savedAt).toLocaleString() : "?"} · file <code>${esc(day.date)}.md</code></p>`;
  } catch (e) {
    pane.innerHTML = `<div class="banner bad">${icon("alert")}${esc(e.message)}</div>`;
  }
}

function move(step) {
  const buttons = [...document.querySelectorAll(".day")];
  const i = buttons.findIndex((b) => b.dataset.date === selected);
  const next = buttons[Math.min(Math.max(i + step, 0), buttons.length - 1)];
  if (next && next.dataset.date !== selected) { select(next.dataset.date); next.scrollIntoView({ block: "nearest" }); }
}

// ---------- wiring ----------
$("backLink").innerHTML = `${icon("back")}<span>Today</span>`;
$("searchIcon").innerHTML = icon("search");
initTheme($("themeSel"));
$("days").addEventListener("click", (e) => { const b = e.target.closest(".day"); if (b) select(b.dataset.date); });
$("search").addEventListener("input", renderList);
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") { if (e.key === "Escape") e.target.blur(); return; }
  if (e.key === "/") { e.preventDefault(); $("search").focus(); }
  else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); move(1); }
  else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); move(-1); }
  else if (e.key === "Escape") location.href = "/";
});

(async () => {
  try {
    const res = await api("/api/history?days=366");
    DAYS = res.days.filter((d) => !d.error);
    $("meta").textContent = `${DAYS.length} saved day${DAYS.length === 1 ? "" : "s"} · ${res.progressDir}`;
    const wanted = new URLSearchParams(location.search).get("date");
    const first = DAYS.find((d) => d.date === wanted)?.date ?? DAYS[0]?.date;
    renderList();
    if (first) select(first, { push: false });
    else $("day").innerHTML = '<p class="empty">No saved days yet. Notes you add on the dashboard appear here.</p>';
  } catch (e) {
    toast(`Could not load history: ${e.message}`, "alert");
  }
})();
