// GitHub data through the `gh` CLI: the user's open PRs (with what each is still
// waiting on), the open PRs awaiting the user's review, and — for the score — the PRs
// they closed and the PRs they reviewed recently.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { addDays } from "./dates.js";

const run = promisify(execFile);

async function gh(args) {
  try {
    const { stdout } = await run("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 60_000 });
    return stdout;
  } catch (e) {
    throw new Error((e.stderr || e.message).trim());
  }
}

async function graphql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-F", `${k}=${v}`);
  const res = JSON.parse(await gh(args));
  if (res.errors) throw new Error(res.errors.map((e) => e.message).join("; "));
  return res.data;
}

const MINE = /* GraphQL */ `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes { ... on PullRequest {
      number title url isDraft createdAt updatedAt headRefName baseRefName
      repository { nameWithOwner }
      reviewDecision mergeable mergeStateStatus
      reviewRequests(first: 20) { nodes { requestedReviewer {
        ... on User { login } ... on Team { name } } } }
      latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
      reviewThreads(first: 100) { nodes { isResolved } }
      commits(last: 1) { nodes { commit { statusCheckRollup {
        state
        contexts(first: 100) { nodes {
          ... on CheckRun { name conclusion status }
          ... on StatusContext { context state } } }
      } } } }
    } }
  }
}`;

const TO_REVIEW = /* GraphQL */ `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes { ... on PullRequest {
      number title url isDraft createdAt updatedAt headRefName
      repository { nameWithOwner }
      author { login }
    } }
  }
}`;

// Finished work: PRs of mine that were closed (merged or not) since a date…
const CLOSED = /* GraphQL */ `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url merged mergedAt closedAt createdAt baseRefName
      repository { nameWithOwner }
    } }
  }
}`;

// …and PRs by others that I reviewed, with when I submitted each review.
const REVIEWED = /* GraphQL */ `
query($q: String!, $login: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url state closedAt createdAt
      repository { nameWithOwner }
      author { login }
      reviews(author: $login, first: 50) { nodes { state submittedAt } }
    } }
  }
}`;

const MAX_PAGES = 5;   // 500 PRs per list is plenty for a personal score; beyond that we log it

/** All pages of a search (up to MAX_PAGES × 100 nodes). */
async function searchAll(query, vars, graphqlFn, log) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { search } = await graphqlFn(query, after ? { ...vars, after } : vars);
    nodes.push(...search.nodes);
    if (!search.pageInfo?.hasNextPage) return nodes;
    after = search.pageInfo.endCursor;
  }
  log(`github: more than ${MAX_PAGES * 100} results for "${vars.q}"; the score is missing the oldest ones`);
  return nodes;
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const reviewerName = (r) => r?.requestedReviewer?.login ?? r?.requestedReviewer?.name;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What is this PR still waiting on? Most blocking first.
 * @returns {{level: "bad"|"warn"|"info"|"good", text: string}[]}
 */
