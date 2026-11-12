# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

My workday assistant: a local web app (Node, **no npm dependencies**) showing the user's open Jira
issues, their GitHub PRs with what each is waiting on, PRs awaiting their review, and daily
notes saved to a folder. It runs on `127.0.0.1` only and is started from a Windows desktop icon.

A Claude skill drives it over its HTTP API: `udham-swe:my-workday-assistant` (repo
`udham-mander/udham-swe`, files `skills/my-workday-assistant/SKILL.md` and `mwa.js`).
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
MY_WORKDAY_ASSISTANT_PORT=4399 MY_WORKDAY_ASSISTANT_PROGRESS_DIR=/tmp/mwa-test node app.js --no-open
```

Stop the real instance: the page's Quit button, or `POST /api/quit` (see API), or
`node <udham-swe>/skills/my-workday-assistant/mwa.js quit`.

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
lib/launch.js      "Launch Claude": terminalCommand() per platform, createLauncher() (validates the
                   folder, spawns detached, keeps ~/.my-workday-assistant/recent-dirs.json, 5 entries)
lib/claude.js      runClaude(prompt, {model, maxBudgetUsd, allowedTools}): headless `claude -p` (stdin prompt);
                   spawnEnv() puts the app's own node folder first on PATH (the claude shim lives there)
lib/sessions.js    Claude Code sessions from ~/.claude (or CLAUDE_CONFIG_DIR; read only): parseLive
                   (sessions/<pid>.json + a live-process check), sessionsFromHistory (history.jsonl,
                   per local day), readTitle (transcript tail: custom-title > ai-title, cached per
                   file), collectSessions(date) → { live, day, errors }, sessionActivity /
                   sessionDetails (activity lines + prompt material), compactSessions (what a day
                   stores) / withoutPrompts (what the API sends)
lib/activity.js    what the user did on a day: activityFromEvents (GitHub event feed, grouped),
                   activityFromJira (moved/finished/updated), collectActivity (pages the feed, adds
                   the day's Claude sessions)
lib/details.js     what was done behind the activity: one aliased GraphQL query for the PRs touched
                   (own commits/review comments/comments that day; the PR description labelled
                   "Background" unless it is the user's own PR opened that day) + commits per
                   pushed branch; clipped prompt text
lib/auto.js        automatic notes: stateSummary (open work + score as text), summaryPrompt,
                   parseAnswer ({points, nudges}), buildAuto (Claude or plain lines), plan() (pure
                   timing rules), createAutoNotes() (update(date), minute tick, status)
lib/blacklist.js   the agent's blacklist (what the user crossed off the take): refsIn, matches,
                   filterNudges, createBlacklist() over ~/.my-workday-assistant/blacklist.json
lib/config.js      ~/.my-workday-assistant/config.json with DEFAULTS; env overrides
lib/fsutil.js      writeFileAtomic (temp + rename), readJson
public/            index.html + main.js (main page), history.html + history.js (/history),
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

## API contract (used by the page and by `mwa.js`)

| Endpoint | Notes |
|---|---|
| `GET /api/ping` | must return `{"app":"my-workday-assistant"}` — single-instance detection and `mwa.js` rely on it |
| `GET /api/data` | read-only: `github{login,mine[],toReview[],closed[],reviewed[]}`, `githubError`, `githubFetchedAt`, `jira[]` (open), `jiraDone[]`, `jiraStatus{running,error,fetchedAt,source}`, `score{since,weeks[{start,end,jiraDone,prsMerged,prsReviewed,total}],totals}` (current week first), `progressDir`, `today`, `todayNotes`, `todayEntries`, `previous{date,notes,entries}`, `sessions{live[{id,pid,dir,folder,status,startedAt,lastActivityAt,name,title}],today[{id,title,dir,folder,startedOn,first,last,prompts,live}],errors[]}` (Claude Code sessions running now / worked in today, most recent first; never the prompts; `null` when no collector is injected) |
| `POST /api/refresh` | starts a Jira refresh (runs Claude), refetches GitHub, returns the same payload as `/api/data`. POST because it costs money |
| `GET /api/status` | `{ jiraStatus, autoStatus }` — cheap (no GitHub refresh); `mwa.js` reads the agent's switch and blacklist from here |
| `GET /api/history?days=N` | `{ progressDir, days: [{ date, savedAt, notes, entries, counts{jira,myPRs,toReview,done} }] }` (N ≤ 366) |
| `GET /api/day?date=YYYY-MM-DD` | one day in full: `{ date, savedAt, notes, entries, jira, github{login,mine,toReview}, done{jira,prs,reviewed} }` (`done` = finished *that day*); 404 if none, 400 on a bad date |
| `POST /api/save` `{notes}` | item notes; **merges**: sent keys replace, `""` deletes, unsent keys kept. Returns `{ date, files, notes, entries }` |
| `POST /api/entries` `{text}` | appends `{ id, at, text }` to today's log. Returns `{ entry, date, files, notes, entries }` |
| `POST /api/entries/delete` `{id}` | removes a log entry (400 if not found) |
| `POST /api/auto` `{date?}` | rebuilds the automatic points for today (or `date`): GitHub events + Jira changes → Claude summary. Returns `{ date, auto, autoStatus }`; `auto` is null when nothing was recorded. 404 when the feature is off |
| `POST /api/agent` `{enabled}` | the Activity agent switch: starts/stops the scheduler at runtime and writes `auto.enabled` to the config file (`saveSetting`). Returns `{ autoStatus }`; 400 unless a boolean, 404 when the feature is off |
| `POST /api/blacklist/add` `{text}` | crosses a nudge off the agent's take: the items it names (Jira keys, `repo#n`) or, naming none, its wording go on the blacklist, and today's `auto.nudges` loses everything the blacklist now covers. Returns `{ entry{id,refs,text,date,points[{index,text}],at}, added, auto, autoStatus }` (`added` false = an entry already covered it; `points` = what it took out of today's take, the clicked nudge and any sibling naming the same item); 400 unless a non-empty string ≤ 300 chars, 404 when the agent is off or no blacklist is wired |
| `POST /api/blacklist/remove` `{id}` or `{text}` | takes entries off the blacklist: the one with `id`, or every one covering `text` (an item such as `dbms#11` in any spelling, or a wording — matched by the app). The points an entry took out of today's take go back to their places (newest cross-off first, so stacked undos line up). Returns `{ entry, removed, auto, autoStatus }`; 400 when nothing matched or neither field is a string |
| `POST /api/launch` `{dir?, resume?}` | opens a new terminal running Claude in `dir` (absolute, must exist) or in `claude.defaultDir`; with `resume` (a session id — a UUID, nothing else) the terminal runs `<claude.command> --resume <id>` there instead. Returns `{ ok, dir, resume, defaultDir, command, recent[] }`. 400 for a bad folder or id, 404 when no launcher is injected. `/api/data` carries the same `claude{defaultDir,command,recent}` |
| `POST /api/quit` | stops the app ~200 ms after replying |

