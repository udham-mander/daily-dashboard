import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { readJson, writeFileAtomic } from "../lib/fsutil.js";

test("writeFileAtomic: temp + rename, retried on a transient Windows EPERM, no temp file left behind on failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-fsutil-"));
  const file = path.join(dir, "sub", "data.json");
  writeFileAtomic(file, '{"a":1}');
  assert.deepEqual(readJson(file), { a: 1 });

  // The first two renames fail the way an indexer/antivirus makes them fail on Windows; the third goes through.
  const real = fs.renameSync;
  let calls = 0;
  const m = mock.method(fs, "renameSync", (...args) => {
    if (++calls <= 2) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    return real(...args);
  });
  writeFileAtomic(file, '{"a":2}');
  assert.equal(calls, 3);
  assert.deepEqual(readJson(file), { a: 2 });
  m.mock.restore();

  // Any other error is not retried, and the temp file is removed.
  const once = mock.method(fs, "renameSync", () => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); });
  assert.throws(() => writeFileAtomic(file, '{"a":3}'), /ENOSPC/);
  assert.equal(once.mock.callCount(), 1);
  once.mock.restore();
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["data.json"], "no .tmp left");
  assert.deepEqual(readJson(file), { a: 2 }, "the previous content is intact");
  fs.rmSync(dir, { recursive: true, force: true });
});
