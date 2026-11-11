import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MAX_ENTRIES, createBlacklist, entryFor, filterNudges, labelOf, matches, normText, refsIn } from "../lib/blacklist.js";

test("refsIn: Jira keys as written, PRs as repo#n in lower case, owner dropped, de-duplicated", () => {
  assert.deepEqual(refsIn("Review DBMS#11 (dbms#11) and acme/Web#3; MAYA-26 waits, MAYA-26 again"), ["dbms#11", "web#3", "MAYA-26"]);
  assert.deepEqual(refsIn("Your week trails last week's score"), []);
  assert.deepEqual(refsIn("PR #11 is not a reference, nor is a-1 or AB-x"), []);
});

test("normText drops case, punctuation and spacing", () => {
  assert.equal(normText("  Your week  trails last week's score!! "), "your week trails last week s score");
});

test("matches: by a named item, or by the wording when nothing is named", () => {
  const byRef = entryFor("dbms#11 has waited 43 days for your review", { date: "2026-11-11", points: [{ index: 0, text: "dbms#11 has waited 43 days for your review" }] });
  assert.deepEqual([byRef.refs, byRef.date, byRef.points.length], [["dbms#11"], "2026-11-11", 1]);
  assert.equal(matches(byRef, "Still no review on acme/DBMS#11 — 44 days"), true, "the item, however it is spelled");
  assert.equal(matches(byRef, "dbms#12 has waited 2 days"), false);
  assert.equal(matches(byRef, "43 days for your review"), false, "an entry with items does not match by wording");
  const byText = entryFor("Your week trails last week's score");
  assert.deepEqual(byText.refs, []);
  assert.equal(matches(byText, "your week trails last week's score."), true);
  assert.equal(matches(byText, "Your week beats last week's score"), false);
  assert.deepEqual(filterNudges(["dbms#11 again", "web#3 waits", "Your week trails last week's score"], [byRef, byText]), ["web#3 waits"]);
  assert.equal(labelOf(byRef), "dbms#11");
  assert.equal(labelOf(byText), '"Your week trails last week\'s score"');
  assert.throws(() => entryFor("   "), /nothing to blacklist/);
  assert.equal(entryFor("x".repeat(500)).text.length, 300, "clipped");
});

test("createBlacklist: persists, de-duplicates, removes, filters, hints; a bad file is an empty list", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-black-"));
  const file = path.join(dir, "blacklist.json");
  const b = createBlacklist(file);
  assert.deepEqual(b.list(), []);
  const { entry: e1, added } = b.add("Review dbms#11 — 43 days", { date: "2026-11-11", points: [{ index: 1, text: "Review dbms#11 — 43 days" }], now: new Date("2026-11-11T10:00:00Z") });
  assert.equal(added, true);
  assert.deepEqual([e1.refs, e1.date, e1.points, e1.at], [["dbms#11"], "2026-11-11", [{ index: 1, text: "Review dbms#11 — 43 days" }], "2026-11-11T10:00:00.000Z"]);
  assert.deepEqual(b.add("dbms#11 still waits"), { entry: e1, added: false }, "already covered: the existing entry comes back, nothing added");
  const { entry: e2 } = b.add("Your week trails last week's score");
  assert.deepEqual(b.list().map((e) => e.id), [e1.id, e2.id]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).entries.map((e) => e.text), ["Review dbms#11 — 43 days", "Your week trails last week's score"]);
  assert.deepEqual(createBlacklist(file).filter(["dbms#11 is old", "web#3 waits", "Your week trails last week's score"]), ["web#3 waits"], "a fresh instance reads the file");
  assert.deepEqual(b.hints(), ["dbms#11", '"Your week trails last week\'s score"']);
  assert.equal(b.remove("nope"), null);
  assert.equal(b.remove(e1.id).id, e1.id);
  assert.deepEqual(b.list().map((e) => e.id), [e2.id]);
  assert.deepEqual(b.filter(["dbms#11 is old"]), ["dbms#11 is old"]);
  // By item or wording, in any spelling the app itself accepts; every covering entry goes.
  const { entry: e3 } = b.add("Review dbms#11 and MAYA-26");
  const { entry: e4 } = b.add("web#3 and acme/dbms#12");
  assert.deepEqual(b.removeMatching("nothing here"), []);
  assert.deepEqual(b.removeMatching("acme/DBMS#11").map((e) => e.id), [e3.id]);
  assert.deepEqual(b.removeMatching("your week trails last week's score!").map((e) => e.id), [e2.id]);
  assert.deepEqual(b.list().map((e) => e.id), [e4.id]);

  // A hand-edited file is picked up by a running instance (mtime changed): entries missing fields are normalized, junk is skipped.
  const seen = b.list().length;
  fs.writeFileSync(file, JSON.stringify({ entries: [{ id: "a", text: "MAYA-26 is slow", points: [{ index: 0, text: "x" }, "junk"] }, { id: "b", refs: ["web#3"] }, "junk", { text: "no id" }] }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(seen, 1);
  const edited = b.list();
  assert.deepEqual(edited.map((e) => [e.id, e.refs, e.text, e.points]), [["a", ["MAYA-26"], "MAYA-26 is slow", [{ index: 0, text: "x" }]], ["b", ["web#3"], "", []]]);
  assert.equal(b.list(), edited, "unchanged file: the same array, no re-read");
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(createBlacklist(file).list(), []);
  fs.rmSync(file);
  assert.deepEqual(createBlacklist(file).list(), [], "no file yet");

  // The list is capped at the newest MAX_ENTRIES.
  const big = createBlacklist(path.join(dir, "big.json"));
  for (let i = 0; i < MAX_ENTRIES + 5; i++) big.add(`REPO-${i} drifted`);
  assert.equal(big.list().length, MAX_ENTRIES);
  assert.equal(big.list()[0].refs[0], "REPO-5");
  fs.rmSync(dir, { recursive: true, force: true });
});
