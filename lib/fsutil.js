import fs from "node:fs";
import path from "node:path";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRIES = 6;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);   // synchronous sleep

/**
 * Writes via a temp file + rename, so a crash mid-write never leaves a half-written file.
 * On Windows a rename over a file something else has open for a moment (indexer, antivirus,
 * a reader) fails with EPERM/EBUSY; it is retried briefly (≈ 0.4 s in all) before giving up.
 */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (attempt >= RETRIES || !RETRY_CODES.has(e.code)) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw e;
      }
      pause(20 * (attempt + 1));
    }
  }
}

/** Reads and parses a JSON file; returns `fallback` if it is missing or invalid. */
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
