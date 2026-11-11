// Jira issues assigned to the user, from one of two sources:
//   claude: headless Claude Code (`claude -p`) with the Atlassian connector — no token needed
//   token:  the Jira REST API with an Atlassian API token
// Results are validated; the last good result is cached on disk and kept on failure.
import fs from "node:fs";
import { resultText, runClaude } from "./claude.js";
import { writeFileAtomic } from "./fsutil.js";

const FIELDS = ["summary", "status", "issuetype", "priority", "created", "updated", "statuscategorychangedate", "resolutiondate"];
const SHAPE = "key, summary, type (issuetype.name), priority (priority.name), status (status.name), " +
  "statusCategory (status.statusCategory.name), created, updated, statusCategoryChangedAt (statuscategorychangedate), " +
  "resolved (resolutiondate)";
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const CLAUDE_MAX_BUDGET_USD = "0.10";        // a refresh costs ~$0.01 with Haiku; this caps a runaway
const JIRA_SEARCH_TOOL = "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql";
const MAX_RESULTS = 100;                     // both sources return at most one page
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

/** Parses `claude -p --output-format json` output into validated `{ open, done }` issue lists. */
export function parseClaudeOutput(stdout, site) {
  return normalizeResult(JSON.parse(resultText(stdout)), site);
}

/** The prompt for the headless Jira fetch: one tool call per search, one JSON object back. */
export function jiraPrompt({ site, jql, doneJql }) {
  const searches = [`"open": jql ${JSON.stringify(jql)}, maxResults ${MAX_RESULTS}`];
  if (doneJql) searches.push(`"done": jql ${JSON.stringify(doneJql)}, maxResults ${MAX_RESULTS}`);
  return `Call ${JIRA_SEARCH_TOOL} with cloudId "${site}" and fields ${JSON.stringify(FIELDS)} ` +
    `once per search below, then output ONLY one JSON object, no prose, no code fence: ` +
    `{"open": [...], "done": [...]} — one object per issue with keys ${SHAPE}. ` +
    `Copy values exactly. Use [] for a search with no issues${doneJql ? "" : ' and [] for "done"'}.\n` +
    searches.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

async function viaClaude(cfg) {
  const text = await runClaude(jiraPrompt(cfg), { model: cfg.claudeModel, maxBudgetUsd: CLAUDE_MAX_BUDGET_USD, allowedTools: [JIRA_SEARCH_TOOL] });
  try { return normalizeResult(JSON.parse(text), cfg.site); }
  catch (e) { throw new Error(`unexpected claude output: ${e.message}`); }
}

async function viaToken({ site, jql, doneJql, email, tokenEnv }) {
  const token = process.env[tokenEnv];
  if (!email || !token) throw new Error(`token mode needs jira.email in the config and ${tokenEnv} set`);
  const search = async (q) => {
    const url = new URL(`https://${site}/rest/api/3/search/jql`);
    url.search = new URLSearchParams({ jql: q, fields: FIELDS.join(","), maxResults: String(MAX_RESULTS) }).toString();
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
