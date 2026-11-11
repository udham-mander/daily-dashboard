// Jira issues assigned to the user, from one of two sources:
//   claude: headless Claude Code (`claude -p`) with the Atlassian connector — no token needed
//   token:  the Jira REST API with an Atlassian API token
// Results are validated; the last good result is cached on disk and kept on failure.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { writeFileAtomic } from "./fsutil.js";

const FIELDS = ["summary", "status", "issuetype", "priority", "created", "updated", "statuscategorychangedate", "resolutiondate"];
const SHAPE = "key, summary, type (issuetype.name), priority (priority.name), status (status.name), " +
  "statusCategory (status.statusCategory.name), created, updated, statusCategoryChangedAt (statuscategorychangedate), " +
  "resolved (resolutiondate)";
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;   // also enforced by config; re-checked here because of shell: true
const CLAUDE_TIMEOUT_MS = 180_000;
const CLAUDE_MAX_BUDGET_USD = "0.10";        // a refresh costs ~$0.01 with Haiku; this caps a runaway
export const NOT_CONFIGURED =
  'Jira is not set up yet: put your site in "jira.site" of ~/.daily-dashboard/config.json ' +
  '(for example "your-company.atlassian.net") and restart the app.';

/**
 * Normalizes and validates issues — never trust the shape blindly, especially when a model
 * transcribed it. Accepts the compact shape or raw Jira issues (`{ key, fields }`).
 */
export function normalizeIssues(list, site) {
  if (!Array.isArray(list)) throw new Error("expected a JSON array of issues");
  const issues = list.map((i) => {
    const f = i.fields ?? i;
    const category = f.statusCategory ?? f.status?.statusCategory?.name;
    return {
      key: i.key,
      summary: f.summary,
      url: `https://${site}/browse/${i.key}`,  // built here, never taken from input
      type: f.type ?? f.issuetype?.name ?? "",
      priority: (typeof f.priority === "string" ? f.priority : f.priority?.name) ?? "",
      status: typeof f.status === "string" ? f.status : f.status?.name ?? "",
      statusCategory: typeof category === "string" ? category : "",
      created: f.created ?? null,
      updated: f.updated ?? null,
      statusCategoryChangedAt: f.statusCategoryChangedAt ?? f.statuscategorychangedate ?? null,
      resolved: f.resolved ?? f.resolutiondate ?? null,
    };
  });
  const invalid = issues.filter((j) => !KEY_RE.test(j.key ?? "") || typeof j.summary !== "string" || !j.status);
  if (invalid.length) throw new Error(`${invalid.length} issue(s) failed validation`);
  for (const j of issues)
    for (const field of ["created", "updated", "statusCategoryChangedAt", "resolved"])
      if (j[field] && Number.isNaN(Date.parse(j[field]))) throw new Error(`${j.key}: bad date in ${field}`);
  return issues;
}

/**
 * Validates a fetch result: `{ open, done }` (two searches), or a bare array of open issues
 * (older caches and simple fetchers). Both lists are normalized.
 */
export function normalizeResult(result, site) {
  if (Array.isArray(result)) return { open: normalizeIssues(result, site), done: [] };
  const open = result?.open ?? result?.issues;   // `issues`: the on-disk cache
  if (result === null || typeof result !== "object" || !Array.isArray(open)) throw new Error('expected {"open": [...], "done": [...]}');
  if (result.done != null && !Array.isArray(result.done)) throw new Error('"done" must be an array');   // null = none
  return { open: normalizeIssues(open, site), done: normalizeIssues(result.done ?? [], site) };
}

const MAX_RESULTS = 100;   // both sources return at most one page

/** Parses `claude -p --output-format json` output into validated `{ open, done }` issue lists. */
export function parseClaudeOutput(stdout, site) {
  const res = JSON.parse(stdout);
  if (res.is_error) throw new Error(res.result || "claude reported an error");
  const text = String(res.result).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return normalizeResult(JSON.parse(text), site);
}

