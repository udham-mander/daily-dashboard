// Settings: ~/.daily-dashboard/config.json, created with defaults on first run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_DIR = path.join(os.homedir(), ".daily-dashboard");
export const CONFIG_FILE = path.join(APP_DIR, "config.json");

export const DEFAULTS = Object.freeze({
  port: 4317,
  progressDir: path.join(os.homedir(), "daily-progress"), // where Save writes YYYY-MM-DD.md/.json
  openBrowser: true,
  githubCacheSeconds: 120,
  scoreWeeks: 8,               // weekly score table: this week + the previous (scoreWeeks - 1)
  jira: {
    site: "",                    // REQUIRED: your Jira site, e.g. "your-company.atlassian.net"
    jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    // Finished issues for the score; {days} becomes scoreWeeks × 7 + 7 (the table's oldest Monday
    // is at most that far back; the server trims the lists to the table). "" = don't fetch them.
    doneJql: "assignee = currentUser() AND statusCategory = Done AND statusCategoryChangedDate >= -{days}d ORDER BY statusCategoryChangedDate DESC",
    refreshMinutes: 60,          // background refresh while running; 0 = only on demand
    mode: "claude",              // "claude" (headless Claude Code + Atlassian connector) | "token"
    claudeModel: "haiku",
    email: "",                   // token mode: Atlassian account email
    tokenEnv: "JIRA_API_TOKEN",  // token mode: env var holding the API token
  },
  claude: {
    defaultDir: os.homedir(),    // where "Launch Claude" opens a new session (the 5 most recent folders are offered too)
    command: "claude",           // what the new terminal runs
  },
});

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Deep-merges `over` onto `base` (objects merge, everything else replaces). Ignores prototype
 * keys. The result shares nothing with `base`, so callers can't mutate the shared DEFAULTS.
 */
export function merge(base, over = {}) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const current = Object.hasOwn(base, k) ? base[k] : undefined;
    out[k] = isPlainObject(v) && isPlainObject(current) ? merge(current, v) : v;
  }
  return out;
}

// Values that end up in command lines, URLs or prompts must be plain tokens.
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const nonNegative = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Throws a readable error naming the offending setting. */
export function validateConfig(cfg, file = CONFIG_FILE) {
  const fail = (what) => { throw new Error(`${file}: ${what}`); };
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) fail('"port" must be a whole number between 1 and 65535');
  if (typeof cfg.progressDir !== "string" || !path.isAbsolute(cfg.progressDir)) fail('"progressDir" must be an absolute folder path (or start with ~)');
  if (typeof cfg.openBrowser !== "boolean") fail('"openBrowser" must be true or false');
  if (!nonNegative(cfg.githubCacheSeconds)) fail('"githubCacheSeconds" must be a number ≥ 0');
  if (!Number.isInteger(cfg.scoreWeeks) || cfg.scoreWeeks < 1 || cfg.scoreWeeks > 52) fail('"scoreWeeks" must be a whole number between 1 and 52');
  const j = cfg.jira;
  if (!isPlainObject(j)) fail('"jira" must be an object');
  // An empty site is allowed (first run): the app then shows how to set it instead of failing to start.
  if (typeof j.site !== "string" || (j.site && !HOST_RE.test(j.site))) fail('"jira.site" must be a hostname such as your-company.atlassian.net');
  if (typeof j.jql !== "string" || !j.jql.trim() || j.jql.length > 2000) fail('"jira.jql" must be a non-empty JQL string (≤ 2000 chars)');
  if (typeof j.doneJql !== "string" || j.doneJql.length > 2000) fail('"jira.doneJql" must be a JQL string (≤ 2000 chars; "" disables it)');
  if (!nonNegative(j.refreshMinutes)) fail('"jira.refreshMinutes" must be a number ≥ 0');
  if (!["claude", "token"].includes(j.mode)) fail('"jira.mode" must be "claude" or "token"');
  if (typeof j.claudeModel !== "string" || !MODEL_RE.test(j.claudeModel)) fail('"jira.claudeModel" must be a model name such as haiku');
  if (typeof j.email !== "string" || j.email.length > 254) fail('"jira.email" must be a string');
  if (typeof j.tokenEnv !== "string" || !ENV_RE.test(j.tokenEnv)) fail('"jira.tokenEnv" must be an environment variable name');
  const c = cfg.claude;
  if (!isPlainObject(c)) fail('"claude" must be an object');
  if (typeof c.defaultDir !== "string" || !path.isAbsolute(c.defaultDir)) fail('"claude.defaultDir" must be an absolute folder path (or start with ~)');
  if (typeof c.command !== "string" || !c.command.trim() || c.command.length > 200 || /[\x00-\x1f\x7f]/.test(c.command))
    fail('"claude.command" must be a one-line command of at most 200 characters');
  return cfg;
}

/**
 * Loads the config, creating it with defaults if missing, and validates it.
 * DAILY_DASHBOARD_PORT / DAILY_DASHBOARD_PROGRESS_DIR override it (e.g. for a test instance).
 */
export function loadConfig({ env = process.env, file = CONFIG_FILE } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let user = {};
  if (fs.existsSync(file)) {
    try { user = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
    catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
    if (!isPlainObject(user)) throw new Error(`${file} must contain a JSON object`);
  } else {
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + "\n");
  }
  const cfg = merge(DEFAULTS, user);
  if (env.DAILY_DASHBOARD_PORT) cfg.port = Number(env.DAILY_DASHBOARD_PORT);
  if (env.DAILY_DASHBOARD_PROGRESS_DIR) cfg.progressDir = env.DAILY_DASHBOARD_PROGRESS_DIR;
  // "~" is expanded and a relative path is taken from the home folder, before validation
  // (which then insists on absolute paths).
  const home = (p) => (typeof p === "string" ? path.resolve(os.homedir(), p.replace(/^~(?=$|[\\/])/, os.homedir())) : p);
  cfg.progressDir = home(cfg.progressDir);
  if (isPlainObject(cfg.claude)) cfg.claude.defaultDir = home(cfg.claude.defaultDir);
  validateConfig(cfg, file);
  cfg.jira.doneJql = cfg.jira.doneJql.replaceAll("{days}", String(cfg.scoreWeeks * 7 + 7));
  return cfg;
}
