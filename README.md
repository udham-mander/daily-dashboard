# Daily Dashboard

Your workday on one local page: open **Jira** issues and how long they've been in progress,
your **pull requests** and what each is still waiting on, the **PRs waiting for your review**,
your **score** week by week, and **daily notes** — yours, and the ones an **Activity agent**
writes from what you actually did, with its take on what deserves attention today. Everything
is saved as Markdown in a folder you choose.

```
┌ Daily activity dashboard ───── History  Auto ▾  [Launch Claude ▾]  ↻ Refresh  [Save notes]  ⏻ Quit ┐
│ ┌ JIRA IN PROGRESS ┐ ┌ MY PULL REQUESTS ┐ ┌ NEEDS MY REVIEW ┐ ┌ TODAY'S NOTES ┐ ┌ THIS WEEK ┐      │
│ │ 5                │ │ 1                │ │ 24              │ │ 6             │ │ 3         │      │
│ │ 5 for 14+ days   │ │ draft in progress│ │ oldest 43 days  │ │ 4 by the agent│ │ 1 · 1 · 1 │      │
│ └──────────────────┘ └──────────────────┘ └─────────────────┘ └───────────────┘ └───────────┘      │
│ ┃ AGENT'S TAKE · 10:12                                                         2 blacklisted       │
│ ┃ 1. dbms#11 has waited 43 days for your review — oldest in your queue                        ×    │
│ ┃ 2. MAYA-26 in progress 86 days with no PR — split it or move it on                          ×    │
│ ┃ 3. Your week trails last week (1 vs 4 done) — one review would close the gap                ×    │
│ ▸ Today's notes (6)        last at 09:40 · 4 by the agent      Activity agent · On   [+ Add]       │
│ ▸ My Jira (9)                                    5 in progress · 5 for 14+ days                    │
│ ▸ My pull requests (1)                                                    1 draft                  │
│ ▸ Needs my review (24)                                        oldest open 43 days                  │
│ ▸ Done & score (37)                   this week: 1 Jira · 1 merged · 1 reviewed                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Features

- **My Jira** — status, time in progress (amber ≥ 7 days, red ≥ 14), and the PRs that mention the key
- **My pull requests** — what's pending: draft, merge conflicts, failing or running CI, changes
  requested, unresolved threads, behind base, waiting for reviewers, or ready to merge
- **Needs my review** — oldest first, with how long each has been open (amber ≥ 3 days, red ≥ 7)
- **Done & score** — your score, week by week: Jira issues moved to Done, PRs merged and PRs
  reviewed over the last 8 weeks (a table, this week highlighted), followed by the finished items
  themselves. A tile shows this week's total. Each day's log also records what was finished that day
- **Launch Claude** — one click opens a new Claude Code session in a terminal, in your default
  folder; the caret next to it offers the 5 folders you used most recently, or any other folder
- **Today's notes** — one list, newest first. Click **Add** (or press <kbd>N</kbd>), type what you
  did, decided or got blocked on, and confirm with **Add** or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>; each
  entry is saved instantly with its time and can be deleted. The section also lists today's notes
  on individual items
- **Activity agent** — the automatic side of the app, with an **On/Off switch** in the Today's
  notes header (on by default, remembered in the config). While on, every 2 hours within work
  hours it adds **automatic points** to the same list, marked with a small robot icon instead of
  a time: bullets that say *what* was done, not just that something happened. It reads the PR
  descriptions, your commits of the day, the review comments and comments you wrote, and (via
  Claude's Atlassian connector) the Jira issues you touched, then asks Claude to write the log
  (`auto.useClaude: false` lists the plain activity instead). The points are never mixed into
  your own entries; `dd.js auto` rebuilds them on demand
- **Agent's take** — a card under the tiles where the agent gives its judgement: it looks at
  everything that is open (reviews others wait on, your blocked PRs, Jira in progress for weeks,
  how the week compares) and lists up to five things it thinks deserve your attention today,
  most important first, with the keys and PRs linked. Each point has a **×**: cross off what is
  not important and the item it names (or, if it names none, its wording) goes on a **blacklist**
  the agent respects from then on — it is told what you crossed off and anything about it is
  filtered out anyway. The card shows how many are blacklisted; click that to see them and put
  any back (`auto.nudges: false` keeps the points but drops the take)
- **Saves itself at 5 pm** — at `auto.saveAt` the agent refreshes GitHub and Jira and writes the
  day's file with fresh data, whether or not you pressed anything. When you start it the next
  morning (or it runs past midnight) it tops up **yesterday's** automatic points with whatever
  came after that save, so late work is not lost
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
| Log a note | **Add** in the Today's notes header (or <kbd>N</kbd>), type, then **Add** / <kbd>Ctrl</kbd>+<kbd>Enter</kbd> — saved immediately; <kbd>Esc</kbd> closes the box |
| Activity agent | The **Activity agent** switch in the Today's notes header (or `dd.js agent on\|off`). On: automatic points appear in the same list every 2 h (robot icon; `dd.js auto` rebuilds them), the take is shown, the day is saved at 17:00. Off: nothing is written or saved on its own |
| Agent's take | **×** on a point crosses it off and blacklists what it names; **n blacklisted** in the card opens the list and puts one back (or `dd.js blacklist`) |
| Save notes on items | **Save notes** or <kbd>Ctrl</kbd>+<kbd>S</kbd>. Unsaved item notes are kept in the browser until you save |
| Start a Claude session | **Launch Claude** or <kbd>L</kbd> opens a new terminal running `claude` in your default folder; the **▾** caret lists recent folders and takes any other path |
| See previous days | **History** in the header or <kbd>H</kbd>; <kbd>Esc</kbd> goes back |
| Expand / collapse all | <kbd>E</kbd> / <kbd>C</kbd>, or click a tile to jump to its section |
| **Stop** | **⏻ Quit** on the page · <kbd>Ctrl</kbd>+<kbd>C</kbd> if started in a terminal |

Progress files go to `~/daily-progress` by default:

```markdown
# Daily progress — 2026-11-11
## Notes
- 09:40 — Reviewed api#101, left 3 comments
- 14:05 — CSV export working locally
## Automatic (updated 14:00)
- Merged dbms#63 (DSM-7528) and pushed 3 commits to ai-shield:feature/MAYA-73-file-support
- Reviewed dbms#81 (approved)
## Jira (4)
- [PROJ-123](…) Add CSV export to reports — **In Progress**, in progress 6 days
  - Note: waiting on the schema change
