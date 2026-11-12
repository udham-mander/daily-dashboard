#!/usr/bin/env node
// My workday assistant — entry point. Starts the local server (127.0.0.1 only), keeps a single
// instance, schedules Jira refreshes and opens the browser.
//   node app.js [--no-open]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { APP_DIR, CONFIG_FILE, loadConfig } from "./lib/config.js";
import { createAutoNotes } from "./lib/auto.js";
import { createBlacklist } from "./lib/blacklist.js";
import { collectGithub, fetchEvents } from "./lib/github.js";
import { createJiraSource } from "./lib/jira.js";
import { createLauncher } from "./lib/launch.js";
import { createServer } from "./lib/server.js";
import { collectSessions } from "./lib/sessions.js";

let cfg;
try { cfg = loadConfig(); }
catch (e) { console.error(`My workday assistant cannot start: ${e.message}`); process.exit(1); }
const ORIGIN = `http://127.0.0.1:${cfg.port}`;
const LOG_FILE = path.join(APP_DIR, "app.log");
const LOG_MAX_BYTES = 1_000_000;

// One line per message: control characters stripped (log injection), length capped,
// and the file rotated once (app.log → app.log.1) when it passes 1 MB.
function log(msg) {
  try {
    const line = `${new Date().toISOString()} ${String(msg).replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 2000)}\n`;
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* logging must never break the app */ }
}

function openBrowser() {
  if (!cfg.openBrowser || process.argv.includes("--no-open")) return;
  const url = `${ORIGIN}/`;
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

const jira = createJiraSource(cfg.jira, path.join(APP_DIR, "jira-cache.json"));
const refreshJira = () => jira.refresh().then(() => {
  if (jira.state.error) log(`jira: ${jira.state.error}`);
  else if (jira.state.warning) log(`jira: ${jira.state.warning}`);
});
const shutdown = (why) => { log(`stopped (${why})`); process.exit(0); };

const launcher = createLauncher({
  defaultDir: cfg.claude.defaultDir, command: cfg.claude.command,
  recentFile: path.join(APP_DIR, "recent-dirs.json"),
});

// The scheduler reads the server's GitHub cache lazily (the closures run after `server` exists),
// and the server exposes the scheduler on POST /api/auto.
let server;
const auto = createAutoNotes({
  cfg: cfg.auto, progressDir: cfg.progressDir, jira, fetchEvents, log, site: cfg.jira.site, scoreWeeks: cfg.scoreWeeks,
  blacklist: createBlacklist(path.join(APP_DIR, "blacklist.json")),   // what the user crossed off the agent's take
  sessions: collectSessions,                                            // the Claude Code sessions worked in that day
  data: () => server.finished(),
  refreshGithub: (force) => server.refreshGithub(force),
});
server = createServer({
  cfg, collectGithub, jira, launcher, auto, log, sessions: collectSessions,
  publicDir: path.join(import.meta.dirname, "public"),
  onQuit: () => shutdown("quit from page/API"),
});

// Already running? Open the page and exit, so the desktop icon is safe to click twice.
server.on("error", async (e) => {
  if (e.code !== "EADDRINUSE") { log(`server: ${e.message}`); process.exit(1); }
  try {
    const res = await fetch(`${ORIGIN}/api/ping`, { signal: AbortSignal.timeout(3000) });
    if ((await res.json()).app === "my-workday-assistant") { openBrowser(); process.exit(0); }
  } catch {}
  const msg = `port ${cfg.port} is in use by another program; set "port" in ${CONFIG_FILE}`;
  log(msg); console.error(msg);
  process.exit(1);
});

server.listen(cfg.port, "127.0.0.1", () => {
  log(`started on ${ORIGIN} (jira via ${cfg.jira.mode}, saving to ${cfg.progressDir})`);
  console.log(`My workday assistant running at ${ORIGIN}/ — stop with Ctrl+C or the Quit button`);
  jira.loadCache();
  // First data, then the scheduler: its first tick may build today's automatic notes.
  Promise.allSettled([refreshJira(), server.refreshGithub(true)]).then(() => auto.start());
  if (cfg.jira.refreshMinutes > 0) setInterval(refreshJira, cfg.jira.refreshMinutes * 60_000).unref();
  openBrowser();
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown(sig));
