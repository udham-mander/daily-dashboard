// Helpers shared by the dashboard (main.js) and the History page (history.js).

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : null);
export const ago = (iso) => { const d = daysSince(iso); return d == null ? "?" : d === 0 ? "today" : d === 1 ? "1 day" : `${d} days`; };
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export const since = (iso) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? rel.format(-m, "minute") : rel.format(-Math.round(m / 60), "hour");
};
export const timeOf = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** "2026-11-10" → "Tuesday, 10 November" (parsed as a local date, not UTC). */
export const longDate = (ymd, opts = { weekday: "long", month: "long", day: "numeric" }) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
};
/** "2026-11-10" → "10 Nov" */
export const shortDate = (ymd) => longDate(ymd, { month: "short", day: "numeric" });
/** ISO timestamp → local "10 Nov" */
export const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "?");
/** A GitHub review state as a pill: approved = good, changes requested = bad, else info. */
export const reviewPill = (state) => {
  const s = String(state ?? "").toLowerCase().replace("_", " ");
  return pill(s === "approved" ? "good" : s === "changes requested" ? "bad" : "info", s || "reviewed", true);
};

export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
  keys: () => { try { return Object.keys(localStorage); } catch { return []; } },
};

/** Only http(s) links are ever rendered into href; anything else becomes an inert "#". */
export const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(u ?? "") ? u : "#");
export const pill = (level, text, dot = false) => `<span class="pill ${level}${dot ? " dot" : ""}">${esc(text)}</span>`;
export const short = (repo) => repo.split("/")[1];
/** The one way a PR is linked: "repo#123" → its page in a new tab. */
export const prLink = (pr, cls = "key") =>
  `<a${cls ? ` class="${cls}"` : ""} href="${esc(safeUrl(pr.url))}" target="_blank" rel="noopener">${esc(short(pr.repo))}#${esc(pr.number)}</a>`;

const ICONS = {
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  jira: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/>',
  pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4"/><path d="m13 4-2 2 2 2"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  trophy: '<path d="M8 4h8v6a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4"/><path d="M12 14v3M8 20h8M10 17h4v3h-4z"/>',
  terminal: '<path d="M4 5h16v14H4z"/><path d="m8 9 3 3-3 3M13 15h4"/>',
  bot: '<rect x="5" y="9" width="14" height="10" rx="3"/><path d="M12 5v4M9 14h.01M15 14h.01M9.5 17h5"/><circle cx="12" cy="4" r="1"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};
export const icon = (name, cls = "i") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

let toastTimer;
export function toast(msg, kind = "check") {
  const t = $("toast");
  t.innerHTML = `${icon(kind)}<span>${esc(msg)}</span>`;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

/** GET when `body` is undefined, otherwise POST JSON with the header the server requires for writes. */
export async function api(path, body) {
  const init = body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json", "x-dd": "1" }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** Wires the theme <select> (the theme itself is applied before paint by theme.js). */
export function initTheme(select) {
  select.value = store.get("dd-theme") ?? "auto";
  select.addEventListener("change", () => {
    const theme = select.value;
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    store.set("dd-theme", theme);
  });
}

/** Describes a note key using a data snapshot: { label, title, url }. */
export function describeKey(key, jira = [], github = { mine: [], toReview: [] }) {
  if (key === "summary") return { label: "Summary", title: "", url: null };
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "jira") {
    const j = jira.find((x) => x.key === id);
    return { label: id, title: j?.summary ?? "", url: j?.url ?? null };
  }
  const list = kind === "pr" ? github.mine : github.toReview;
  const pr = list.find((p) => `${p.repo}#${p.number}` === id);
  const [repo, num] = id.split("#");
  return { label: `${kind === "review" ? "Review " : ""}${short(repo)}#${num}`, title: pr?.title ?? "", url: pr?.url ?? null };
}
