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
  const bad = (patch, re) => { const c = valid(); Object.assign(c.jira, patch.jira ?? {}); Object.assign(c, { ...patch, jira: c.jira }); assert.throws(() => validateConfig(c, "cfg"), re); };
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
  assert.doesNotThrow(() => validateConfig(valid(), "cfg"));
  const noDone = valid(); noDone.jira.doneJql = "";
  assert.doesNotThrow(() => validateConfig(noDone, "cfg"), "an empty doneJql disables the done search");
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

  const custom = tmpFile(JSON.stringify({ port: 4400, progressDir: "~/notes", jira: { refreshMinutes: 0 } }));
  const c2 = loadConfig({ env: { DAILY_DASHBOARD_PORT: "4555" }, file: custom });
  assert.equal(c2.port, 4555, "env wins over file");
  assert.equal(c2.jira.refreshMinutes, 0);
  assert.ok(path.isAbsolute(c2.progressDir) && !c2.progressDir.startsWith("~"), "~ expanded");

  assert.throws(() => loadConfig({ env: {}, file: tmpFile("{ not json") }), /not valid JSON/);
  assert.throws(() => loadConfig({ env: {}, file: tmpFile("[]") }), /JSON object/);
  assert.throws(() => loadConfig({ env: { DAILY_DASHBOARD_PORT: "abc" }, file: tmpFile() }), /"port"/);
});
