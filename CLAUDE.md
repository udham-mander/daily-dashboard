# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Daily Dashboard: a local web app (Node, **no npm dependencies**) showing the user's open Jira
issues, their GitHub PRs with what each is waiting on, PRs awaiting their review, and daily
notes saved to a folder. It runs on `127.0.0.1` only and is started from a Windows desktop icon.

A Claude skill drives it over its HTTP API: `udham-swe:daily-dashboard` (repo
`udham-mander/udham-swe`, files `skills/daily-dashboard/SKILL.md` and `dd.js`).
**The API is a contract with that skill** — see "API contract" below.

## Commands

```bash
npm test              # node:test suite (test/*.test.js), no network or gh/claude needed
npm run check         # syntax check of the entry points
npm run dev           # node --watch app.js --no-open
npm start             # node app.js (opens the browser)
npm run install-shortcut     # Windows: desktop icon + hidden launcher + icon
npm run uninstall-shortcut   # removes them, stops the app, keeps data
```

Run a throwaway instance without touching the user's real one or their progress folder:

```bash
DAILY_DASHBOARD_PORT=4399 DAILY_DASHBOARD_PROGRESS_DIR=/tmp/dd-test node app.js --no-open
```

Stop the real instance: the page's Quit button, or `POST /api/quit` (see API), or
`node <udham-swe>/skills/daily-dashboard/dd.js quit`.

## Layout

```
app.js             entry: config, single instance (EADDRINUSE → ping → open page → exit),
                   Jira refresh timer, browser launch, SIGINT/SIGTERM
lib/server.js      createServer({ cfg, collectGithub, jira, publicDir, log, onQuit }):
                   static files + JSON API + security checks. Sources are injected (tests stub them).
lib/github.js      gh GraphQL: collectGithub(), pendingNotes(pr)
lib/jira.js        createJiraSource(cfg.jira, cacheFile, fetcher?): claude -p or REST token,
                   normalizeIssues() validation, cache, de-duplicated refresh()
lib/progress.js    saveProgress (merging), loadProgress, history, toMarkdown, mergeNotes
lib/score.js       weeklyScore (Jira done / PRs merged / PRs reviewed per week), doneOn(date), scoreSince
lib/dates.js       local-calendar helpers: localDate, addDays, weekStart (Monday), dateOf(iso)
lib/config.js      ~/.daily-dashboard/config.json with DEFAULTS; env overrides
lib/fsutil.js      writeFileAtomic (temp + rename), readJson
public/            index.html + main.js (dashboard), history.html + history.js (/history),
                   shared.js (helpers both import), styles.css, theme.js (pre-paint), icon.svg
install/           install.ps1 / uninstall.ps1 (Windows)
test/              node:test suites
```

## Conventions

- **ES modules**, `node:` imports, Node ≥ 20.11 (`import.meta.dirname`). No dependencies —
  don't add any without asking; use built-ins (`node:test`, `fetch`, `node:http`).
- **Front end has no inline script or style.** The server sends a strict CSP
  (`script-src 'self'; style-src 'self'`): put code in `public/main.js`, styles in
  `public/styles.css`; never add `onclick=`/`style=` attributes or `<script>` blocks.
  New static files must be added to `STATIC` in `lib/server.js`.
- **Escape everything** rendered with `innerHTML` through `esc()` in `main.js`.
- **Colors are theme tokens** (`--bg`, `--surface`, `--accent`, `--good/warn/bad/info` + `-bg`).
  A new theme = one `:root[data-theme="x"]` block in `styles.css` + an `<option>` in `index.html`.
- **File writes** that matter go through `writeFileAtomic`.
- Keep `README.md` (user-facing) and this file in sync with behavior changes.

## API contract (used by the page and by `dd.js`)

| Endpoint | Notes |
|---|---|
| `GET /api/ping` | must return `{"app":"daily-dashboard"}` — single-instance detection and `dd.js` rely on it |
| `GET /api/data` | read-only: `github{login,mine[],toReview[],closed[],reviewed[]}`, `githubError`, `githubFetchedAt`, `jira[]` (open), `jiraDone[]`, `jiraStatus{running,error,fetchedAt,source}`, `score{since,weeks[{start,end,jiraDone,prsMerged,prsReviewed,total}],totals}` (current week first), `progressDir`, `today`, `todayNotes`, `todayEntries`, `previous{date,notes,entries}` |
| `POST /api/refresh` | starts a Jira refresh (runs Claude), refetches GitHub, returns the same payload as `/api/data`. POST because it costs money |
| `GET /api/status` | `{ jiraStatus }` |
| `GET /api/history?days=N` | `{ progressDir, days: [{ date, savedAt, notes, entries, counts{jira,myPRs,toReview,done} }] }` (N ≤ 366) |
| `GET /api/day?date=YYYY-MM-DD` | one day in full: `{ date, savedAt, notes, entries, jira, github{login,mine,toReview}, done{jira,prs,reviewed} }` (`done` = finished *that day*); 404 if none, 400 on a bad date |
| `POST /api/save` `{notes}` | item notes; **merges**: sent keys replace, `""` deletes, unsent keys kept. Returns `{ date, files, notes, entries }` |
| `POST /api/entries` `{text}` | appends `{ id, at, text }` to today's log. Returns `{ entry, date, files, notes, entries }` |
| `POST /api/entries/delete` `{id}` | removes a log entry (400 if not found) |
| `POST /api/quit` | stops the app ~200 ms after replying |

