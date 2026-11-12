// Settings: ~/.my-workday-assistant/config.json, created with defaults on first run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";

export const APP_DIR = path.join(os.homedir(), ".my-workday-assistant");
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
  auto: {                        // automatic notes from your GitHub/Jira activity
    enabled: true,
    intervalMinutes: 120,        // how often the day's automatic points are rebuilt
    workHours: "07:00-20:00",    // only within these local hours
    saveAt: "17:00",             // end of day: refresh everything and save the day's file (local time)
    catchupDays: 1,              // on start / after midnight: top up the previous N days' automatic points
    useClaude: null,             // summarize with headless Claude; null = yes when jira.mode is "claude", else plain lines
    nudges: true,                // the agent's take: what deserves attention today (needs useClaude)
    model: "haiku",
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
export const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
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
  const a = cfg.auto;
  if (!isPlainObject(a)) fail('"auto" must be an object');
  if (typeof a.enabled !== "boolean") fail('"auto.enabled" must be true or false');
  if (!(typeof a.intervalMinutes === "number" && a.intervalMinutes >= 5 && a.intervalMinutes <= 1440)) fail('"auto.intervalMinutes" must be a number between 5 and 1440');
  const range = typeof a.workHours === "string" && a.workHours.match(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/);
  if (!range || a.workHours.slice(0, 5) >= a.workHours.slice(6)) fail('"auto.workHours" must look like "07:00-20:00" (start before end)');
  if (typeof a.saveAt !== "string" || (a.saveAt !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(a.saveAt))) fail('"auto.saveAt" must be a time like "17:00", or "" to turn the end-of-day save off');
  if (a.saveAt && range && !(a.saveAt >= a.workHours.slice(0, 5) && a.saveAt < a.workHours.slice(6))) fail('"auto.saveAt" must fall inside "auto.workHours" (the save runs only during work hours)');
  if (!Number.isInteger(a.catchupDays) || a.catchupDays < 0 || a.catchupDays > 7) fail('"auto.catchupDays" must be a whole number between 0 and 7');
  if (typeof a.useClaude !== "boolean" && a.useClaude !== null) fail('"auto.useClaude" must be true, false or null (follow jira.mode)');
  if (typeof a.nudges !== "boolean") fail('"auto.nudges" must be true or false');
  if (typeof a.model !== "string" || !MODEL_RE.test(a.model)) fail('"auto.model" must be a model name such as haiku');
  return cfg;
}

/**
 * Writes one setting into the user's config file (a nested key path), keeping everything else
 * as they wrote it. Used for the settings the page can change (the Activity agent switch).
 */
export function saveSetting(keys, value, file = CONFIG_FILE) {
  if (!Array.isArray(keys) || !keys.length || keys.some((k) => typeof k !== "string" || UNSAFE_KEYS.has(k))) throw new Error("bad setting path");
  let user = {};
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));   // the app only runs with a valid file
    if (isPlainObject(parsed)) user = parsed;
  }
  let node = user;
  for (const k of keys.slice(0, -1)) { if (!isPlainObject(node[k])) node[k] = {}; node = node[k]; }
  node[keys.at(-1)] = value;
  writeFileAtomic(file, JSON.stringify(user, null, 2) + "\n");
}

/**
 * Loads the config, creating it with defaults if missing, and validates it.
 * MY_WORKDAY_ASSISTANT_PORT / MY_WORKDAY_ASSISTANT_PROGRESS_DIR override it (e.g. for a test instance).
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
  if (env.MY_WORKDAY_ASSISTANT_PORT) cfg.port = Number(env.MY_WORKDAY_ASSISTANT_PORT);
  if (env.MY_WORKDAY_ASSISTANT_PROGRESS_DIR) cfg.progressDir = env.MY_WORKDAY_ASSISTANT_PROGRESS_DIR;
  // "~" is expanded and a relative path is taken from the home folder, before validation
  // (which then insists on absolute paths).
  const home = (p) => (typeof p === "string" ? path.resolve(os.homedir(), p.replace(/^~(?=$|[\\/])/, os.homedir())) : p);
  cfg.progressDir = home(cfg.progressDir);
  if (isPlainObject(cfg.claude)) cfg.claude.defaultDir = home(cfg.claude.defaultDir);
  validateConfig(cfg, file);
  // Automatic notes only call Claude when the user already relies on it for Jira, unless told otherwise.
  cfg.auto.useClaude ??= cfg.jira.mode === "claude";
  cfg.jira.doneJql = cfg.jira.doneJql.replaceAll("{days}", String(cfg.scoreWeeks * 7 + 7));
  return cfg;
}