`/api/data` also returns `todayEntries`, `todayAuto`,
`autoStatus{enabled,running,intervalMinutes,workHours,saveAt,catchupDays,useClaude,nudges,lastRun,error,blacklist[]}`
(`blacklist` = the entries above, oldest first) and `previous.{entries,auto}`; `/api/day` and
`/api/history` days carry `auto` too.

A day has three kinds of notes: **entries** (the "Today's notes" log, appended, each with an id and
time), **notes** (one per item) and **auto** (`{ updatedAt, source: "claude"|"activity", points[],
nudges[], activity[], sessions[], errors[], eodSavedAt, catchupAt }`, written only by the app — never merged
into entries/notes; `nudges` = the agent's take, today only; `sessions` = the Claude Code sessions
worked in that day, `{ id, title, dir, folder, startedOn, first, last, prompts }` each (no prompt
text, no live state); `eodSavedAt` = the end-of-day save
ran, `catchupAt` = the next-day top-up ran). `autoStatus` also carries `nudges` (on/off). Note keys:
`summary` (legacy daily summary, still accepted), `jira:<KEY>`, `pr:<owner/repo>#<n>`, `review:<owner/repo>#<n>`.
Changing a field, key format or endpoint means updating `mwa.js` and `SKILL.md` in udham-swe too.

## Security model (don't weaken)

