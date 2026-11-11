import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULTS, loadConfig, merge, validateConfig } from "../lib/config.js";

const tmpFile = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-config-"));
  const file = path.join(dir, "config.json");
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
};
const valid = () => structuredClone(DEFAULTS);

test("merge: nested objects merge, scalars replace, unknown keys pass through", () => {
  const out = merge(DEFAULTS, { port: 5000, jira: { mode: "token" }, extra: 1 });
  assert.equal(out.port, 5000);
  assert.equal(out.jira.mode, "token");
  assert.equal(out.jira.site, DEFAULTS.jira.site);
  assert.equal(out.extra, 1);
});

test("merge ignores prototype-polluting keys", () => {
  const user = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"port":4000}');
  const out = merge(DEFAULTS, user);
  assert.equal(out.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.port, 4000);
  assert.equal({}.polluted, undefined, "global prototype untouched");
});

test("validateConfig rejects values that could reach a command line or URL", () => {
  const bad = (patch, re) => {
    const c = valid();
    Object.assign(c.jira, patch.jira ?? {});
    Object.assign(c.claude, patch.claude ?? {});
    Object.assign(c.auto, patch.auto ?? {});
    Object.assign(c, { ...patch, jira: c.jira, claude: c.claude, auto: c.auto });
    assert.throws(() => validateConfig(c, "cfg"), re);
  };
  bad({ port: "4317 & calc" }, /"port"/);
  bad({ port: 70000 }, /"port"/);
  bad({ jira: { claudeModel: "haiku & calc" } }, /claudeModel/);
  bad({ jira: { site: "evil.example/x?y" } }, /jira\.site/);
  bad({ jira: { site: "nodots" } }, /jira\.site/);
  bad({ jira: { mode: "magic" } }, /jira\.mode/);
  bad({ jira: { tokenEnv: "JIRA TOKEN" } }, /tokenEnv/);
  bad({ jira: { refreshMinutes: -1 } }, /refreshMinutes/);
  bad({ githubCacheSeconds: "soon" }, /githubCacheSeconds/);
  bad({ scoreWeeks: 0 }, /scoreWeeks/);
  bad({ scoreWeeks: 2.5 }, /scoreWeeks/);
  bad({ jira: { doneJql: 42 } }, /doneJql/);
  bad({ claude: { defaultDir: "" } }, /claude\.defaultDir/);
  bad({ claude: { command: "claude\nrm -rf" } }, /claude\.command/);
  bad({ claude: { command: "x".repeat(201) } }, /claude\.command/);
  bad({ auto: { intervalMinutes: 1 } }, /auto\.intervalMinutes/);
  bad({ auto: { workHours: "9-17" } }, /auto\.workHours/);
  bad({ auto: { workHours: "18:00-09:00" } }, /auto\.workHours/);
  bad({ auto: { model: "haiku; rm" } }, /auto\.model/);
  bad({ auto: { enabled: "yes" } }, /auto\.enabled/);
  bad({ auto: { useClaude: "yes" } }, /auto\.useClaude/);
  bad({ auto: { saveAt: "5pm" } }, /auto\.saveAt/);
  bad({ auto: { saveAt: "21:00" } }, /inside "auto\.workHours"/);
  bad({ auto: { catchupDays: 30 } }, /auto\.catchupDays/);
  const noSave = valid(); noSave.auto.saveAt = "";
  assert.doesNotThrow(() => validateConfig(noSave, "cfg"), '"" turns the end-of-day save off');
  assert.doesNotThrow(() => validateConfig(valid(), "cfg"));
  const noDone = valid(); noDone.jira.doneJql = "";
  assert.doesNotThrow(() => validateConfig(noDone, "cfg"), "an empty doneJql disables the done search");
});

test("auto.useClaude follows jira.mode unless set explicitly", () => {
  assert.equal(loadConfig({ env: {}, file: tmpFile() }).auto.useClaude, true, "default: Jira via Claude → summaries via Claude");
  assert.equal(loadConfig({ env: {}, file: tmpFile(JSON.stringify({ jira: { mode: "token" } })) }).auto.useClaude, false, "token mode: no Claude call");
  assert.equal(loadConfig({ env: {}, file: tmpFile(JSON.stringify({ jira: { mode: "token" }, auto: { useClaude: true } })) }).auto.useClaude, true);
  assert.equal(loadConfig({ env: {}, file: tmpFile(JSON.stringify({ auto: { useClaude: false } })) }).auto.useClaude, false);
});

test("loadConfig fills {days} in jira.doneJql from scoreWeeks", () => {
  const cfg = loadConfig({ env: {}, file: tmpFile(JSON.stringify({ scoreWeeks: 6 })) });
  assert.match(cfg.jira.doneJql, /statusCategoryChangedDate >= -49d/, "6 weeks + a week of slack");
  assert.doesNotMatch(cfg.jira.doneJql, /\{days\}/);
  assert.equal(loadConfig({ env: {}, file: tmpFile() }).jira.doneJql.includes("-63d"), true, "default 8 weeks");
  assert.match(DEFAULTS.jira.doneJql, /\{days\}/, "the shared defaults were not mutated");
});

test("loadConfig creates defaults, applies the file and env overrides, and validates", () => {
  const fresh = tmpFile();
  const cfg = loadConfig({ env: {}, file: fresh });
  assert.equal(cfg.port, DEFAULTS.port);
  assert.ok(fs.existsSync(fresh), "defaults written");

  const custom = tmpFile(JSON.stringify({ port: 4400, progressDir: "~/notes", jira: { refreshMinutes: 0 }, claude: { defaultDir: "~/work" } }));
  const c2 = loadConfig({ env: { DAILY_DASHBOARD_PORT: "4555" }, file: custom });
  assert.equal(c2.port, 4555, "env wins over file");
  assert.equal(c2.jira.refreshMinutes, 0);
  assert.ok(path.isAbsolute(c2.progressDir) && !c2.progressDir.startsWith("~"), "~ expanded");
  assert.equal(c2.claude.defaultDir, path.join(os.homedir(), "work"), "~ expanded in claude.defaultDir");
  assert.equal(c2.claude.command, "claude");

  assert.throws(() => loadConfig({ env: {}, file: tmpFile("{ not json") }), /not valid JSON/);
  assert.throws(() => loadConfig({ env: {}, file: tmpFile("[]") }), /JSON object/);
  assert.throws(() => loadConfig({ env: { DAILY_DASHBOARD_PORT: "abc" }, file: tmpFile() }), /"port"/);
});