`/api/data` also returns `todayEntries` and `previous.entries`.

A day has two kinds of notes: **entries** (the "Today's notes" log, appended, each with an id and
time) and **notes** (one per item). Note keys: `summary` (legacy daily summary, still accepted),
`jira:<KEY>`, `pr:<owner/repo>#<n>`, `review:<owner/repo>#<n>`.
Changing a field, key format or endpoint means updating `dd.js` and `SKILL.md` in udham-swe too.

## Security model (don't weaken)

- Listen on `127.0.0.1` only.
- Every request: `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard).
  A browser subresource/fetch request (`Sec-Fetch-Site` present and not `same-origin`/`none`)
  is refused unless it is a top-level navigation (`Sec-Fetch-Mode: navigate` +
  `Sec-Fetch-Dest: document`) — so other websites can't `<img>`/`fetch()` the API, but a link
  to the dashboard from anywhere still opens it. Non-browser clients (`dd.js`, tests) send no
  `Sec-Fetch-*` headers and pass.
- Every POST: `x-dd: 1` **and** `Origin` = the app's own origin (cross-site request guard).
  Clients outside the browser (`dd.js`, tests) set both explicitly.
- **Anything that costs money or changes state is a POST** (`/api/refresh` runs `claude -p`).
  Never add side effects to a GET.
- Config values that reach a command line, URL or prompt (`port`, `jira.site`, `jira.claudeModel`,
  `jira.tokenEnv`) are validated by `validateConfig`; `merge` skips `__proto__`-style keys.
- Jira URLs are built from the key (`normalizeIssues`), never copied from input; issues from
  `claude -p` **and from the on-disk cache** are validated before use. The page renders only
  `http(s)` links (`safeUrl`). `claude -p` runs with `--max-budget-usd 0.10`.
- 500 responses say only "internal error"; details go to the log, which strips control characters.
- `test/server.test.js` and `test/config.test.js` cover these — keep them passing.

## Gotchas

- **Jira via Claude**: `claude -p` is spawned with the prompt on **stdin** (on Windows `claude`
  is a `.cmd` shim run through `cmd.exe`, where free-text arguments break), `--allowedTools`
  limited to the Jira search tool, `--no-session-persistence`, cwd = temp dir, and
  `UDHAM_FLASH_DISABLE=1` so the user's "flash when done" Stop hook doesn't fire. One call runs
  two searches (`jira.jql` → open, `jira.doneJql` → done) and must answer `{"open":[],"done":[]}`;
  `normalizeResult` also accepts a bare array (old caches). ~20–30 s per call.
- **Score** is computed on every `/api/data` from `jiraDone` + `github.closed/reviewed`
  (`weeklyScore`, weeks start Monday, local dates). `collectGithub({ since })` is asked only for
  PRs closed/updated since the oldest week (paginated, `sort:updated-desc`, ≤ 500 each);
  `jira.doneJql` gets `{days}` = `scoreWeeks × 7 + 7` (a rolling window that always reaches the
  table's oldest Monday), and the server trims all three lists to `score.since`
  (`withinWindow`) so the lists and the table agree. A Jira issue counts on
  `statusCategoryChangedAt ?? resolved` (`doneDate`) — never on `updated`.
  The day file stores only what finished *that day* (`doneOn`), never the full lists; because
  that snapshot is taken at the day's last write, `/api/day` and `/api/history` top it up from
  live data for days still inside the window (`mergeDone`).
- `merge()` returns a `structuredClone` of the defaults — never hand out `DEFAULTS` sub-objects
  (an earlier `{ ...base }` let `loadConfig` mutate `DEFAULTS.jira`).
- **Notes have two writers** (the page and Claude). The page only sends notes edited in that
  browser (`dirty`), and the server merges. Don't change Save to send all boxes.
- Dates are **local** (`localDate()`), so the day's file matches the user's calendar.
- The launcher `~/.daily-dashboard/launch.vbs` hard-codes this repo's path and the node path;
  re-run `npm run install-shortcut` after moving the repo or changing Node.
- Logs: `~/.daily-dashboard/app.log`. Jira cache: `~/.daily-dashboard/jira-cache.json`.
