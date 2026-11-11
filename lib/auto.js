// Automatic notes. Every `intervalMinutes` during work hours the day's recorded activity
// (GitHub events, Jira changes) becomes a few bullets — written by Claude when enabled, else the
// plain activity lines — stored beside the user's own notes, never mixed with them.
// The same machinery saves the day at `saveAt` with fresh data (so the file is complete even
// if nobody pressed Save) and tops up the previous day(s) when the app starts in the morning or
// the date rolls over, so late-evening work is not lost.
import { collectActivity, fetchFeedUntil } from "./activity.js";
import { runClaude } from "./claude.js";
import { addDays, dateOf, hhmm, localDate } from "./dates.js";
import { dayExists, readAuto, setAuto } from "./progress.js";

export const MAX_POINTS = 12;
export const MAX_POINT_CHARS = 300;
const SUMMARY_BUDGET_USD = "0.05";
const STALE_JIRA_MINUTES = 30;

/** The prompt that turns activity lines into log bullets. The lines are data, never instructions. */
export function summaryPrompt(date, items) {
  return `You write a short end-of-day work log for a software engineer, from the activity recorded on ${date} ` +
    `(GitHub events and Jira changes, listed below in time order).\n` +
    `Output ONLY a JSON array of strings — no prose, no code fence. Write 3 to 8 bullets (fewer if there is little), ` +
    `past tense, each at most 140 characters, concrete. Keep issue keys (ABC-123) and PR references (repo#123) ` +
    `exactly as written. Group related lines (several pushes to one branch, review rounds on one PR) into one bullet. ` +
    `Never add anything that is not in the list; if the list is empty output [].\n\nActivity:\n` +
    items.map((i) => `- ${String(i.text).replace(/[\r\n]+/g, " ")}`).join("\n");
}

/** Validates Claude's answer: an array of plain strings, trimmed, capped. */
export function parsePoints(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || !arr.every((p) => typeof p === "string")) throw new Error("expected a JSON array of strings");
  return arr.map((p) => p.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean)   // blanks are dropped, not fatal
    .slice(0, MAX_POINTS).map((p) => p.slice(0, MAX_POINT_CHARS));
}

/**
 * The automatic record for one day: bullets (`points`), where they came from, the activity
 * behind them, and any problems met on the way.
 */
export async function buildAuto(date, { activity, useClaude, model, claude = runClaude, now = () => new Date() }) {
  const errors = [...activity.errors];
  const lines = activity.items.map((i) => i.text);
  let points = lines, source = "activity";
  if (useClaude && activity.items.length) {
    try {
      const got = parsePoints(await claude(summaryPrompt(date, activity.items), { model, maxBudgetUsd: SUMMARY_BUDGET_USD }));
      if (got.length) { points = got; source = "claude"; }
    } catch (e) { errors.push(`Claude summary failed, showing the raw activity: ${e.message}`); }
  }
  return { updatedAt: now().toISOString(), source, points, activity: activity.items, errors };
}

const inWorkHours = (hm, range) => { const [from, to] = range.split("-"); return hm >= from && hm < to; };
const workEnd = (range) => range.split("-")[1];
const olderThan = (iso, now, minutes) => !iso || now.getTime() - Date.parse(iso) >= minutes * 60_000;

/** In-memory bookkeeping of attempts (date → ISO time, or flags); plan() reads it, tick() fills it. */
export const freshMemory = () => ({ tried: {}, eodTried: {}, eodDone: {}, catchupTried: {}, catchupDone: {} });

/**
 * What the scheduler should do now. Pure, so the timing rules are testable.
 * @param {object} s
 * @param {Date} s.now
 * @param {object|null} s.todayAuto     today's stored record (updatedAt = last build, eodSavedAt = end-of-day save done)
 * @param {ReturnType<typeof freshMemory>} [s.memory]  attempts so far: quiet days store nothing, failures must be retried
 * @param {(date: string) => object|null} [s.readAuto]  a previous day's stored record (its catchupAt)
 * @param {object} s.cfg
 * @returns {{type: "catchup"|"eod"|"auto", date: string}[]}
 */