- Listen on `127.0.0.1` only.
- Every request: `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard).
  A browser subresource/fetch request (`Sec-Fetch-Site` present and not `same-origin`/`none`)
  is refused unless it is a top-level navigation (`Sec-Fetch-Mode: navigate` +
  `Sec-Fetch-Dest: document`) — so other websites can't `<img>`/`fetch()` the API, but a link
  to the app from anywhere still opens it. Non-browser clients (`mwa.js`, tests) send no
  `Sec-Fetch-*` headers and pass.
- Every POST: `x-mwa: 1` **and** `Origin` = the app's own origin (cross-site request guard).
  Clients outside the browser (`mwa.js`, tests) set both explicitly.
- **Anything that costs money or changes state is a POST** (`/api/refresh` runs `claude -p`).
  Never add side effects to a GET.
- Config values that reach a command line, URL or prompt (`port`, `jira.site`, `jira.claudeModel`,
  `jira.tokenEnv`) are validated by `validateConfig`; `merge` skips `__proto__`-style keys.
- Jira URLs are built from the key (`normalizeIssues`), never copied from input; issues from
  `claude -p` **and from the on-disk cache** are validated before use. The page renders only
  `http(s)` links (`safeUrl`). `claude -p` runs with `--max-budget-usd 0.10`.
- **Headless Claude** (`lib/claude.js`) always denies every built-in tool
  (`--disallowedTools` with `BUILTIN_DENY`; the permission system enforces it even in `-p` mode)
  and either allows exactly the MCP tools listed in `allowedTools` (Jira fetch: the search tool;
  the summary: `getJiraIssue`, only when the day touched Jira keys and `jira.site` is set) or,
  with none, adds `--tools ""` + `--strict-mcp-config` (no tools, no MCP servers).
  The prompts carry text written by others (PR titles, commit messages, issue summaries) as data;
  the model must have nothing to act with. Do **not** pass `--tools ""` together with MCP tools:
  in Claude Code 2.1 it hides the MCP tools too (the Jira fetch then answers with a tool call as
  text). `--allowedTools` alone would *not* remove tools either.
- **Automatic notes**: the prompt carries the activity lines, the details behind them
  (`collectDetails`: the user's own commits/review comments/comments that day, commits per pushed
  branch, and the PR description marked **Background** with its author and date — all clipped)
  and, for today, `stateSummary`. The prompt says only the activity and the "Your …" lines are
  that day's work; background (PR descriptions by others, Jira descriptions and older comments)
  only describes the item. Without that, a comment on someone's PR produced points claiming
  *their* PR contents as the user's work, and a Jira transition produced points from the issue's
  old comments. The stored `activity` of a day is the ground truth for what its points may claim (open Jira with days
  and PRs, own PRs with what they wait on, oldest reviews waiting, this week vs last); it asks
  for `{"points": [...], "nudges": [...]}` (`parseAnswer`; a bare array is accepted). Cap $0.15.
  On failure the plain lines are shown and `nudges` is empty. The **blacklist** is enforced in
  two layers: the prompt names the crossed-off items (`avoid`, text from the user's own file) and
  `filterNudges` drops whatever still names them — in `buildAuto` and again right before the
  write, so a cross-off during a build cannot come back. Nudges and entries are rendered through
  `esc()`; the text accepted by `/api/blacklist/add` is a string of ≤ 300 chars, nothing else.
  `dismiss`/`restore` write today's `auto.nudges` immediately (not through the rebuild queue, so
  a click never waits 30 s on Claude); a rebuild that finishes afterwards replaces the take
  wholesale, as any rebuild does — the blacklist file is the state that lasts. The reference
  regex lives in `blacklist.js` (`REF_RE`) and `main.js` (`linkRefs`) in the same shape: change
  both. Any upper-case `TOKEN-123` counts as a key (SHA-256 included); the entry is visible on the
  page and can be put back. `createBlacklist` caches the file and re-reads it on an mtime change. The scheduler only ever *writes the
  day's `auto` field*; it never touches `entries`/`notes`. A quiet day writes no file; a day with
  no activity is retried only after the interval (`state.tried[date]`), so GitHub is not polled
  every minute. When GitHub fails (or the ~300-event feed no longer reaches the day) an existing
  richer record is kept rather than overwritten. `auto.useClaude` defaults to
  `jira.mode === "claude"`, so token-mode installs never spawn `claude`.
- **Claude sessions** come from Claude Code's own files (`~/.claude`, or `CLAUDE_CONFIG_DIR`),
  read and never written: `sessions/<pid>.json` (running sessions), `history.jsonl` (one line per
  prompt) and the last 512 KB of a transcript (its title). A session counts as running only if
  its pid exists *and* names a claude/node process (one `tasklist`/`ps` listing per minute,
  cached): a crashed session or a closed terminal leaves its registry file behind and the OS
  reuses pids. Headless `claude -p` runs register too while they run, with entrypoint `sdk-cli`
  (the app's own Jira refresh and summary calls among them): those are skipped. The prompts of the day's sessions go into the summary prompt as data (first two
  and last six per session, 140 chars each); the stored day (`compactSessions`) and the API
  (`withoutPrompts`) never carry prompt text, and the stored day keeps no live state either
  (it is about now). Titles and folders are rendered through `esc()`. The keep-the-richer-record
  guard in `auto.js` counts GitHub/Jira items only: sessions are found from local files even when
  GitHub is down and must not make a GitHub-less rebuild look richer. `collectSessions` is
  injected (`app.js`); without it the feature is off and tests never read the real `~/.claude`.
- **Launching Claude** spawns a terminal: the folder must be absolute and an existing directory,
  and may not contain shell/cmd metacharacters (`" & | < > ^ % ! \` $ ;` or control chars) — it is
  refused, not escaped. The process is spawned with an argument array (no `shell: true`); on
  Windows that is `wt.exe -d <dir> powershell.exe -NoExit -Command <claude.command>`.
  `claude.command` comes from the user's own config only, never from a request. A **resume**
  adds ` --resume <id>` to that command: the id must match `SESSION_ID_RE` (a UUID) or the
  request is refused with 400.
