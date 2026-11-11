// Headless Claude Code: runs `claude -p` with a prompt on stdin and returns its JSON result.
// Used for Jira (with the Atlassian connector) and for summarizing the day's activity.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { MODEL_RE } from "./config.js";

export const DEFAULT_TIMEOUT_MS = 180_000;

// Built-in tools a headless run must never use: the prompt may contain text written by others
// (PR titles, commit messages, issue summaries), so the model must have nothing to act with.
// `--disallowedTools` is enforced by the permission system ("The Read tool is disabled for this
// session"); `--tools ""` is not used with MCP tools because it hides them as well.
export const BUILTIN_DENY = [
  "Bash", "PowerShell", "Edit", "MultiEdit", "Write", "NotebookEdit", "Read", "Glob", "Grep", "LS",
  "WebFetch", "WebSearch", "Agent", "Task", "Skill", "TaskCreate", "TaskUpdate", "TaskStop", "Monitor",
  "Workflow", "EnterWorktree", "ExitWorktree", "ToolSearch", "PublishPlugin", "SendMessage",
  "RemoteTrigger", "CronCreate", "CronDelete", "ScheduleWakeup", "PushNotification", "LSP", "Artifact",
];

/**
 * Arguments for a locked-down headless run: every built-in tool denied, and either exactly the
 * MCP tools named in `allowedTools` (Jira) or — with none — no tools and no MCP servers at all
 * (`--tools ""` + `--strict-mcp-config`, the summary).
 */
export function claudeArgs({ model, maxBudgetUsd, allowedTools = [] }) {
  const args = ["-p", "--model", model, "--output-format", "json", "--no-session-persistence",
    "--max-budget-usd", maxBudgetUsd, "--disallowedTools", BUILTIN_DENY.join(",")];
  return allowedTools.length ? [...args, "--allowedTools", allowedTools.join(",")] : [...args, "--tools", "", "--strict-mcp-config"];
}

/**
 * The environment of a headless run. The folder of the node running this app goes first on
 * PATH: `claude` is found through PATH (by cmd.exe on Windows), and an app started from the
 * desktop shortcut gets the machine's PATH, which need not contain the folder `claude` was
 * installed in — the folder of its own node, where npm puts the shims, usually does.
 * UDHAM_FLASH_DISABLE keeps the user's "flash when done" Stop hook quiet.
 */
export function spawnEnv(env = process.env, execPath = process.execPath) {
  const out = { ...env, UDHAM_FLASH_DISABLE: "1" };
  const key = Object.keys(out).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const nodeDir = path.dirname(execPath);
  const parts = String(out[key] ?? "").split(path.delimiter).filter(Boolean);
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!parts.some((p) => same(p, nodeDir))) out[key] = [nodeDir, ...parts].join(path.delimiter);
  return out;
}

/**
 * @param {string} prompt
 * @param {object} o
 * @param {string} o.model           e.g. "haiku"
 * @param {string} o.maxBudgetUsd    hard cap for the call, e.g. "0.10"
 * @param {string[]} [o.allowedTools] MCP tools the call may use; [] = no tools of any kind
 * @param {number} [o.timeoutMs]
 * @returns {Promise<string>} the text of Claude's final answer
 */
export function runClaude(prompt, { model, maxBudgetUsd, allowedTools = [], timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!MODEL_RE.test(model)) return Promise.reject(new Error("invalid model name"));   // re-checked: shell: true below
  const args = claudeArgs({ model, maxBudgetUsd, allowedTools });

  return new Promise((resolve, reject) => {
    // Prompt via stdin: on Windows `claude` is a .cmd shim run through cmd.exe, where
    // free text in arguments is fragile.
    const child = spawn("claude", args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      shell: process.platform === "win32",
      env: spawnEnv(),
    });
    let stdout = "", stderr = "";
    // On Windows the child is cmd.exe → claude.cmd → node; kill the whole tree, not just cmd.exe.
    const killTree = () => {
      if (process.platform === "win32" && child.pid)
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => { killTree(); reject(new Error(`claude timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`could not start claude: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`));
      try { resolve(resultText(stdout)); }
      catch (e) { reject(new Error(`unexpected claude output: ${e.message}`)); }
    });
    child.stdin.end(prompt);
  });
}

/** The answer text inside `claude -p --output-format json` output, code fence removed. */
export function resultText(stdout) {
  const res = JSON.parse(stdout);
  if (res.is_error) throw new Error(res.result || "claude reported an error");
  return String(res.result ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
}
