// HTTP server: static page + JSON API. Data sources are injected so tests can stub them.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { localDate } from "./dates.js";
import { addEntry, history, loadProgress, readDayFull, removeEntry, saveProgress } from "./progress.js";
import { doneOn, mergeDone, scoreSince, weeklyScore, withinWindow } from "./score.js";

const STATIC = {
  "/": ["index.html", "text/html"],
  "/history": ["history.html", "text/html"],
  "/styles.css": ["styles.css", "text/css"],
  "/main.js": ["main.js", "text/javascript"],
  "/history.js": ["history.js", "text/javascript"],
  "/shared.js": ["shared.js", "text/javascript"],
  "/theme.js": ["theme.js", "text/javascript"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
};

const SECURITY_HEADERS = {
  // Everything is served by this app; nothing inline, nothing third-party.
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

// Validation failures we raise ourselves: safe to echo to the client as 400s.
const CLIENT_ERROR = /^(note text is empty|note is too long|note not found|bad date|bad JSON|request too large)$/;
const EMPTY_GITHUB = Object.freeze({ login: null, mine: [], toReview: [], closed: [], reviewed: [] });

/**
 * @param {object} deps
 * @param {object} deps.cfg            loaded config
 * @param {() => Promise<object>} deps.collectGithub
 * @param {ReturnType<import("./jira.js").createJiraSource>} deps.jira
 * @param {string} deps.publicDir
 * @param {ReturnType<import("./launch.js").createLauncher>} [deps.launcher]  "Launch Claude"; omitted = feature off
 * @param {(msg: string) => void} [deps.log]
 * @param {() => void} [deps.onQuit]
 */
export function createServer({ cfg, collectGithub, jira, publicDir, launcher = null, log = () => {}, onQuit = () => {} }) {
  const origins = [`http://127.0.0.1:${cfg.port}`, `http://localhost:${cfg.port}`];
  const hosts = origins.map((o) => o.replace("http://", ""));
  const weeks = cfg.scoreWeeks ?? 8;

  // GitHub: short cache — it's fast and changes often.
  const gh = { data: null, fetchedAt: 0, error: null, inflight: null };
  const refreshGithub = (force = false) => {
    if (gh.data && !force && Date.now() - gh.fetchedAt < cfg.githubCacheSeconds * 1000) return Promise.resolve();
    gh.inflight ??= collectGithub({ since: scoreSince(weeks) })
      .then((d) => Object.assign(gh, { data: d, fetchedAt: Date.now(), error: null }))
      .catch((e) => { gh.error = e.message; log(`github: ${e.message}`); })
      .finally(() => { gh.inflight = null; });
    return gh.inflight;
  };

  // Only this app's own page may use the API:
  //  - Host must be ours (blocks DNS rebinding);
  //  - a browser *subresource or fetch* request (an <img>, fetch(), <script> on another
  //    site) must come from our own origin — Sec-Fetch-Site tells us. Top-level navigations
  //    are always fine: following a link to the dashboard just renders our page;
  //  - writes also need our Origin plus a custom header (blocks cross-site requests
  //    and forces a CORS preflight, which we never approve).
  const allowed = (req) => {
    const h = req.headers;
    if (!hosts.includes(h.host)) return false;
    const isNavigation = h["sec-fetch-mode"] === "navigate" && h["sec-fetch-dest"] === "document";
    const site = h["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none" && !isNavigation) return false;
    if (req.method === "GET") return true;
    return h["x-dd"] === "1" && origins.includes(h.origin);
  };

  const send = (res, code, body, type = "application/json") => {
    res.writeHead(code, { ...SECURITY_HEADERS, "content-type": `${type}; charset=utf-8` });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let body = "";
    req.on("error", reject);
    req.on("data", (c) => { body += c; if (body.length > 2e6) { reject(new Error("request too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("bad JSON")); } });
  });

  // What was finished, trimmed to the score table's window so lists and counts agree.
  const finished = () => {
    const g = { ...EMPTY_GITHUB, ...(gh.data ?? {}) };
    const since = scoreSince(weeks);
    const f = withinWindow({ jiraDone: jira.state.done ?? [], closed: g.closed, reviewed: g.reviewed }, since);
    return { github: { ...g, closed: f.closed, reviewed: f.reviewed }, jiraDone: f.jiraDone, since };
  };
  const dataPayload = () => {
    const { github, jiraDone } = finished();
    return {
      generatedAt: new Date().toISOString(),
      github,
      githubError: gh.error,
      githubFetchedAt: gh.fetchedAt ? new Date(gh.fetchedAt).toISOString() : null,
      jira: jira.state.issues ?? [],
      jiraDone,
      jiraStatus: jira.status(),
      score: weeklyScore({ jiraDone, closed: github.closed, reviewed: github.reviewed }, weeks),
      claude: launcher ? launcher.info() : null,
      progressDir: cfg.progressDir,
      ...loadProgress(cfg.progressDir),
    };
  };
  // Arguments for the progress writers: (jira, github, date, { jiraDone }).
  const snapshot = () => { const { github, jiraDone } = finished(); return [jira.state.issues ?? [], github, localDate(), { jiraDone }]; };
  // A saved day's `done` is a snapshot from its last write; for days still inside the score
  // window, add what the live data knows (e.g. a PR merged after the day's last note).
  const liveDone = (date, f = finished()) =>
    date >= f.since ? doneOn(date, { jiraDone: f.jiraDone, closed: f.github.closed, reviewed: f.github.reviewed }) : {};
  const clip = (s, n = 80) => String(s ?? "").slice(0, n);

  const routes = {
    // Reads: no side effects beyond refreshing the short-lived GitHub cache.
    "GET /api/ping": () => ({ app: "daily-dashboard" }),
    "GET /api/status": () => ({ jiraStatus: jira.status() }),
    "GET /api/data": async () => { await refreshGithub(false); return dataPayload(); },
    "GET /api/history": (_req, url) => {
      const days = Math.min(Math.max(Number.parseInt(url.searchParams.get("days") ?? "7", 10) || 7, 1), 366);
      const f = finished();   // once for the whole list
      const list = history(cfg.progressDir, days).map((d) => {
        if (!d.counts) return d;
        const merged = mergeDone(d.done, liveDone(d.date, f));
        return { ...d, counts: { ...d.counts, done: merged.jira.length + merged.prs.length + merged.reviewed.length } };
      });
      return { progressDir: cfg.progressDir, days: list };
    },
    "GET /api/day": (_req, url) => {
      const day = readDayFull(cfg.progressDir, url.searchParams.get("date") ?? "");
      if (!day) throw Object.assign(new Error("no notes saved for that day"), { status: 404 });
      return { ...day, done: mergeDone(day.done, liveDone(day.date)) };
    },
    // Writes and anything that costs something (a Jira refresh runs Claude): POST only.
    "POST /api/refresh": async () => { jira.refresh(); await refreshGithub(true); return dataPayload(); },
    "POST /api/save": async (req) => {
      const { notes } = await readBody(req);
      const result = saveProgress(cfg.progressDir, notes, ...snapshot());
      log(`saved ${result.files[0]} (${Object.keys(notes ?? {}).length} key(s) sent)`);
      return result;
    },
    "POST /api/entries": async (req) => {
      const { text } = await readBody(req);
      const result = addEntry(cfg.progressDir, text, ...snapshot());
      log(`added note ${result.entry.id}`);
      return result;
    },
    "POST /api/entries/delete": async (req) => {
      const { id } = await readBody(req);
      const result = removeEntry(cfg.progressDir, clip(id), ...snapshot());
      log(`deleted note ${clip(id)}`);
      return result;
    },
    // Opens a new terminal running Claude in a folder (default, or the one sent). The launcher
    // validates the folder (absolute, exists, no shell metacharacters) and spawns without a shell.
    "POST /api/launch": async (req) => {
      if (!launcher) throw Object.assign(new Error("launching is not available"), { status: 404 });
      const { dir } = await readBody(req);
      const result = await launcher.launch(clip(dir, 1024));
      log(`launched claude in ${result.dir}`);
      return { ok: true, ...result };
    },
    "POST /api/quit": () => { log("quit requested"); setTimeout(onQuit, 200); return { ok: true }; },
  };

  const server = http.createServer(async (req, res) => {
    if (!allowed(req)) return send(res, 403, { error: "forbidden" });
    const url = new URL(req.url, origins[0]);
    try {
      const asset = req.method === "GET" && STATIC[url.pathname];
      if (asset) return send(res, 200, fs.readFileSync(path.join(publicDir, asset[0])), asset[1]);
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(res, 404, { error: "not found" });
      send(res, 200, await route(req, url));
    } catch (e) {
      const status = e.status ?? (CLIENT_ERROR.test(e.message) ? 400 : 500);
      if (status === 500) {
        log(`error ${req.method} ${url.pathname}: ${e.stack ?? e.message}`);
        return send(res, 500, { error: "internal error — see app.log" });
      }
      send(res, status, { error: e.message });
    }
  });
  server.refreshGithub = refreshGithub;
  return server;
}
