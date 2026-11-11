import fs from "node:fs";
import path from "node:path";

/** Writes via a temp file + rename, so a crash mid-write never leaves a half-written file. */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Reads and parses a JSON file; returns `fallback` if it is missing or invalid. */
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