export function pendingNotes(pr) {
  const notes = [];
  const checks = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const contexts = checks?.contexts?.nodes ?? [];
  const failed = contexts.filter((c) => FAILED.has(c.conclusion ?? c.state));
  const running = contexts.filter((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING");
  const unresolved = (pr.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length;
  const changesBy = (pr.latestOpinionatedReviews?.nodes ?? []).filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.author?.login);
  const requested = (pr.reviewRequests?.nodes ?? []).map(reviewerName).filter(Boolean);
  const names = (list) => list.slice(0, 4).join(", ") + (list.length > 4 ? ` +${list.length - 4}` : "");

  if (pr.isDraft) notes.push({ level: "info", text: "Draft — mark ready for review when done" });
  if (pr.mergeable === "CONFLICTING") notes.push({ level: "bad", text: `Merge conflicts with ${pr.baseRefName}` });
  if (failed.length) notes.push({ level: "bad", text: `CI failing: ${names(failed.map((c) => c.name ?? c.context))}` });
  if (changesBy.length) notes.push({ level: "bad", text: `Changes requested by ${changesBy.join(", ")}` });
  if (unresolved) notes.push({ level: "warn", text: `${plural(unresolved, "unresolved review thread")}` });
  if (running.length && !failed.length) notes.push({ level: "warn", text: `CI running (${plural(running.length, "check")})` });
  if (pr.mergeStateStatus === "BEHIND") notes.push({ level: "warn", text: `Branch is behind ${pr.baseRefName}` });
  if (!pr.isDraft && pr.reviewDecision === "REVIEW_REQUIRED")
    notes.push({ level: "warn", text: requested.length ? `Waiting for review: ${requested.join(", ")}` : "Needs review — no reviewers requested" });
  if (!notes.length && (pr.reviewDecision === "APPROVED" || pr.reviewDecision == null))
    notes.push({ level: "good", text: !checks || checks.state === "SUCCESS" ? "Ready to merge" : "Approved" });
  return notes;
}

const byLatest = (field) => (a, b) => (b[field] ?? "").localeCompare(a[field] ?? "");

/** Closed PRs of mine, newest first; `closedAt` is the merge time when merged. */
export function mapClosed(nodes) {
  return nodes.filter((n) => n?.number).map((pr) => ({
    repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url,
    merged: Boolean(pr.merged), closedAt: pr.mergedAt ?? pr.closedAt, createdAt: pr.createdAt, base: pr.baseRefName,
  })).sort(byLatest("closedAt"));
}

/** PRs I reviewed, newest review first. Reviews never submitted (no `submittedAt`) don't count. */
export function mapReviewed(nodes) {
  return nodes.filter((n) => n?.number).map((pr) => {
    const reviews = (pr.reviews?.nodes ?? []).filter((r) => r?.submittedAt)
      .map((r) => ({ state: r.state, at: r.submittedAt })).sort((a, b) => a.at.localeCompare(b.at));
    const last = reviews.at(-1);
    return {
      repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url,
      author: pr.author?.login ?? "ghost", state: pr.state, createdAt: pr.createdAt, closedAt: pr.closedAt,
      reviews, lastReviewAt: last?.at ?? null, lastReviewState: last?.state ?? null,
    };
  }).filter((pr) => pr.reviews.length).sort(byLatest("lastReviewAt"));
}

const whoami = async () => JSON.parse(await gh(["api", "user"])).login;

/** One page (100, newest first) of the user's event feed — pushes, PRs, reviews, comments. */
export async function fetchEvents(login, page = 1) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error("bad GitHub login");
  const events = JSON.parse(await gh(["api", `users/${login}/events?per_page=100&page=${Number(page) || 1}`]));
  return Array.isArray(events) ? events : [];
}

/**
 * Fetches the signed-in user's open PRs and review requests, plus the PRs they closed and
 * reviewed since `since` (YYYY-MM-DD) for the score. Four searches run in parallel; the two
 * score searches are paginated. `deps` are injectable for tests.
 */
export async function collectGithub({ since } = {}, { graphql: graphqlFn = graphql, user = whoami, log = () => {} } = {}) {
  const login = await user();
  // GitHub evaluates date qualifiers in UTC and `since` is a local Monday: ask from the day
  // before so the first hours of that Monday (east of UTC) are not lost; the server trims.
  const sinceQ = since ? `>=${addDays(since, -1)}` : ">=1970-01-01";
  const [mineRes, reviewRes, closedNodes, reviewedNodes] = await Promise.all([
    graphqlFn(MINE, { q: `is:pr is:open archived:false author:${login}` }),
    graphqlFn(TO_REVIEW, { q: `is:pr is:open archived:false review-requested:${login}` }),
    searchAll(CLOSED, { q: `is:pr is:closed archived:false author:${login} closed:${sinceQ} sort:updated-desc` }, graphqlFn, log),
    searchAll(REVIEWED, { q: `is:pr archived:false reviewed-by:${login} -author:${login} updated:${sinceQ} sort:updated-desc`, login }, graphqlFn, log),
  ]);
  const prs = (res) => res.search.nodes.filter((n) => n?.number);
  return {
    login,
    closed: mapClosed(closedNodes),
    reviewed: mapReviewed(reviewedNodes),
    mine: prs(mineRes).map((pr) => ({
      repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url,
      branch: pr.headRefName, base: pr.baseRefName, draft: pr.isDraft,
      createdAt: pr.createdAt, updatedAt: pr.updatedAt, reviewDecision: pr.reviewDecision,
      pending: pendingNotes(pr),
    })),
    toReview: prs(reviewRes).map((pr) => ({
      repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url,
      branch: pr.headRefName, author: pr.author?.login ?? "ghost", draft: pr.isDraft,
      createdAt: pr.createdAt, updatedAt: pr.updatedAt,
    })),
  };
}
