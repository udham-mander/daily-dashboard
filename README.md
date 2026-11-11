# Daily Dashboard

Your workday on one local page: open **Jira** issues and how long they've been in progress,
your **pull requests** and what each is still waiting on, the **PRs waiting for your review**,
and a place to keep **daily notes** — saved as Markdown in a folder you choose.

```
┌ Daily Dashboard ─────────────────────────── Auto ▾  ↻ Refresh  [Save today]  ⏻ Quit ┐
│ ┌ JIRA IN PROGRESS ┐ ┌ MY PULL REQUESTS ┐ ┌ NEEDS MY REVIEW ┐ ┌ TODAY'S NOTES ┐       │
│ │ 5                │ │ 1                │ │ 24              │ │ 0             │       │
│ │ 5 for 14+ days   │ │ draft in progress│ │ oldest 43 days  │ │ no summary yet│       │
│ └──────────────────┘ └──────────────────┘ └─────────────────┘ └───────────────┘       │
│ ▸ Today's summary                                                          empty       │
│ ▸ My Jira (9)                                   5 in progress · 5 for 14+ days         │
│ ▸ My pull requests (1)                                                    1 draft      │
│ ▸ Needs my review (24)                                         oldest open 43 days     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

## Features

- **My Jira** — status, time in progress (amber ≥ 7 days, red ≥ 14), and the PRs that mention the key
- **My pull requests** — what's pending: draft, merge conflicts, failing or running CI, changes
  requested, unresolved threads, behind base, waiting for reviewers, or ready to merge
- **Needs my review** — oldest first, with how long each has been open (amber ≥ 3 days, red ≥ 7)
- **Today's notes** — a running log: type what you did, decided or got blocked on and click
  **Add** (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>); each entry is saved instantly with its time and
  can be deleted. The section also lists today's notes on individual items
- **Notes on items** — a note box on every Jira issue and PR; **Save notes** stores them. The next
  day each box shows what you wrote last time
- **History page** (`/history`, or <kbd>H</kbd>) — every saved day with its notes, item notes and
  what was open that day; search across all days with <kbd>/</kbd>, move with <kbd>↑</kbd>/<kbd>↓</kbd>
- Everything is written to `YYYY-MM-DD.md` (readable) and `YYYY-MM-DD.json` in your progress folder
- Overview tiles, collapsible sections (closed on load), 8 themes (Auto, Light, Dark, Nord,
  Dracula, Solarized Light, Sepia, High contrast), keyboard shortcuts
- **Works with Claude**: the `udham-swe:daily-dashboard` skill starts the app, reads it, adds
  notes and acts on items (see [Using it from Claude](#using-it-from-claude))

## Requirements

- Windows 10/11 for the desktop icon (the app itself runs anywhere Node does)
- **Node.js 20.11+** — no npm packages to install
- **[GitHub CLI](https://cli.github.com/)**, signed in: `gh auth status`
- For Jira, either **Claude Code** signed in with the **Atlassian connector** (default, no
  token), or a **Jira API token** (see [Jira source](#jira-source))

## Install

```powershell
git clone https://github.com/udham-mander/daily-dashboard.git C:\Workspace\github\daily-dashboard
cd C:\Workspace\github\daily-dashboard
npm run install-shortcut
```

You get a **Daily Dashboard** icon on the desktop. Start it once, then tell it your Jira site:
open `~/.daily-dashboard/config.json`, set `"jira": { "site": "your-company.atlassian.net" }`
and start the app again (until then the page shows a reminder and GitHub data only).

## Use

| To… | Do |
|---|---|
| Start | Double-click the desktop icon. It runs in the background (no console window) and opens `http://127.0.0.1:4317` |
| Reopen the page | Click the icon again — it reuses the running app |
| Run in a terminal | `npm start` (or `node app.js --no-open`); logs stay in the terminal |
| Refresh | **↻ Refresh** or <kbd>R</kbd>. GitHub is instant; Jira takes ~20 s and fills in when ready |
| Log a note | <kbd>N</kbd> (or open **Today's notes**), type, then **Add** / <kbd>Ctrl</kbd>+<kbd>Enter</kbd> — saved immediately |
| Save notes on items | **Save notes** or <kbd>Ctrl</kbd>+<kbd>S</kbd>. Unsaved item notes are kept in the browser until you save |
| See previous days | **History** in the header or <kbd>H</kbd>; <kbd>Esc</kbd> goes back |
| Expand / collapse all | <kbd>E</kbd> / <kbd>C</kbd>, or click a tile to jump to its section |
| **Stop** | **⏻ Quit** on the page · <kbd>Ctrl</kbd>+<kbd>C</kbd> if started in a terminal |

Progress files go to `~/daily-progress` by default:

```markdown
# Daily progress — 2026-11-11
## Notes
- 09:40 — Reviewed api#101, left 3 comments
- 14:05 — CSV export working locally
## Jira (4)
- [PROJ-123](…) Add CSV export to reports — **In Progress**, in progress 6 days
  - Note: waiting on the schema change
```

## Using it from Claude

With the `udham-swe` plugin installed, just ask Claude Code:

- "What's on my plate today?" · "Give me my standup" · "What did I note this week?"
- "Which reviews have waited longest? Review the oldest one."
- "Add a note on PROJ-123: blocked on the schema change" · "Log that I finished the api review"

The skill starts the app if needed (without opening a browser), reads it, and saves notes that
appear on the page. It asks before anything others would see (PR approvals or comments, marking
ready, Jira comments or transitions).

## Configuration

`~/.daily-dashboard/config.json` is created on first start. Restart the app after editing it.

| Setting | Default | Meaning |
|---|---|---|
| `port` | `4317` | Local port (127.0.0.1 only) |
| `progressDir` | `~/daily-progress` | Where notes are saved |
| `openBrowser` | `true` | Open the page on start |
| `githubCacheSeconds` | `120` | Reuse GitHub data between page loads |
| `jira.site` | *(empty — required)* | Your Jira site, e.g. `your-company.atlassian.net` |
| `jira.jql` | open issues assigned to you | Which issues to show |
| `jira.refreshMinutes` | `60` | Background Jira refresh (`0` = only on Refresh) |
| `jira.mode` | `claude` | `claude` or `token` |
| `jira.claudeModel` | `haiku` | Model for the headless Claude call |
| `jira.email` / `jira.tokenEnv` | `""` / `JIRA_API_TOKEN` | Token mode only |

### Jira source

- **`claude`** (default) — runs `claude -p` headless with the Atlassian connector, allowed to use
  only the Jira search tool. ~20 s and about $0.01 per refresh with Haiku (counts toward plan usage
  on a subscription). Results are validated; if a refresh fails, the last good data stays on screen.
- **`token`** — create a token at id.atlassian.com → Security → API tokens, set
  `"jira": { "mode": "token", "email": "you@company.com" }`, and put the token in the
  `JIRA_API_TOKEN` environment variable. No Claude call.

## Privacy & security

Everything stays on your machine: the app listens on `127.0.0.1` only, talks to GitHub through
your `gh` login and to Jira through Claude Code or your token, and writes only to your progress
folder and `~/.daily-dashboard`. Its API refuses requests from other websites (Host and Origin
checks) and the page runs under a strict Content-Security-Policy.

## Troubleshooting

| Problem | Fix |
|---|---|
| Icon does nothing | Check `~/.daily-dashboard/app.log`; run `npm start` in a terminal to see errors |
| "port 4317 is in use" | Set another `port` in the config |
| GitHub error banner | `gh auth status` / `gh auth login` |
| Jira error banner | Make sure `claude` works and the Atlassian connector is connected, or switch to token mode |
| Moved the repo or updated Node | Run `npm run install-shortcut` again |

## Uninstall

```powershell
npm run uninstall-shortcut
```

Stops the app and removes the icon, launcher and app icon. Your config and progress files stay.

## Development

```bash
npm test        # unit + API tests (no network)
npm run dev     # restart on file changes
```

See [CLAUDE.md](CLAUDE.md) for architecture, the API contract and conventions.

## License

[MIT](LICENSE).