function viaClaude({ site, jql, doneJql, claudeModel }) {
  if (!MODEL_RE.test(claudeModel)) return Promise.reject(new Error("invalid jira.claudeModel"));
  const searches = [`"open": jql ${JSON.stringify(jql)}, maxResults 100`];
  if (doneJql) searches.push(`"done": jql ${JSON.stringify(doneJql)}, maxResults 100`);
  const prompt =
    `Call mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql with cloudId "${site}" and fields ${JSON.stringify(FIELDS)} ` +
    `once per search below, then output ONLY one JSON object, no prose, no code fence: ` +
    `{"open": [...], "done": [...]} — one object per issue with keys ${SHAPE}. ` +
    `Copy values exactly. Use [] for a search with no issues${doneJql ? "" : ' and [] for "done"'}.\n` +
    searches.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const args = ["-p", "--model", claudeModel, "--output-format", "json", "--no-session-persistence",
    "--max-budget-usd", CLAUDE_MAX_BUDGET_USD,
    "--allowedTools", "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql"];

  return new Promise((resolve, reject) => {
    // Prompt via stdin: on Windows `claude` is a .cmd shim run through cmd.exe, where
    // free text in arguments is fragile.
    const child = spawn("claude", args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      shell: process.platform === "win32",
      env: { ...process.env, UDHAM_FLASH_DISABLE: "1" }, // keep "flash when done" Stop hooks quiet
    });
    let stdout = "", stderr = "";
    // On Windows the child is cmd.exe → claude.cmd → node; kill the whole tree, not just cmd.exe.
    const killTree = () => {
      if (process.platform === "win32" && child.pid)
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => { killTree(); reject(new Error("claude timed out after 180 s")); }, CLAUDE_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`could not start claude: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`));
      try { resolve(parseClaudeOutput(stdout, site)); }
      catch (e) { reject(new Error(`unexpected claude output: ${e.message}`)); }
    });
    child.stdin.end(prompt);
  });
}

async function viaToken({ site, jql, doneJql, email, tokenEnv }) {
  const token = process.env[tokenEnv];
  if (!email || !token) throw new Error(`token mode needs jira.email in the config and ${tokenEnv} set`);
  const search = async (q) => {
    const url = new URL(`https://${site}/rest/api/3/search/jql`);
    url.search = new URLSearchParams({ jql: q, fields: FIELDS.join(","), maxResults: "100" }).toString();
    const res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Jira API ${res.status} ${res.statusText}`);
    return normalizeIssues((await res.json()).issues ?? [], site);
  };
  const [open, done] = await Promise.all([search(jql), doneJql ? search(doneJql) : []]);
  return { open, done };
}

/**
 * A cached, de-duplicated Jira source.
 * @param {object} jiraCfg  the `jira` section of the config
 * @param {string} cacheFile
 * @param {(cfg: object) => Promise<{open: object[], done: object[]} | object[]>} [fetcher]  override for tests
 */
export function createJiraSource(jiraCfg, cacheFile, fetcher) {
  const fetchIssues = fetcher ?? (jiraCfg.mode === "token" ? viaToken : viaClaude);
  const source = jiraCfg.mode === "token" ? "token" : "claude";
  // issues = open (what the user works on); done = finished recently (for the score)
  const state = { issues: null, done: null, fetchedAt: null, running: false, error: null, warning: null, source };
  let inflight = null;

  return {
    state,
    // The cache is a file in the user's profile; re-validate it anyway (URLs are rebuilt).
    loadCache() {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        const { open, done } = normalizeResult(cached, jiraCfg.site);
        const fetchedAt = typeof cached.fetchedAt === "string" && !Number.isNaN(Date.parse(cached.fetchedAt)) ? cached.fetchedAt : null;
        Object.assign(state, { issues: open, done, fetchedAt });
      } catch { /* no cache yet, or an invalid one: start empty */ }
    },
    /** Starts a refresh (or joins the running one). Never rejects; failures land in state.error. */
    refresh() {
      if (!jiraCfg.site) { state.error = NOT_CONFIGURED; return Promise.resolve(); }
      inflight ??= (async () => {
        state.running = true;
        try {
          const { open, done } = normalizeResult(await fetchIssues(jiraCfg), jiraCfg.site);
          const full = [open.length >= MAX_RESULTS && "open", done.length >= MAX_RESULTS && "done"].filter(Boolean);
          const warning = full.length ? `the ${full.join(" and ")} search hit the ${MAX_RESULTS}-issue limit; older issues are missing (narrow the JQL or lower scoreWeeks)` : null;
          Object.assign(state, { issues: open, done, fetchedAt: new Date().toISOString(), error: null, warning, source });
          writeFileAtomic(cacheFile, JSON.stringify({ issues: open, done, fetchedAt: state.fetchedAt, source }, null, 2));
        } catch (e) {
          state.error = e.message;   // keep the last good issues on screen
        } finally {
          state.running = false;
          inflight = null;
        }
      })();
      return inflight;
    },
    status: () => ({ running: state.running, error: state.error, warning: state.warning, fetchedAt: state.fetchedAt, source: state.source, configured: Boolean(jiraCfg.site) }),
  };
}