```

## Using it from Claude

With the `udham-swe` plugin installed, just ask Claude Code:

- "What's on my plate today?" · "Give me my standup" · "What did I note this week?"
- "How did we do this month?" · "What did I finish last week?" (the weekly score)
- "Which reviews have waited longest? Review the oldest one."
- "Add a note on PROJ-123: blocked on the schema change" · "Log that I finished the api review"
- "Open a new Claude session in the api repo" · "Rebuild today's automatic points"
- "Stop reminding me about dbms#11" (goes on the agent's blacklist) · "What did I blacklist?"

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
| `scoreWeeks` | `8` | Weeks in the score table (this week + the previous ones) |
| `jira.site` | *(empty — required)* | Your Jira site, e.g. `your-company.atlassian.net` |
| `jira.jql` | open issues assigned to you | Which issues to show |
| `jira.doneJql` | issues you moved to Done recently | Finished issues for the score; `{days}` is filled in from `scoreWeeks` (×7, plus a week of slack); `""` turns it off |
| `jira.refreshMinutes` | `60` | Background Jira refresh (`0` = only on Refresh) |
| `jira.mode` | `claude` | `claude` or `token` |
| `jira.claudeModel` | `haiku` | Model for the headless Claude call |
| `jira.email` / `jira.tokenEnv` | `""` / `JIRA_API_TOKEN` | Token mode only |
| `claude.defaultDir` | your home folder | Where **Launch Claude** opens a new session (`~` allowed) |
| `claude.command` | `claude` | What the new terminal runs (e.g. `claude --model opus`) |
| `auto.enabled` | `true` | Automatic points on/off |
| `auto.intervalMinutes` | `120` | How often they are rebuilt |
| `auto.workHours` | `"07:00-20:00"` | Only within these hours (your computer's clock) |
| `auto.saveAt` | `"17:00"` | End-of-day save with fresh data (`""` = off); runs once between that time and the end of `workHours`, even if the app was started late. Started after work hours? The next morning's top-up covers it |
| `auto.catchupDays` | `1` | On start and after midnight, top up the previous N days' automatic points (once per day) |
| `auto.useClaude` | `null` = same as the Jira source | Summarize with headless Claude (`false` = plain activity lines, no Claude call; token-mode installs default to `false`) |
| `auto.nudges` | `true` | The agent's take (needs `useClaude`) |
| `auto.model` | `haiku` | Model for the summary |

### Activity agent

The agent reads your own GitHub event feed (`gh api users/<you>/events`: pushes, PRs opened,
merged or closed, reviews, comments) and the Jira issues that moved or were finished that day.
For each PR and branch involved it then fetches the details of *your* work that day (PR
description, your commits, your review comments and comments, clipped) and asks Claude for 3–8
past-tense bullets plus, for today, the agent's take on the current state (`claude -p`, about
$0.01–0.03 with Haiku, capped at $0.15). The only tool that call may use is reading the Jira
issues named in the activity through the Atlassian connector; every built-in tool is denied. If
Claude is unavailable the plain activity lines are shown instead, with a note. Nothing is
written on a day with no activity, and your own notes are never edited.

What you cross off the take is kept in `~/.daily-dashboard/blacklist.json` (the items a point
named — Jira keys, `repo#n` — or its wording when it named none). Later takes leave those out:
the prompt lists them, and the app filters whatever still comes back. Put one back from the card,
with `dd.js blacklist remove <id or item>`, or by deleting its line in that file.

**Launch Claude** opens a new Windows Terminal tab (or a console window) running PowerShell with
that command, in the chosen folder; on macOS it uses Terminal.app, on Linux the first terminal
emulator found. Recent folders are kept in `~/.daily-dashboard/recent-dirs.json`.

### Jira source

- **`claude`** (default) — runs `claude -p` headless with the Atlassian connector, allowed to use
  only the Jira search tool; one call runs both searches (open and done). ~20–30 s and about $0.01
  per refresh with Haiku (counts toward plan usage on a subscription). Results are validated; if a
  refresh fails, the last good data stays on screen.
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
