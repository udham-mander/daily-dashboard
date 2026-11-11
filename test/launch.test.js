import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLauncher, spawnDetached, terminalCommand } from "../lib/launch.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dd-launch-"));

test("terminalCommand picks a terminal per platform and runs the command in the folder", () => {
  const has = (set) => (name) => set.includes(name);
  assert.deepEqual(terminalCommand("C:\\w", "claude", { platform: "win32", has: has(["wt.exe"]) }),
    ["wt.exe", ["-d", "C:\\w", "powershell.exe", "-NoExit", "-Command", "claude"]]);
  assert.deepEqual(terminalCommand("C:\\w", "claude", { platform: "win32", has: has([]) }),
    ["cmd.exe", ["/c", "start", "", "/D", "C:\\w", "powershell.exe", "-NoExit", "-Command", "claude"]]);
  const [mac, macArgs] = terminalCommand("/Users/me/it's", "claude", { platform: "darwin", has: has([]) });
  assert.equal(mac, "osascript");
  // The shell line is embedded as an AppleScript string literal (JSON-escaped); decode it to check it.
  assert.equal(JSON.parse(macArgs[1].match(/do script (".*")$/)[1]), "cd '/Users/me/it'\\''s' && claude");
  assert.deepEqual(terminalCommand("/home/me", "claude", { platform: "linux", has: has(["xterm"]) }),
    ["xterm", ["-e", "bash", "-lc", "cd '/home/me' && claude; exec bash"]]);
  assert.equal(terminalCommand("/home/me", "claude", { platform: "linux", has: has(["gnome-terminal"]) })[1][0], "--");
  assert.throws(() => terminalCommand("/home/me", "claude", { platform: "linux", has: has([]) }), /no terminal emulator/);
});

test("launcher validates the folder, runs the terminal and keeps 5 recent folders, newest first", async () => {
  const base = tmp();
  const dirs = Array.from({ length: 7 }, (_, i) => { const d = path.join(base, `p${i}`); fs.mkdirSync(d); return d; });
  const calls = [];
  const launcher = createLauncher({ defaultDir: dirs[0], recentFile: path.join(base, "recent.json"), run: async (f, a, cwd) => calls.push({ f, a, cwd }) });

  assert.deepEqual(launcher.info(), { defaultDir: dirs[0], command: "claude", recent: [] });
  const r = await launcher.launch();
  assert.equal(r.dir, dirs[0], "no folder = the default");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, dirs[0]);
  assert.ok(calls[0].a.includes("claude"), "runs the configured command");
  assert.deepEqual(launcher.info().recent, [], "the default folder is not listed as 'recent'");

  for (const d of dirs.slice(1)) await launcher.launch(d);
  assert.deepEqual(launcher.info().recent, [dirs[6], dirs[5], dirs[4], dirs[3], dirs[2]], "five most recent, newest first");
  await launcher.launch(dirs[4]);
  assert.deepEqual(launcher.info().recent.slice(0, 2), [dirs[4], dirs[6]], "relaunching moves a folder to the front, no duplicate");
  assert.equal(calls.length, 8);

  const fails = async (dir, re) => { await assert.rejects(() => launcher.launch(dir), re); };
  await fails("relative/path", /absolute/);
  await fails(path.join(base, "missing"), /not found/);
  await fails(path.join(base, "recent.json"), /not found/, "a file is not a folder");
  await fails(`${dirs[1]} & calc`, /unsupported characters/);
  await fails(42, /empty/);
  assert.equal(calls.length, 8, "nothing launched for bad input");
  for (const bad of ["relative/path"]) { try { await launcher.launch(bad); } catch (e) { assert.equal(e.status, 400, "client error"); } }

  const failing = createLauncher({ defaultDir: dirs[0], recentFile: path.join(base, "r2.json"), run: async () => { throw new Error("could not start wt.exe"); } });
  await assert.rejects(() => failing.launch(), /could not start/);
  assert.deepEqual(failing.info().recent, [], "a failed launch is not remembered");
  fs.rmSync(base, { recursive: true, force: true });
});

test("spawnDetached: exit 0 or still running = success; non-zero exit or missing program = failure", async () => {
  await assert.doesNotReject(() => spawnDetached(process.execPath, ["-e", "process.exit(0)"], os.tmpdir()));
  await assert.doesNotReject(() => spawnDetached(process.execPath, ["-e", "setTimeout(()=>{}, 2000)"], os.tmpdir(), { settleMs: 200 }), "a terminal that stays open");
  await assert.rejects(() => spawnDetached(process.execPath, ["-e", "process.exit(3)"], os.tmpdir()), /exited with code 3/);
  await assert.rejects(() => spawnDetached("definitely-not-a-program-xyz", [], os.tmpdir()), /could not start/);
});

test("launcher expands ~ and ignores a corrupt recent file", async () => {
  const base = tmp();
  fs.writeFileSync(path.join(base, "recent.json"), "{not json");
  const launcher = createLauncher({ defaultDir: base, recentFile: path.join(base, "recent.json"), run: async () => {} });
  assert.deepEqual(launcher.info().recent, []);
  const r = await launcher.launch("~");
  assert.equal(r.dir, path.resolve(os.homedir()));
  fs.rmSync(base, { recursive: true, force: true });
});
