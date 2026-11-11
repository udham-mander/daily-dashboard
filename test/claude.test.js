import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_DENY, claudeArgs, resultText } from "../lib/claude.js";

test("claudeArgs: built-ins always denied; MCP tools allowed only when named; otherwise no tools at all", () => {
  const jira = claudeArgs({ model: "haiku", maxBudgetUsd: "0.10", allowedTools: ["mcp__x__search"] });
  const deny = jira[jira.indexOf("--disallowedTools") + 1].split(",");
  for (const t of ["Bash", "Read", "Edit", "Write", "WebFetch", "Agent"]) assert.ok(deny.includes(t), `${t} denied`);
  assert.deepEqual(deny, BUILTIN_DENY);
  assert.equal(jira[jira.indexOf("--allowedTools") + 1], "mcp__x__search");
  assert.ok(!jira.includes("--tools"), "--tools \"\" would hide the MCP tools too");
  assert.ok(!jira.includes("--strict-mcp-config"));
  for (const flag of ["-p", "--no-session-persistence", "--output-format", "--max-budget-usd"]) assert.ok(jira.includes(flag), flag);

  const summary = claudeArgs({ model: "haiku", maxBudgetUsd: "0.05" });
  assert.equal(summary[summary.indexOf("--tools") + 1], "");
  assert.ok(summary.includes("--strict-mcp-config"));
  assert.ok(summary.includes("--disallowedTools"));
  assert.ok(!summary.includes("--allowedTools"));
});

test("resultText unwraps the JSON envelope, strips a code fence, and surfaces errors", () => {
  assert.equal(resultText(JSON.stringify({ is_error: false, result: "```json\n[1]\n```" })), "[1]");
  assert.equal(resultText(JSON.stringify({ result: " x " })), "x");
  assert.throws(() => resultText(JSON.stringify({ is_error: true, result: "budget exceeded" })), /budget exceeded/);
});
