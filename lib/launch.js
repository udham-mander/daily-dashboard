// "Launch Claude": opens a new terminal window running Claude Code in a folder, and remembers
// the folders used most recently (so the page can offer them next time).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, writeFileAtomic } from "./fsutil.js";

// Is `name` an executable on PATH? (exact file name, e.g. "wt.exe")
export const onPath = (name, env = process.env) =>
  (env.PATH ?? env.Path ?? "").split(path.delimiter).some((d) => { try { return d && fs.existsSync(path.join(d, name)); } catch { return false; } });

// The folder ends up on a command line (and in cmd.exe's on Windows). Paths with characters
// that cmd.exe or a shell could interpret are refused rather than escaped.
const UNSAFE_PATH = /[\x00-\x1f"&|<>^%!`$;]/;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The terminal command that runs `command` in `dir` on this platform: [file, args].
 * Windows: a new Windows Terminal tab (falls back to a console window) running PowerShell,
 * which resolves `claude` through PATH like a typed command would.
 */
export function terminalCommand(dir, command, { platform = process.platform, has = onPath } = {}) {
  if (platform === "win32") {
    const shell = ["powershell.exe", "-NoExit", "-Command", command];
    return has("wt.exe") ? ["wt.exe", ["-d", dir, ...shell]] : ["cmd.exe", ["/c", "start", "", "/D", dir, ...shell]];
  }
  const script = `cd ${shQuote(dir)} && ${command}`;
  if (platform === "darwin")
    return ["osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`, "-e", 'tell application "Terminal" to activate']];
  const term = ["gnome-terminal", "x-terminal-emulator", "konsole", "xfce4-terminal", "xterm"].find((t) => has(t));
  if (!term) throw new Error("no terminal emulator found (tried gnome-terminal, x-terminal-emulator, konsole, xfce4-terminal, xterm)");
  const sep = term === "gnome-terminal" || term === "xfce4-terminal" ? "--" : "-e";
  return [term, [sep, "bash", "-lc", `${script}; exec bash`]];
}

// Per-session markers Claude Code puts in the environment of everything it starts. When the app
// itself was started from a Claude session (the skill does that), a terminal launched from here
// would inherit them and the new `claude` would believe it is a child session ("Transcript
// saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"). User-level settings such as
// CLAUDE_CODE_GIT_BASH_PATH are deliberately kept.
export const SESSION_MARKERS = [
  "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH", "CLAUDE_PID", "CLAUDE_EFFORT", "UDHAM_FLASH_DISABLE",
];
/** A copy of `env` without the markers above — what a fresh terminal should start with. */
export function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (SESSION_MARKERS.includes(k.toUpperCase())) delete out[k];
  return out;
}

/**
 * Starts a detached process with a clean environment. Launchers that hand off and exit (wt.exe,
 * `cmd /c start`, osascript) are judged by their exit code; a terminal that stays open (xterm)
 * is assumed fine once it has run for `settleMs`. Rejects if the process could not start or
 * exited non-zero.
 */
export function spawnDetached(file, args, cwd, { settleMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(file, args, { cwd, detached: true, stdio: "ignore", env: cleanEnv() }); }
    catch (e) { return reject(new Error(`could not start ${file}: ${e.message}`)); }
    const timer = setTimeout(() => { child.unref(); resolve(); }, settleMs);
    child.once("error", (e) => { clearTimeout(timer); reject(new Error(`could not start ${file}: ${e.message}`)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) resolve();
      else reject(new Error(`${file} exited with code ${code}`));
    });
  });
}

/**
 * @param {object} o
 * @param {string} o.defaultDir   where the main button opens Claude
 * @param {string} o.recentFile   JSON file holding the most recent folders
 * @param {string} [o.command]    what to run in the terminal (default "claude")
 * @param {number} [o.max]        how many recent folders to keep (default 5)
 * @param {typeof spawnDetached} [o.run]  override for tests
 */
export function createLauncher({ defaultDir, recentFile, command = "claude", max = 5, run = spawnDetached }) {
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const load = () => { const r = readJson(recentFile, []); return Array.isArray(r) ? r.filter((d) => typeof d === "string") : []; };
  const info = () => ({ defaultDir, command, recent: load().filter((d) => !same(d, defaultDir)).slice(0, max) });

  return {
    info,
    /** Opens a new Claude session in `dir` (default folder when omitted) and records the folder. */
    async launch(dir) {
      if (dir === undefined || dir === null || dir === "") dir = defaultDir;
      if (typeof dir !== "string" || !dir.trim()) throw bad("folder is empty");
      dir = dir.trim().replace(/^~(?=$|[\\/])/, os.homedir());
      if (!path.isAbsolute(dir)) throw bad("folder must be an absolute path");
      if (UNSAFE_PATH.test(dir)) throw bad("folder path has unsupported characters");
      dir = path.resolve(dir);
      let st; try { st = fs.statSync(dir); } catch { throw bad("folder not found"); }
      if (!st.isDirectory()) throw bad("folder not found");

      const [file, args] = terminalCommand(dir, command);
      await run(file, args, dir);
      // Most recent first, no duplicates; the default folder is remembered too (it may change later).
      writeFileAtomic(recentFile, JSON.stringify([dir, ...load().filter((d) => !same(d, dir))].slice(0, max + 1), null, 2));
      return { dir, ...info() };
    },
  };
}