- **Headless `claude`** is resolved through PATH (cmd.exe on Windows). The desktop launcher
  starts the app with the machine's PATH, which may lack the folder `claude` was installed in,
  so `spawnEnv()` puts the folder of the app's own node first (npm puts the `claude` shim next
  to `node.exe`). Without that, every Jira refresh and summary failed with "'claude' is not
  recognized" whenever the app was started from the icon.
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
- **Scheduler wiring** (`app.js`): `createAutoNotes` reads the server's window-trimmed data
  through closures (`server.finished()`, `server.refreshGithub`) and starts after the first data
  load; the timer is `unref`'d. `plan()` is pure — put new timing rules there and test them in
  `test/auto.test.js`. Rules, in order, evaluated every minute: (1) *catch-up* of the previous
  `catchupDays` days, once per calendar day (the stored `auto.catchupAt`, or the in-memory
  `catchupDone` for a day that stores nothing; a failed attempt retries after the interval);
  (2) *end of day* between `saveAt` and the end of work hours, once (`auto.eodSavedAt` /
  `eodDone`; failures retry after the interval; later than work hours it is left to the next
  morning's catch-up), with a forced GitHub refresh and a Jira refresh if older than 30 min;
  (3) otherwise the periodic build in work hours. When a tick has several actions the event feed
  is downloaded once (`fetchFeedUntil`) and shared. Writes to a **past day keep its stored
  Jira/PR snapshot** (`keepSnapshot`) — only `auto` and `done` change. Marks survive later
  rebuilds. Times are the computer's local clock.
- `merge()` returns a `structuredClone` of the defaults — never hand out `DEFAULTS` sub-objects
  (an earlier `{ ...base }` let `loadConfig` mutate `DEFAULTS.jira`).
- **Notes have two writers** (the page and Claude). The page only sends notes edited in that
  browser (`dirty`), and the server merges. Don't change Save to send all boxes.
- Dates are **local** (`localDate()`), so the day's file matches the user's calendar. GitHub
  search date qualifiers are UTC, so `collectGithub` asks from one day before `since` and the
  server trims (`withinWindow`). Each `jiraDone` item carries `doneAt` — clients use that, never
  `statusCategoryChangedAt ?? resolved` themselves.
- Folder settings (`progressDir`, `claude.defaultDir`) accept `~`; a relative path is resolved
  from the home folder; validation then requires an absolute path.
- **Environment inheritance**: the app is often started from inside a Claude Code session (the
  skill's `mwa.js ensure`), whose per-session markers (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_SESSION_ID`, …) would otherwise reach every terminal the app launches and make the
  new `claude` think it is a child session ("Transcript saving is off"). `mwa.js` strips them when
  starting the app and `spawnDetached` strips them again (`cleanEnv`, `SESSION_MARKERS`);
  user settings like `CLAUDE_CODE_GIT_BASH_PATH` are kept.
- The launcher `~/.my-workday-assistant/launch.vbs` hard-codes this repo's path and the node path;
  re-run `npm run install-shortcut` after moving the repo or changing Node.
- Logs: `~/.my-workday-assistant/app.log`. Jira cache: `~/.my-workday-assistant/jira-cache.json`.
