// What was actually done behind a day's activity, so the summary can say it: for every PR the
// user touched — its description, the commits they pushed that day, the review comments and
// comments they wrote; for every branch they pushed — the day's commit messages. Everything is
// read through `gh` and clipped hard: this is prompt material, not storage.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dateOf, parseLocal } from "./dates.js";

const run = promisify(execFile);
const LIMITS = { prs: 12, branches: 8, body: 600, comment: 240, comments: 8, commits: 10 };
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[^\s~^:?*[\\]+$/;

const clip = (s, n) => { const t = String(s ?? "").replace(/\r/g, "").replace(/\s+\n/g, "\n").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const first = (s) => String(s ?? "").split("\n")[0].trim();

async function ghText(args) {
  const { stdout } = await run("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 60_000 });
  return stdout;
}
async function defaultGraphql(query) {
  const res = JSON.parse(await ghText(["api", "graphql", "-f", `query=${query}`]));
  if (res.errors && !res.data) throw new Error(res.errors.map((e) => e.message).join("; "));
  return res.data ?? {};
}
const defaultRest = async (path) => JSON.parse(await ghText(["api", path]));

/** One aliased GraphQL query for up to LIMITS.prs pull requests. */
export function prQuery(prs) {
  const fields = `title bodyText additions deletions changedFiles author { login } createdAt
    commits(last: 40) { nodes { commit { messageHeadline committedDate author { user { login } } } } }
    reviews(last: 30) { nodes { author { login } state submittedAt bodyText comments(first: 15) { nodes { path bodyText createdAt } } } }
    comments(last: 30) { nodes { author { login } createdAt bodyText } }`;
  return `query {\n${prs.map((p, i) => {
    const [owner, name] = p.repo.split("/");
    return `  pr${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(p.number)}) { ${fields} } }`;
  }).join("\n")}\n}`;
}

/**
 * Turns one PR's GraphQL node into the lines the prompt gets: the user's own work on `date`
 * ("Your …" lines) and, clearly labelled as background, the PR's description — which is the
 * author's account of the whole PR, not that day's work, unless it is the user's own PR opened
 * that day. Without the label the summary reported other people's PR descriptions as the
 * user's doing.
 */
export function describePr(ref, pr, { login, date }) {
  if (!pr) return null;
  const mine = (n) => n?.author?.user?.login === login || n?.author?.login === login;
  const onDay = (iso) => dateOf(iso) === date;
  const lines = [`### ${ref} — ${clip(pr.title, 120)}  (+${pr.additions} −${pr.deletions}, ${pr.changedFiles} files)`];
  if (pr.bodyText) {
    const body = clip(pr.bodyText, LIMITS.body);
    lines.push(mine(pr) && onDay(pr.createdAt)
      ? `Description (your PR, opened today): ${body}`
      : `Background — the PR's description, written by ${pr.author?.login ?? "its author"}${pr.createdAt ? ` on ${dateOf(pr.createdAt)}` : ""}; it says what the PR is about, not what was done today: ${body}`);
  }
  const commits = (pr.commits?.nodes ?? []).map((n) => n.commit).filter((c) => mine(c) && onDay(c.committedDate)).map((c) => clip(first(c.messageHeadline), 100));
  if (commits.length) lines.push(`Your commits today: ${commits.slice(-LIMITS.commits).map((m) => JSON.stringify(m)).join(", ")}`);
  const reviews = (pr.reviews?.nodes ?? []).filter((r) => mine(r) && onDay(r.submittedAt));
  const reviewComments = reviews.flatMap((r) => [
    ...(r.bodyText ? [clip(r.bodyText, LIMITS.comment)] : []),
    ...(r.comments?.nodes ?? []).map((c) => `${c.path ? `${c.path.split("/").pop()}: ` : ""}${clip(c.bodyText, LIMITS.comment)}`),
  ]);
  const states = [...new Set(reviews.map((r) => r.state.toLowerCase().replace("_", " ")))];
  if (states.length) lines.push(`Your review today: ${states.join(", ")}${reviewComments.length ? ` — ${reviewComments.length} comment(s)` : ""}`);
  if (reviewComments.length) lines.push(...reviewComments.slice(0, LIMITS.comments).map((c) => `  - ${c}`));
  const comments = (pr.comments?.nodes ?? []).filter((c) => mine(c) && onDay(c.createdAt)).map((c) => clip(c.bodyText, LIMITS.comment));
  if (comments.length) lines.push(`Your comments today: ${comments.slice(0, LIMITS.comments).map((c) => JSON.stringify(c)).join(" | ")}`);
  return lines.join("\n");
}

/**
 * Details for the PRs and branches in `items` (activity lines carrying `repo`, `number`, `branch`).
 * @returns {Promise<{text: string, errors: string[]}>}  prompt text (may be empty) and problems
 */
export async function collectDetails(date, items, { login, graphql = defaultGraphql, rest = defaultRest } = {}) {
  const errors = [], blocks = [];
  const prs = [], branches = [];
  for (const it of items) {
    if (it.repo && !REPO_RE.test(it.repo)) continue;
    if (it.number && it.repo && !prs.some((p) => p.repo === it.repo && p.number === it.number)) prs.push({ ref: it.ref, repo: it.repo, number: it.number });
    if (it.branch && it.repo && BRANCH_RE.test(it.branch) && !branches.some((b) => b.repo === it.repo && b.branch === it.branch)) branches.push({ ref: it.ref, repo: it.repo, branch: it.branch });
  }
  if (prs.length) {
    try {
      const data = await graphql(prQuery(prs.slice(0, LIMITS.prs)));
      prs.slice(0, LIMITS.prs).forEach((p, i) => { const d = describePr(p.ref, data[`pr${i}`]?.pullRequest, { login, date }); if (d) blocks.push(d); });
    } catch (e) { errors.push(`PR details: ${e.message}`); }
  }
  // Branches pushed to that are not already covered by a PR block: the day's commit messages.
  const covered = new Set(blocks.map((b) => b.split("\n")[0]));
  const start = parseLocal(date), end = new Date(start.getTime() + 86_400_000);
  for (const b of branches.slice(0, LIMITS.branches)) {
    try {
      const path = `repos/${b.repo}/commits?sha=${encodeURIComponent(b.branch)}&author=${encodeURIComponent(login)}&since=${start.toISOString()}&until=${end.toISOString()}&per_page=${LIMITS.commits}`;
      const commits = await rest(path);
      const msgs = (Array.isArray(commits) ? commits : []).map((c) => clip(first(c.commit?.message), 100)).filter(Boolean);
      if (msgs.length && ![...covered].some((h) => msgs.every((m) => h.includes(m))))
        blocks.push(`### Branch ${b.ref}\nYour commits today: ${msgs.map((m) => JSON.stringify(m)).join(", ")}`);
    } catch { /* a deleted branch (merged) or a private fork: nothing to add */ }
  }
  return { text: blocks.join("\n\n"), errors };
}