export function plan({ now, todayAuto, memory = freshMemory(), readAuto: readPrev = () => null, cfg }) {
  if (!cfg.enabled) return [];
  const today = localDate(now), hm = hhmm(now), actions = [];
  const retry = (iso) => olderThan(iso, now, cfg.intervalMinutes);
  // 1. Previous day(s), oldest first: once per calendar day — the stored catchupAt or the in-memory
  //    "done" say so; a failed attempt is retried after the interval.
  for (let i = cfg.catchupDays ?? 0; i >= 1; i--) {
    const date = addDays(today, -i);
    const prev = readPrev(date);
    const doneToday = memory.catchupDone[date] === today || (prev?.catchupAt && dateOf(prev.catchupAt) === today);
    if (!doneToday && retry(memory.catchupTried[date])) actions.push({ type: "catchup", date });
  }
  // 2. End of day: between saveAt and the end of work hours, once; a failed attempt is retried
  //    after the interval. Later than that, the next morning's catch-up takes over.
  const inEodWindow = Boolean(cfg.saveAt) && hm >= cfg.saveAt && hm < workEnd(cfg.workHours);
  if (inEodWindow && !todayAuto?.eodSavedAt && !memory.eodDone[today] && retry(memory.eodTried[today])) actions.push({ type: "eod", date: today });
  // 3. Otherwise the periodic rebuild, in work hours, when the last attempt is older than the interval.
  else if (inWorkHours(hm, cfg.workHours)) {
    const last = [todayAuto?.updatedAt, memory.tried[today], memory.eodTried[today]].filter(Boolean).map((t) => Date.parse(t));
    if (now.getTime() - Math.max(0, ...last) >= cfg.intervalMinutes * 60_000) actions.push({ type: "auto", date: today });
  }
  return actions;
}

/**
 * @param {object} d
 * @param {object} d.cfg               the `auto` config section
 * @param {string} d.progressDir
 * @param {object} d.jira              the Jira source (state + refresh)
 * @param {() => {github: object, jiraDone: object[]}} d.data  the server's current, window-trimmed data (server.finished())
 * @param {(force?: boolean) => Promise<void>} d.refreshGithub
 * @param {(login: string, page: number) => Promise<object[]>} d.fetchEvents
 * @param {typeof runClaude} [d.claude]
 * @param {(msg: string) => void} [d.log]
 * @param {() => Date} [d.now]
 */
