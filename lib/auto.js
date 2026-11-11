// Automatic notes. Every `intervalMinutes` during work hours the day's recorded activity
// (GitHub events, Jira changes) becomes a few bullets — written by Claude when enabled, else the
// plain activity lines — stored beside the user's own notes, never mixed with them.
import { collectActivity } from "./activity.js";
import { runClaude } from "./claude.js";
import { hhmm, localDate } from "./dates.js";
import { dayExists, readAuto, setAuto } from "./progress.js";

export const MAX_POINTS = 12;
export const MAX_POINT_CHARS = 300;
const SUMMARY_BUDGET_USD = "0.05";
const STALE_JIRA_MS = 30 * 60_000;

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

/**
 * What the scheduler should do now. Pure, so the timing rules are testable.
 * @param {object} s
 * @param {Date} s.now
 * @param {object|null} s.todayAuto     today's stored record (its updatedAt is the last successful build)
 * @param {string|null} [s.lastTriedAt] when today's last attempt ran, even if it wrote nothing (quiet day)
 * @param {object} s.cfg
 * @returns {{type: "auto", date: string}[]}
 */
export function plan({ now, todayAuto, lastTriedAt = null, cfg }) {
  if (!cfg.enabled) return [];
  const today = localDate(now), hm = hhmm(now), actions = [];
  if (inWorkHours(hm, cfg.workHours)) {
    const last = Math.max(todayAuto?.updatedAt ? Date.parse(todayAuto.updatedAt) : 0, lastTriedAt ? Date.parse(lastTriedAt) : 0);
    if (now.getTime() - last >= cfg.intervalMinutes * 60_000) actions.push({ type: "auto", date: today });
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
  const state = { running: false, lastRun: null, error: null, timer: null, tried: {} };   // tried: date → last attempt (ISO)
  let queue = Promise.resolve();

  /** Rebuilds the automatic record for `date`; runs are serialized so two triggers never interleave. */
  function update(date = localDate(now()), { reason = "manual", refresh = false } = {}) {
    const run = async () => {
      state.running = true;
      state.tried[date] = now().toISOString();
      try {
        if (refresh) {
          await refreshGithub(true);
          if (!jira.state.fetchedAt || now().getTime() - Date.parse(jira.state.fetchedAt) > STALE_JIRA_MS) await jira.refresh();
        } else if (!data().github.login) {
          await refreshGithub(false);   // right after start: the login comes with the first GitHub fetch
        }
        const { github: gh, jiraDone } = data();
        const jiraLists = { open: jira.state.issues ?? [], done: jiraDone };
        const activity = await collectActivity(date, { login: gh.login, jira: jiraLists, github: gh, fetchEvents });
        const existing = readAuto(progressDir, date);
        if (!activity.items.length && !existing && !dayExists(progressDir, date)) {
          state.error = activity.errors.join("; ") || null;
          log(`auto ${date} (${reason}): nothing recorded, no file written${state.error ? ` (${state.error})` : ""}`);
          return null;
        }
        // GitHub failed or the feed no longer reaches that day: a rebuild could only lose
        // detail, so a record that already has more is kept as it is.
        const githubProblem = activity.errors.some((e) => e.startsWith("GitHub activity"));
        if (githubProblem && existing?.points?.length && activity.items.length <= (existing.activity?.length ?? 0)) {
          state.error = activity.errors.join("; ");
          log(`auto ${date} (${reason}): kept the previous record — ${state.error}`);
          return { date, auto: existing, kept: true };
        }
        const auto = await buildAuto(date, { activity, useClaude: cfg.useClaude, model: cfg.model, claude, now });
        const saved = setAuto(progressDir, date, auto, jiraLists.open, gh, { jiraDone });
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
    const actions = plan({ now: t, todayAuto: readAuto(progressDir, today), lastTriedAt: state.tried[today] ?? null, cfg });
    for (const a of actions) {
      try { await update(a.date, { reason: "scheduled" }); } catch { /* logged in update */ }
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
      intervalMinutes: cfg.intervalMinutes, workHours: cfg.workHours, useClaude: cfg.useClaude,
    }),
  };
}