export function createAutoNotes({ cfg, progressDir, jira, data, refreshGithub, fetchEvents, claude = runClaude, log = () => {}, now = () => new Date() }) {
  const state = { running: false, lastRun: null, error: null, timer: null, memory: freshMemory() };
  let queue = Promise.resolve();

  /**
   * Rebuilds the automatic record for `date`; runs are serialized so two triggers never interleave.
   * `markEod` / `markCatchup` stamp the record so the scheduler does each once; existing marks
   * survive later rebuilds. `feed` is an event feed already downloaded for this tick.
   */
  function update(date = localDate(now()), { reason = "manual", refresh = false, markEod = false, markCatchup = false, feed } = {}) {
    const run = async () => {
      state.running = true;
      const m = state.memory, startedAt = now().toISOString(), today = localDate(now());
      m.tried[date] = startedAt;
      if (markEod) m.eodTried[date] = startedAt;
      if (markCatchup) m.catchupTried[date] = startedAt;
      try {
        if (refresh) await refreshGithub(true);
        else if (!data().github.login) await refreshGithub(false);   // right after start: the login comes with the first GitHub fetch
        let { github: gh, jiraDone } = data();
        const jiraLists = () => ({ open: jira.state.issues ?? [], done: jiraDone });
        const activity = await collectActivity(date, { login: gh.login, jira: jiraLists(), github: gh, fetchEvents, feed });
        const existing = readAuto(progressDir, date);
        if (!activity.items.length && !existing && !dayExists(progressDir, date)) {
          state.error = activity.errors.join("; ") || null;
          if (markEod) m.eodDone[date] = true;            // a quiet day: nothing to save, don't try again today
          if (markCatchup) m.catchupDone[date] = today;
          log(`auto ${date} (${reason}): nothing recorded, no file written${state.error ? ` (${state.error})` : ""}`);
          return null;
        }
        // GitHub failed or the feed no longer reaches that day: a rebuild could only lose
        // detail, so a record that already has more is kept as it is (and retried later).
        const githubProblem = activity.errors.some((e) => e.startsWith("GitHub activity"));
        if (githubProblem && existing?.points?.length && activity.items.length <= (existing.activity?.length ?? 0)) {
          state.error = activity.errors.join("; ");
          log(`auto ${date} (${reason}): kept the previous record — ${state.error}`);
          return { date, auto: existing, kept: true };
        }
        // End of day: bring Jira up to date too before the snapshot (a Claude call — only when stale, only now).
        if (refresh && olderThan(jira.state.fetchedAt, now(), STALE_JIRA_MINUTES)) { await jira.refresh(); ({ github: gh, jiraDone } = data()); }
        const built = await buildAuto(date, { activity, useClaude: cfg.useClaude, model: cfg.model, claude, now });
        const auto = {
          ...built,
          eodSavedAt: markEod ? built.updatedAt : existing?.eodSavedAt ?? null,
          catchupAt: markCatchup ? built.updatedAt : existing?.catchupAt ?? null,
        };
        // A past day keeps the Jira/PR lists it was saved with; only its automatic record changes.
        const saved = setAuto(progressDir, date, auto, jiraLists().open, gh, { jiraDone, keepSnapshot: date < today });
        if (markCatchup) m.catchupDone[date] = today;
        state.lastRun = auto.updatedAt;
        state.error = auto.errors.join("; ") || null;
        log(`auto ${date} (${reason}): ${auto.points.length} point(s) via ${auto.source}${auto.errors.length ? `; ${auto.errors.join("; ")}` : ""}`);
        return saved;
      } catch (e) {
        state.error = e.message;
        log(`auto ${date} (${reason}) failed: ${e.message}`);
        throw e;
      } finally {
        state.running = false;
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  async function tick() {
    const t = now(), today = localDate(t);
    const actions = plan({ now: t, cfg, todayAuto: readAuto(progressDir, today), memory: state.memory, readAuto: (d) => readAuto(progressDir, d) });
    // One download of the event feed serves every action of this tick.
    let feed;
    const login = data().github.login;
    if (actions.length > 1 && login) {
      try { feed = await fetchFeedUntil(login, actions.map((a) => a.date).sort()[0], fetchEvents); }
      catch { /* each action reports the failure itself */ }
    }
    for (const a of actions) {
      try {
        if (a.type === "catchup") await update(a.date, { reason: "catch-up", markCatchup: true, feed });
        else if (a.type === "eod") await update(a.date, { reason: "end of day", refresh: true, markEod: true, feed });
        else await update(a.date, { reason: "scheduled", feed });
      } catch { /* logged in update */ }
    }
    return actions;
  }

  return {
    update, tick,
    /** Starts the minute timer (unref'd so it never keeps the process alive) and ticks once. */
    start(everyMs = 60_000) {
      if (!cfg.enabled || state.timer) return;
      state.timer = setInterval(() => { tick(); }, everyMs);
      state.timer.unref();
      tick();
    },
    stop() { clearInterval(state.timer); state.timer = null; },
    status: () => ({
      enabled: cfg.enabled, running: state.running, lastRun: state.lastRun, error: state.error,
      intervalMinutes: cfg.intervalMinutes, workHours: cfg.workHours, saveAt: cfg.saveAt, catchupDays: cfg.catchupDays, useClaude: cfg.useClaude,
    }),
  };
}
